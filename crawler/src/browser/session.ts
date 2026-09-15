import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { CrawlFailure, ERROR_MESSAGES } from "../errors.js";

/**
 * Playwright 会话管理。
 *
 * 文档第 41 条：浏览器不得默认用于所有 URL，仅在 JavaScript 页面、登录页面、
 * 登录后的内容、SPA，以及 HTTP 模式无法提取内容时启用。
 *
 * 文档第 24 条：不得实现浏览器指纹伪装等规避手段。因此这里只设置正常的语言、
 * 视口等基础参数，不注入 stealth 脚本、不伪造 WebGL/Canvas 指纹、不使用代理。
 */

export interface BrowserSessionOptions {
  /** 浏览器可执行文件路径。为空时由 PLAYWRIGHT_BROWSERS_PATH 决定。 */
  executablePath?: string;
  /** 已保存的登录态文件路径。 */
  storageStatePath?: string;
  /** 单页操作超时。 */
  timeoutMs?: number;
  /** 是否显示浏览器窗口。登录流程必须为 true。 */
  headless?: boolean;
}

export interface RenderOutcome {
  html: string;
  finalUrl: string;
  /** 主文档的 HTTP 状态码，拿不到时为 null。 */
  status: number | null;
}

const DEFAULT_TIMEOUT_MS = 30_000;

/** 登录窗口打开期间保存登录态的间隔。 */
const LOGIN_STATE_SAVE_INTERVAL_MS = 3_000;

export class BrowserSession {
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private readonly options: BrowserSessionOptions;

  constructor(options: BrowserSessionOptions = {}) {
    this.options = options;
  }

