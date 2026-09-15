/**
 * 与 Rust 侧共享的类型定义。
 *
 * 序列化格式统一为 camelCase，与 `src-tauri/src/protocol.rs`、
 * `src-tauri/src/commands.rs` 的 serde 配置一致。
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

/** 图片保存策略（文档第 34 条，经作者确认为两者同时支持）。 */
export type ImageStrategy = "remote" | "local";

export interface UrlEntry {
  raw: string;
  key: string;
}

export interface DuplicateEntry {
  raw: string;
  duplicateOf: number;
}

/** `validate_urls` 的返回。 */
export interface UrlValidation {
  accepted: UrlEntry[];
  duplicates: DuplicateEntry[];
  error: string | null;
}

/** `environment_status` 的返回。 */
export interface EnvironmentStatus {
  ready: boolean;
  browserAvailable: boolean;
  nodePath: string;
  crawlerPath: string;
  problem: string | null;
}

export interface CrawlRequest {
  urls: string[];
  format: OutputFormat;
  imageStrategy: ImageStrategy;
  followPagination: boolean;
  maxPagination: number;
  separateOutput: boolean;
  obeyRobots: boolean;
  saveDir: string;
}

export interface StartOutcome {
  total: number;
  duplicates: number;
}

/** 任务表格中的一行。 */
export interface TaskRow {
  key: string;
  url: string;
  title: string;
  state: TaskState;
  stateLabel: string;
  step: string;
  progress: number;
  errorKind: CrawlErrorKind | null;
  errorMessage: string | null;
  errorDetail: string | null;
  /** 是否命中网站防御机制。 */
  isDefense: boolean;
  outputFiles: string[];
}

/** `crawler://progress` 事件负载。 */
export interface ProgressPayload {
  key: string;
  url: string;
  state: TaskState;
  stateLabel: string;
  step: string;
  progress: number;
}

/** `crawler://error` 事件负载。 */
export interface ErrorPayload {
  key: string;
  url: string;
  errorKind: CrawlErrorKind;
  message: string;
  detail: string | null;
  isDefense: boolean;
}

/** `crawler://finished` 事件负载。 */
export interface FinishedPayload {
  outputs: Array<{
    key: string;
    title: string;
    markdownPath: string | null;
    pdfPath: string | null;
  }>;
  failures: Array<{
    key: string;
    url: string;
    errorKind: CrawlErrorKind;
    message: string;
    detail: string | null;
    isDefense: boolean;
  }>;
  pdfs: Array<[string, string]>;
}

/** 文档第 16 条：一次任务最多 10 个 URL。 */
export const MAX_URLS = 10;

/** 文档第 22 条：自动续页上限。 */
export const MAX_PAGINATION = 5;

/** 状态的中文说明，用于兜底展示。 */
export const STATE_LABELS: Record<TaskState, string> = {
  Pending: "等待中",
  Fetching: "获取页面",
  Rendering: "浏览器渲染",
  Extracting: "提取正文",
  Converting: "转换格式",
  Saving: "保存文件",
  Completed: "已完成",
  Skipped: "已跳过",
  Failed: "失败",
  Blocked: "被阻止",
  RequiresLogin: "需要登录",
};

/** 错误类型的中文说明。 */
export const ERROR_LABELS: Record<CrawlErrorKind, string> = {
  InvalidURL: "URL 格式不合法",
  NetworkError: "网络请求失败",
  Timeout: "请求超时",
  HTTPError: "服务器返回错误状态码",
  AccessDenied: "访问被拒绝",
  RateLimited: "请求过于频繁，已被限流",
  CaptchaDetected: "检测到验证码，需用户手动处理",
  ChallengeDetected: "检测到访问验证（Challenge），需用户手动处理",
  LoginRequired: "该页面需要登录",
  PageRenderFailed: "页面渲染失败",
  ContentExtractionFailed: "无法提取正文内容",
  MarkdownConversionFailed: "转换为 Markdown 失败",
  PDFConversionFailed: "生成 PDF 失败",
  SaveFailed: "保存文件失败",
  DuplicateURL: "重复 URL，已跳过",
};
