import { createInterface } from "node:readline";
import { cookieHeaderFor, loadCookies, type StoredCookie } from "./auth.js";
import { BrowserSession } from "./browser/session.js";
import { RobotsCache } from "./domain/robots.js";
import { CrawlFailure, toCrawlFailure } from "./errors.js";
import { markdownToPdf } from "./pdf/generate.js";
import {
  decode,
  encode,
  type CrawlOptions,
  type CrawlTarget,
  type OutboundMessage,
  type TaskState,
} from "./protocol.js";
import { findNextPage } from "./task/pagination.js";
import { crawlPage, type PageOutcome } from "./task/pipeline.js";
import { MAX_CONCURRENT_SITES, MIN_SAME_SITE_DELAY_MS, runGrouped } from "./task/scheduler.js";

/**
 * crawler sidecar 主进程。
 *
 * 通过 stdin/stdout 与 Tauri 的 Rust 侧交换 NDJSON 消息。
 * **stdout 专用于协议通信**，任何调试输出都必须走 stderr 或 `log` 消息类型。
 */

function emit(message: OutboundMessage): void {
  process.stdout.write(encode(message));
}

function log(level: "info" | "warn" | "error", message: string): void {
  emit({ type: "log", level, message });
}

/** 与 Rust 侧 `url.rs::normalize` 保持一致的口径，用于去重与同站判断。 */
function normalizeUrl(raw: string): string {
  try {
    const url = new URL(raw);
    let out = `${url.protocol}//${url.hostname}`;
    if (url.port) out += `:${url.port}`;
    const path = url.pathname === "/" ? "" : url.pathname.replace(/\/$/, "");
    out += path;
    if (url.search) out += url.search;
    if (url.hash) out += url.hash;
    return out;
  } catch {
    return raw;
  }
}

/** 判断候选地址是否与给定注册域同站。 */
function isSameSiteAs(candidate: string, siteKey: string): boolean {
  if (!siteKey) return false;
  try {
    const host = new URL(candidate).hostname.toLowerCase();
    const key = siteKey.toLowerCase();
    return host === key || host.endsWith(`.${key}`);
  } catch {
    return false;
  }
}

class Crawler {
  /**
   * 浏览器会话按需创建——浏览器路径由 Rust 侧解析后随命令下发，
   * 进程启动时无从得知。
   */
  private browser: BrowserSession | null = null;
  private readonly robots = new RobotsCache();
  private cookies: StoredCookie[] = [];
  private busy = false;

  private getBrowser(browserPath?: string): BrowserSession {
    this.browser ??= new BrowserSession(
      browserPath ? { executablePath: browserPath } : {},
    );
    return this.browser;
  }

  async refreshCookies(authDir: string): Promise<void> {
    this.cookies = await loadCookies(authDir);
  }

  async handleCrawl(
    targets: CrawlTarget[],
    options: CrawlOptions,
    authDir: string,
    stagingDir: string,
    browserPath?: string,
  ): Promise<void> {
    if (this.busy) {
      log("warn", "已有任务正在执行，忽略本次请求");
      return;
    }
    this.busy = true;

    try {
      await this.refreshCookies(authDir);

      const browser = this.getBrowser(browserPath);
      const imageDir = `${stagingDir}/assets`;
      const groups = new Map<string, CrawlTarget[]>();
      for (const target of targets) {
        const list = groups.get(target.siteKey) ?? [];
        list.push(target);
        groups.set(target.siteKey, list);
      }

      let succeeded = 0;
      let failed = 0;
      const skipped = 0;

      await runGrouped(
        [...groups.entries()].map(([site, items]) => ({ site, items })),
        {
          maxConcurrentSites: MAX_CONCURRENT_SITES,
          minDelayMs: MIN_SAME_SITE_DELAY_MS,
          onItem: async (target) => {
            const outcome = await this.crawlTarget(
              target,
              options,
              browser,
              imageDir,
            );
            if (outcome === "ok") succeeded += 1;
            else if (outcome === "fail") failed += 1;
          },
        },
      );

      emit({ type: "done", succeeded, failed, skipped });
    } finally {
      this.busy = false;
      await this.browser?.close();
      this.browser = null;
    }
  }

