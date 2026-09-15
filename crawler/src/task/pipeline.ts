import { BrowserSession } from "../browser/session.js";
import { detectDefense, looksLikeClientRendered } from "../domain/defense.js";
import type { RobotsCache } from "../domain/robots.js";
import { CrawlFailure, ERROR_MESSAGES, toCrawlFailure } from "../errors.js";
import {
  extractContent,
  isContentSufficient,
  type ExtractedContent,
} from "../extractor/readability.js";
import { fetchPage } from "../http/fetch.js";
import { DEFAULT_ASSETS_PLACEHOLDER, toMarkdown } from "../markdown/convert.js";
import { createImageDownloader } from "../markdown/images.js";
import type { CrawlOptions, TaskState } from "../protocol.js";
import { MAX_RETRIES, backoffDelay, defaultSleep, isRetryable } from "./scheduler.js";

/**
 * 单个 URL 的抓取管线。
 *
 * 对应文档第 39 条的任务生命周期中「HTTP Fetch → 必要时 Browser Render →
 * 防护检测 → 正文提取 → Markdown」这一段。
 */

export interface PipelineContext {
  options: CrawlOptions;
  robots: RobotsCache;
  browser: BrowserSession;
  /** 图片暂存目录（`local` 策略下使用）。 */
  imageDir: string;
  /** 已保存的登录态 Cookie。 */
  cookieHeader?: string;
  /** 该 URL 是否由用户显式指定——决定 robots.txt 是否豁免。 */
  userSpecified: boolean;
  onProgress?: (state: TaskState, step: string, progress: number) => void;
  sleep?: (ms: number) => Promise<void>;
}

export interface PageOutcome {
  url: string;
  title: string;
  /** 正文 Markdown，不含标题与元数据块。 */
  markdown: string;
  /** 页面 HTML，供 PDF 生成与多页发现复用。 */
  html: string;
  crawledAt: string;
  /** 是否由 Playwright 渲染得到。 */
  rendered: boolean;
}

type ProgressFn = NonNullable<PipelineContext["onProgress"]>;

/**
 * 抓取单个页面。
 *
 * 文档第 40 条 HTTP First：普通页面走 HTTP；只有失败、正文不足、需要 JS 或
 * 需要登录时，才启用 Playwright。
 */
export async function crawlPage(url: string, ctx: PipelineContext): Promise<PageOutcome> {
  const report = ctx.onProgress ?? (() => {});
  const sleep = ctx.sleep ?? defaultSleep;
  const crawledAt = timestamp();

  // --- robots.txt ---
  const decision = await ctx.robots.check(url, ctx.userSpecified);
  if (!decision.allowed) {
    throw new CrawlFailure("AccessDenied", ERROR_MESSAGES.AccessDenied, decision.reason ?? undefined);
  }
  if (decision.crawlDelaySeconds) {
    await sleep(decision.crawlDelaySeconds * 1000);
  }

  // --- HTTP First ---
  report("Fetching", "正在获取页面", 0.15);
  const http = await fetchWithRetry(url, ctx, report);

  // --- 防护检测 ---
  const defense = detectDefense(http.status, http.body, http.headers);
  if (defense) {
    throw new CrawlFailure(defense.kind, defense.message, defense.evidence);
  }

  if (http.status >= 400) {
    throw new CrawlFailure("HTTPError", ERROR_MESSAGES.HTTPError, `HTTP ${http.status}`);
  }

  // --- 正文提取 ---
  report("Extracting", "正在提取正文", 0.45);
  let extracted = extractContent(http.body, http.finalUrl);
  let html = http.body;
  let finalUrl = http.finalUrl;
  let rendered = false;

  // --- 必要时启用浏览器 ---
  if (!isContentSufficient(extracted) || looksLikeClientRendered(http.body, extracted?.textContent ?? "")) {
    report("Rendering", "HTTP 正文不足，正在使用浏览器渲染", 0.6);

    try {
      const renderedPage = await ctx.browser.render(finalUrl);
      html = renderedPage.html;
      finalUrl = renderedPage.finalUrl;

      // 渲染后的页面同样要过一遍防护检测
      const renderedDefense = detectDefense(renderedPage.status ?? 200, html);
      if (renderedDefense) {
        throw new CrawlFailure(renderedDefense.kind, renderedDefense.message, renderedDefense.evidence);
      }

      const renderedExtracted = extractContent(html, finalUrl);
      if (renderedExtracted) {
        extracted = renderedExtracted;
        rendered = true;
      }
    } catch (error) {
      if (error instanceof CrawlFailure && error.kind !== "PageRenderFailed") {
        throw error;
      }
      // 浏览器渲染失败但 HTTP 已有部分正文时，降级使用 HTTP 结果
      if (!isContentSufficient(extracted)) {
        throw error instanceof CrawlFailure
          ? error
          : new CrawlFailure("PageRenderFailed", ERROR_MESSAGES.PageRenderFailed);
      }
    }
  }

  if (!isContentSufficient(extracted)) {
    throw new CrawlFailure(
      "ContentExtractionFailed",
      ERROR_MESSAGES.ContentExtractionFailed,
      `提取到的正文仅 ${extracted?.textContent.length ?? 0} 字符`,
    );
  }

  const content = extracted as ExtractedContent;

  // --- Markdown ---
  report("Converting", "正在转换为 Markdown", 0.8);
  const markdown = await convertToMarkdown(content, finalUrl, ctx);

  report("Converting", "转换完成", 0.9);

  return {
    url: finalUrl,
    title: resolveTitle(content, finalUrl),
    markdown,
    html,
    crawledAt,
    rendered,
  };
}