  private get timeout(): number {
    return this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  /** 惰性启动浏览器，多个页面复用同一个实例。 */
  private async ensureContext(): Promise<BrowserContext> {
    if (this.context) return this.context;

    try {
      this.browser = await chromium.launch({
        headless: this.options.headless ?? true,
        ...(this.options.executablePath ? { executablePath: this.options.executablePath } : {}),
        args: ["--disable-dev-shm-usage"],
      });
    } catch (error) {
      throw new CrawlFailure(
        "PageRenderFailed",
        ERROR_MESSAGES.PageRenderFailed,
        `浏览器启动失败：${error instanceof Error ? error.message : String(error)}`,
      );
    }

    try {
      this.context = await this.browser.newContext({
        locale: "zh-CN",
        viewport: { width: 1280, height: 900 },
        ...(this.options.storageStatePath
          ? { storageState: this.options.storageStatePath }
          : {}),
      });
    } catch (error) {
      await this.close();
      throw new CrawlFailure(
        "PageRenderFailed",
        ERROR_MESSAGES.PageRenderFailed,
        `浏览器上下文创建失败：${error instanceof Error ? error.message : String(error)}`,
      );
    }

    return this.context;
  }

  /**
   * 渲染页面并返回完整 DOM。
   *
   * 使用 `networkidle` 等待策略，但设置了上限，避免长轮询页面永久阻塞。
   */
  async render(url: string): Promise<RenderOutcome> {
    const context = await this.ensureContext();
    const page = await context.newPage();

    try {
      page.setDefaultTimeout(this.timeout);
      page.setDefaultNavigationTimeout(this.timeout);

      const response = await page.goto(url, {
        waitUntil: "domcontentloaded",
        timeout: this.timeout,
      });

      await settle(page);

      return {
        html: await page.content(),
        finalUrl: page.url(),
        status: response?.status() ?? null,
      };
    } catch (error) {
      throw new CrawlFailure(
        "PageRenderFailed",
        ERROR_MESSAGES.PageRenderFailed,
        error instanceof Error ? error.message : String(error),
      );
    } finally {
      await page.close().catch(() => {});
    }
  }

  /**
   * 将 HTML 渲染为 PDF。
   *
   * 文档第 14 条要求 PDF 尽量保留标题、段落、图片、表格、代码、页面结构与
   * 中文字符。这里使用 Chromium 自身的打印引擎，保真度最高。
   */
  async htmlToPdf(html: string): Promise<Uint8Array> {
    const context = await this.ensureContext();
    const page = await context.newPage();

    try {
      page.setDefaultTimeout(this.timeout);
      await page.setContent(html, { waitUntil: "load", timeout: this.timeout });

      // 等待图片加载完成，避免 PDF 中出现空白图位
      await page
        .evaluate(async () => {
          const images = Array.from(document.images);
          await Promise.all(
            images.map((img) =>
              img.complete
                ? Promise.resolve()
                : new Promise<void>((resolve) => {
                    img.addEventListener("load", () => resolve(), { once: true });
                    img.addEventListener("error", () => resolve(), { once: true });
                  }),
            ),
          );
        })
        .catch(() => {});

      const buffer = await page.pdf({
        format: "A4",
        printBackground: true,
        preferCSSPageSize: false,
        margin: { top: "18mm", right: "16mm", bottom: "18mm", left: "16mm" },
      });

      return new Uint8Array(buffer);
    } catch (error) {
      throw new CrawlFailure(
        "PDFConversionFailed",
        ERROR_MESSAGES.PDFConversionFailed,
        error instanceof Error ? error.message : String(error),
      );
    } finally {
      await page.close().catch(() => {});
    }
  }

  /** 从已渲染的页面直接打印为 PDF，避免重复导航。 */
  async pageToPdf(url: string): Promise<Uint8Array> {
    const context = await this.ensureContext();
    const page = await context.newPage();

    try {
      page.setDefaultTimeout(this.timeout);
      page.setDefaultNavigationTimeout(this.timeout);
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: this.timeout });
      await settle(page);

      const buffer = await page.pdf({
        format: "A4",
        printBackground: true,
        margin: { top: "18mm", right: "16mm", bottom: "18mm", left: "16mm" },
      });
      return new Uint8Array(buffer);
    } catch (error) {
      throw new CrawlFailure(
        "PDFConversionFailed",
        ERROR_MESSAGES.PDFConversionFailed,
        error instanceof Error ? error.message : String(error),
      );
    } finally {
      await page.close().catch(() => {});
    }
  }

  /**
   * 打开有头浏览器供用户自行登录，并持续保存登录态。
   *
   * 文档第 29 条：程序不得自动读取或保存用户明文密码，不得破解验证码、
   * 绕过 MFA/CAPTCHA 或网站登录限制。此处只负责打开窗口与保存会话状态，
   * 账号、密码、验证码全部由用户自行输入。
   *
   * 文档第 28 条的流程：用户主动登录 → 保存登录态 → 后续复用登录态。
   *
   * @param startUrl 登录页地址
   * @param storageStatePath 登录态保存路径
   * @returns 用户关闭浏览器时 resolve；期间至少成功保存过一次则返回 true
   */
  async openLoginWindow(startUrl: string, storageStatePath: string): Promise<boolean> {
    let browser: Browser;
    try {
      browser = await chromium.launch({
        headless: false,
        ...(this.options.executablePath ? { executablePath: this.options.executablePath } : {}),
      });
    } catch (error) {
      throw new CrawlFailure(
        "PageRenderFailed",
        ERROR_MESSAGES.PageRenderFailed,
        `无法打开登录窗口：${error instanceof Error ? error.message : String(error)}`,
      );
    }

    const context = await browser.newContext({
      locale: "zh-CN",
      viewport: { width: 1280, height: 900 },
    });

    const page = await context.newPage();
    await page.goto(startUrl, { waitUntil: "domcontentloaded" }).catch(() => {});

    let savedOnce = false;
    const timer = setInterval(() => {
      void context
        .storageState({ path: storageStatePath })
        .then(() => {
          savedOnce = true;
        })
        .catch(() => {});
    }, LOGIN_STATE_SAVE_INTERVAL_MS);

    await new Promise<void>((resolve) => {
      browser.on("disconnected", () => resolve());
    });

    clearInterval(timer);

    // 关闭前做最后一次保存
    try {
      await context.storageState({ path: storageStatePath });
      savedOnce = true;
    } catch {
      // 浏览器已断开时保存会失败，此时以最后一次周期性保存为准
    }

    await browser.close().catch(() => {});
    return savedOnce;
  }

  async close(): Promise<void> {
    const browser = this.browser;
    this.browser = null;
    this.context = null;
    if (browser) {
      await browser.close().catch(() => {});
    }
  }
}

/**
 * 等待页面趋于稳定。
 *
 * 不直接使用 `networkidle`——长轮询与埋点请求会让它永不触发。
 * 改为等待网络空闲并设置上限，超时即继续。
 */
async function settle(page: Page): Promise<void> {
  await page
    .waitForLoadState("networkidle", { timeout: 5_000 })
    .catch(() => {});
  await page.waitForTimeout(300).catch(() => {});
}