  /**
   * 抓取单个目标，并按其设置决定是否自动续页。
   *
   * 文档第 22 条：自动续页必须受上限、去重、同站范围与错误次数限制约束；
   * 无法可靠判断下一页时停止并提示，不得猜测。
   */
  private async crawlTarget(
    target: CrawlTarget,
    options: CrawlOptions,
    browser: BrowserSession,
    imageDir: string,
  ): Promise<"ok" | "fail" | "skip"> {
    const visited = new Set<string>([normalizeUrl(target.raw)]);
    const maxPages = options.followPagination
      ? Math.max(1, Math.min(options.maxPagination, 5))
      : 1;

    let currentUrl = target.raw;
    let sequence = 0;

    while (currentUrl && sequence < maxPages) {
      const cookieHeader = cookieHeaderFor(this.cookies, currentUrl);

      let page: PageOutcome;
      try {
        page = await crawlPage(currentUrl, {
          options,
          robots: this.robots,
          browser,
          imageDir,
          userSpecified: sequence === 0,
          ...(cookieHeader ? { cookieHeader } : {}),
          onProgress: (state, step, progress) => {
            emit({
              type: "progress",
              key: target.key,
              url: currentUrl,
              state,
              step,
              progress,
            });
          },
        });
      } catch (error) {
        const failure = toCrawlFailure(error);
        emit({
          type: "error",
          key: target.key,
          url: currentUrl,
          errorKind: failure.kind,
          message: failure.message,
          ...(failure.detail ? { detail: failure.detail } : {}),
        });
        // 首页失败计为失败；续页失败时首页结果已产出，整体仍算成功
        return sequence === 0 ? "fail" : "ok";
      }

      emit({
        type: "progress",
        key: target.key,
        url: page.url,
        state: "Completed" satisfies TaskState,
        step: "已完成",
        progress: 1,
      });

      emit({
        type: "result",
        key: target.key,
        url: page.url,
        title: page.title,
        markdown: page.markdown,
        crawledAt: page.crawledAt,
        rendered: page.rendered,
        sequence,
      });

      sequence += 1;

      if (!options.followPagination || sequence >= maxPages) break;

      const next = findNextPage(page.html, page.url, {
        visited,
        isSameSite: (candidate) => isSameSiteAs(candidate, target.siteKey),
        normalize: normalizeUrl,
      });

      if (!next) break;

      visited.add(normalizeUrl(next.url));
      currentUrl = next.url;

      emit({
        type: "progress",
        key: target.key,
        url: currentUrl,
        state: "Pending",
        step: `自动续页（第 ${sequence + 1} 页，依据：${next.evidence}）`,
        progress: 0,
      });
    }

    return "ok";
  }

  /** 打开有头浏览器供用户自行登录，并保存登录态。 */
  async handleLogin(
    domain: string,
    startUrl: string,
    authDir: string,
    browserPath?: string,
  ): Promise<void> {
    const storageStatePath = `${authDir}/${domain}.json`;

    try {
      emit({ type: "login-opened", domain });
      // 登录必须使用独立的、有头的会话，不与抓取会话共用
      const session = new BrowserSession({
        headless: false,
        ...(browserPath ? { executablePath: browserPath } : {}),
      });
      const saved = await session.openLoginWindow(startUrl, storageStatePath);
      emit({ type: "login-closed", domain, saved });
      if (saved) {
        await this.refreshCookies(authDir);
        emit({ type: "login-saved", domain });
      }
    } catch (error) {
      const failure = toCrawlFailure(error);
      log("error", `登录窗口处理失败：${failure.message}`);
      emit({ type: "login-closed", domain, saved: false });
    }
  }

  /** 将 Rust 组装好的 Markdown 文档渲染为 PDF。 */
  async handleRenderPdf(
    id: string,
    markdown: string,
    title: string,
    browserPath?: string,
  ): Promise<void> {
    try {
      const bytes = await markdownToPdf(markdown, title, this.getBrowser(browserPath));
      emit({
        type: "pdf",
        id,
        pdfBase64: Buffer.from(bytes).toString("base64"),
      });
    } catch (error) {
      const failure = toCrawlFailure(error);
      emit({
        type: "pdf-error",
        id,
        message: failure.message,
        ...(failure.detail ? { detail: failure.detail } : {}),
      });
    }
  }

  async shutdown(): Promise<void> {
    await this.browser?.close();
    this.browser = null;
  }
}

async function main(): Promise<void> {
  const crawler = new Crawler();
  emit({ type: "ready" });

  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });

  // 串行处理命令，避免并发修改共享状态
  let queue: Promise<void> = Promise.resolve();

  const enqueue = (task: () => Promise<void>): void => {
    queue = queue.then(task).catch((error: unknown) => {
      const failure = toCrawlFailure(error);
      log("error", `命令处理失败：${failure.message}`);
    });
  };

  rl.on("line", (line) => {
    const message = decode(line);
    if (!message) return;

    switch (message.cmd) {
      case "crawl":
        enqueue(() =>
          crawler.handleCrawl(
            message.targets,
            message.options,
            message.authDir,
            message.stagingDir,
            message.browserPath,
          ),
        );
        break;
      case "login":
        enqueue(() =>
          crawler.handleLogin(
            message.domain,
            message.startUrl,
            message.authDir,
            message.browserPath,
          ),
        );
        break;
      case "render-pdf":
        enqueue(() =>
          crawler.handleRenderPdf(
            message.id,
            message.markdown,
            message.title,
            message.browserPath,
          ),
        );
        break;
      case "ping":
        enqueue(async () => {
          emit({ type: "ready" });
        });
        break;
      case "shutdown":
        void crawler.shutdown().finally(() => process.exit(0));
        break;
    }
  });

  rl.on("close", () => {
    void crawler.shutdown().finally(() => process.exit(0));
  });
}

main().catch((error: unknown) => {
  const failure = error instanceof CrawlFailure ? error : toCrawlFailure(error);
  process.stderr.write(`crawler 启动失败：${failure.message}\n`);
  process.exit(1);
});