/** 带指数退避的 HTTP 抓取。 */
async function fetchWithRetry(
  url: string,
  ctx: PipelineContext,
  report: ProgressFn,
): Promise<Awaited<ReturnType<typeof fetchPage>>> {
  const sleep = ctx.sleep ?? defaultSleep;
  let attempt = 0;

  for (;;) {
    attempt += 1;

    try {
      const outcome = await fetchPage(url, {
        ...(ctx.cookieHeader ? { cookieHeader: ctx.cookieHeader } : {}),
      });

      // 429 属于「降频后可再试」，但仍受最大次数约束；
      // 其余防御机制不在此重试，交由上层停止并交还用户
      if (outcome.status === 429) {
        if (attempt >= MAX_RETRIES) {
          const defense = detectDefense(outcome.status, outcome.body, outcome.headers);
          throw new CrawlFailure(
            "RateLimited",
            defense?.message ?? ERROR_MESSAGES.RateLimited,
            defense?.evidence ?? "HTTP 429",
          );
        }
        const wait = backoffDelay(attempt);
        report("Fetching", `已被限流，${Math.round(wait / 1000)} 秒后重试（第 ${attempt} 次）`, 0.2);
        await sleep(wait);
        continue;
      }

      return outcome;
    } catch (error) {
      const failure = toCrawlFailure(error);

      if (!isRetryable(failure.kind) || attempt >= MAX_RETRIES) {
        throw failure;
      }

      const wait = backoffDelay(attempt);
      report("Fetching", `${failure.message}，${Math.round(wait / 1000)} 秒后重试（第 ${attempt} 次）`, 0.2);
      await sleep(wait);
    }
  }
}

async function convertToMarkdown(
  content: ExtractedContent,
  url: string,
  ctx: PipelineContext,
): Promise<string> {
  // 仅在「需要 Markdown 输出」且「图片策略为 local」时才下载图片：
  // 纯 PDF 输出不产生 Markdown 文件，本地化图片没有意义。
  const needsLocalImages =
    ctx.options.imageStrategy === "local" && ctx.options.format !== "pdf";

  const downloadImage = needsLocalImages
    ? createImageDownloader({
        dir: ctx.imageDir,
        ...(ctx.cookieHeader ? { cookieHeader: ctx.cookieHeader } : {}),
      })
    : undefined;

  try {
    return await toMarkdown(content.contentHtml, url, {
      imageStrategy: needsLocalImages ? "local" : "remote",
      assetsPlaceholder: DEFAULT_ASSETS_PLACEHOLDER,
      ...(downloadImage ? { downloadImage } : {}),
    });
  } catch (error) {
    throw new CrawlFailure(
      "MarkdownConversionFailed",
      ERROR_MESSAGES.MarkdownConversionFailed,
      error instanceof Error ? error.message : String(error),
    );
  }
}

function resolveTitle(content: ExtractedContent, url: string): string {
  const candidates = [content.title, content.documentTitle];
  for (const candidate of candidates) {
    const trimmed = candidate.trim();
    if (trimmed) return trimmed;
  }
  try {
    return new URL(url).pathname.split("/").filter(Boolean).pop() ?? "";
  } catch {
    return "";
  }
}

export function timestamp(): string {
  const now = new Date();
  const pad = (n: number): string => String(n).padStart(2, "0");
  return (
    `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ` +
    `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`
  );
}
