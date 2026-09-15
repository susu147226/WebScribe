import type { CrawlErrorKind } from "./protocol.js";

/** 抓取过程中抛出的、可归一为文档第 37 条错误类型的问题。 */
export class CrawlFailure extends Error {
  readonly kind: CrawlErrorKind;
  readonly detail?: string;

  constructor(kind: CrawlErrorKind, message: string, detail?: string) {
    super(message);
    this.name = "CrawlFailure";
    this.kind = kind;
    if (detail !== undefined) this.detail = detail;
  }
}

/** 面向用户的中文说明，与 Rust 侧 `CrawlErrorKind::message` 保持一致。 */
export const ERROR_MESSAGES: Record<CrawlErrorKind, string> = {
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

/**
 * 文档第 24、26 条：命中网站防御机制时不得自动重试，必须停止并交还用户。
 */
export function isDefenseMechanism(kind: CrawlErrorKind): boolean {
  return kind === "CaptchaDetected" || kind === "ChallengeDetected" || kind === "AccessDenied";
}

/** 将任意异常归一为 CrawlFailure。 */
export function toCrawlFailure(error: unknown): CrawlFailure {
  if (error instanceof CrawlFailure) return error;

  if (error instanceof Error) {
    if (error.name === "AbortError" || error.name === "TimeoutError") {
      return new CrawlFailure("Timeout", ERROR_MESSAGES.Timeout, error.message);
    }
    return new CrawlFailure("NetworkError", ERROR_MESSAGES.NetworkError, error.message);
  }

  return new CrawlFailure("NetworkError", ERROR_MESSAGES.NetworkError, String(error));
}
