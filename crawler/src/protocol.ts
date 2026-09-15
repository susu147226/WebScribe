/**
 * Rust 与 crawler 之间的 NDJSON IPC 协议。
 *
 * 两个方向的每一条消息都是一个单行 JSON 对象。Rust 侧的同名类型定义位于
 * `src-tauri/src/sidecar.rs`，修改此处时必须同步修改。
 */

/** 文档第 36 条规定的任务状态。 */
export type TaskState =
  | "Pending"
  | "Fetching"
  | "Rendering"
  | "Extracting"
  | "Converting"
  | "Saving"
  | "Completed"
  | "Skipped"
  | "Failed"
  | "Blocked"
  | "RequiresLogin";

/** 文档第 37 条规定的错误类型。 */
export type CrawlErrorKind =
  | "InvalidURL"
  | "NetworkError"
  | "Timeout"
  | "HTTPError"
  | "AccessDenied"
  | "RateLimited"
  | "CaptchaDetected"
  | "ChallengeDetected"
  | "LoginRequired"
  | "PageRenderFailed"
  | "ContentExtractionFailed"
  | "MarkdownConversionFailed"
  | "PDFConversionFailed"
  | "SaveFailed"
  | "DuplicateURL";

/** 文档第 32 条规定的输出格式，默认 Markdown。 */
export type OutputFormat = "markdown" | "pdf" | "both";

/**
 * 图片保存策略（文档第 34 条，经作者确认为两者同时支持，由 UI 开关控制）。
 *
 * - `remote`：Markdown 中保留远程图片 URL
 * - `local`：图片下载到本地，Markdown 使用相对路径引用
 */
export type ImageStrategy = "remote" | "local";

export interface CrawlOptions {
  /** 输出格式。 */
  format: OutputFormat;
  /** 图片保存策略。 */
  imageStrategy: ImageStrategy;
  /**
   * 是否启用多页自动续页。文档第 22 条：默认关闭，上限 5 页，
   * 无法可靠判断下一页时应停止并提示，不得猜测。
   */
  followPagination: boolean;
  /** 自动续页上限。 */
  maxPagination: number;
  /**
   * 是否将同一内容集合的各页输出为独立文件。
   * 文档第 21 条：默认接续为单文件，仅在用户选择时独立输出。
   */
  separateOutput: boolean;
  /** 是否遵循 robots.txt。用户显式输入的 URL 始终豁免。 */
  obeyRobots: boolean;
}

export const DEFAULT_CRAWL_OPTIONS: CrawlOptions = {
  format: "markdown",
  imageStrategy: "remote",
  followPagination: false,
  maxPagination: 5,
  separateOutput: false,
  obeyRobots: true,
};

/** 一个待抓取条目。`raw` 用于实际请求，`key` 仅用于查重。 */
export interface CrawlTarget {
  raw: string;
  key: string;
  /**
   * 注册域（eTLD+1），由 Rust 侧用 PSL 计算后下发。
   *
   * 多页发现的「同站范围限制」以此为基准，避免在 Node 侧重复实现一遍
   * 公共后缀列表逻辑，也保证两端的站点判定口径完全一致。
   */
  siteKey: string;
}

/** 一条抓取结果。 */
export interface PageResult {
  /** 与请求中的 `key` 对应，供 Rust 侧关联任务。 */
  key: string;
  /** 实际抓取的 URL。 */
  url: string;
  title: string;
  /** 正文 Markdown，不含标题与元数据块。 */
  markdown: string;
  /** 完成抓取的时间戳，格式 `YYYY-MM-DD HH:mm:ss`。 */
  crawledAt: string;
  /** 该页面是否由 Playwright 渲染得到（用于向用户说明耗时来源）。 */
  rendered: boolean;
  /** 多页接续中，同属一个内容集合的页面按此序号排列。 */
  sequence: number;
}

/** crawler → Rust 的消息。 */
export type OutboundMessage =
  | { type: "ready" }
  | {
      type: "progress";
      key: string;
      url: string;
      state: TaskState;
      step: string;
      progress: number;
    }
  | {
      type: "result";
      key: string;
      url: string;
      title: string;
      markdown: string;
      crawledAt: string;
      rendered: boolean;
      sequence: number;
    }
  | {
      /** 对 `render-pdf` 的应答。 */
      type: "pdf";
      id: string;
      /** base64 编码的 PDF 字节。 */
      pdfBase64: string;
    }
  | {
      /** 对 `render-pdf` 的失败应答。 */
      type: "pdf-error";
      id: string;
      message: string;
      detail?: string;
    }
  | {
      type: "error";
      key: string;
      url: string;
      errorKind: CrawlErrorKind;
      message: string;
      detail?: string;
    }
  | { type: "skipped"; key: string; url: string; reason: string }
  | { type: "done"; succeeded: number; failed: number; skipped: number }
  | { type: "log"; level: "info" | "warn" | "error"; message: string }
  | { type: "login-opened"; domain: string }
  | { type: "login-saved"; domain: string }
  | { type: "login-closed"; domain: string; saved: boolean };

/** Rust → crawler 的消息。 */
export type InboundMessage =
  | {
      cmd: "crawl";
      targets: CrawlTarget[];
      options: CrawlOptions;
      /** 登录态目录，由 Rust 解析后下发。 */
      authDir: string;
      /**
       * 图片暂存目录。`local` 图片策略下，下载的图片先写入此处，
       * 待 Rust 决定最终文档名后再搬运到用户选择的保存位置。
       */
      stagingDir: string;
      /** Playwright 浏览器可执行文件路径。 */
      browserPath?: string;
    }
  | { cmd: "login"; domain: string; startUrl: string; authDir: string; browserPath?: string }
  | {
      /**
       * 将已组装好的 Markdown 文档渲染为 PDF。
       *
       * 文档组装（含多页接续与元数据块）由 Rust 侧完成，crawler 只负责
       * Markdown → HTML → PDF 的渲染，保证 PDF 与 Markdown 内容一致。
       */
      cmd: "render-pdf";
      id: string;
      markdown: string;
      title: string;
      browserPath?: string;
    }
  | { cmd: "ping" }
  | { cmd: "shutdown" };

/** 单行 JSON 编解码。 */
export function encode(msg: OutboundMessage): string {
  return JSON.stringify(msg) + "\n";
}

export function decode(line: string): InboundMessage | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed) as InboundMessage;
  } catch {
    return null;
  }
}
