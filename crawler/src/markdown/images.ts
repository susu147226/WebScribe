import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fetchBinary } from "../http/fetch.js";

/**
 * `local` 图片策略：把图片下载到暂存目录，返回文件名。
 *
 * Markdown 中写入的是占位前缀（默认 `{{ASSETS}}`）加文件名，真实资产目录
 * 由 Rust 侧在落盘时决定并替换——因为目录名取决于净化后的文档标题，
 * 而标题的净化规则属于 Rust 侧 `naming.rs`。
 */

/** 常见图片 MIME 到扩展名的映射。 */
const MIME_EXTENSIONS: Record<string, string> = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/jpg": ".jpg",
  "image/gif": ".gif",
  "image/webp": ".webp",
  "image/svg+xml": ".svg",
  "image/bmp": ".bmp",
  "image/avif": ".avif",
  "image/x-icon": ".ico",
  "image/vnd.microsoft.icon": ".ico",
  "image/tiff": ".tiff",
};

const ALLOWED_EXTENSIONS = new Set(Object.values(MIME_EXTENSIONS));

/**
 * 为图片生成稳定且安全的文件名。
 *
 * 使用 URL 的 SHA-256 前 16 位十六进制，避免重名与非法字符；
 * 同一 URL 在多次抓取中得到相同文件名。
 */
export function imageFileName(url: string, contentType: string | null): string {
  const hash = createHash("sha256").update(url).digest("hex").slice(0, 16);
  return `${hash}${pickExtension(url, contentType)}`;
}

function pickExtension(url: string, contentType: string | null): string {
  if (contentType) {
    const mime = contentType.split(";")[0].trim().toLowerCase();
    const mapped = MIME_EXTENSIONS[mime];
    if (mapped) return mapped;
  }

  try {
    const ext = path.extname(new URL(url).pathname).toLowerCase();
    if (ALLOWED_EXTENSIONS.has(ext)) return ext;
  } catch {
    // URL 不合法时忽略，落到默认扩展名
  }

  return ".img";
}

export interface ImageDownloaderOptions {
  /** 暂存目录。 */
  dir: string;
  /** 已保存的登录态 Cookie，用于需要授权的图片。 */
  cookieHeader?: string;
  timeoutMs?: number;
  maxBytes?: number;
}

/**
 * 创建图片下载器。
 *
 * 单个图片下载失败不会中断整篇文档——调用方在 `localizeImages` 中会保留
 * 该图片的远程 URL 作为回退。
 */
export function createImageDownloader(
  options: ImageDownloaderOptions,
): (absoluteUrl: string) => Promise<string | null> {
  const timeoutMs = options.timeoutMs ?? 20_000;
  const maxBytes = options.maxBytes ?? 5 * 1024 * 1024;

  return async (absoluteUrl: string): Promise<string | null> => {
    // 仅处理网络图片；data: URI 等原样保留
    if (!/^https?:/i.test(absoluteUrl)) return null;

    const { bytes, contentType } = await fetchBinary(absoluteUrl, {
      timeoutMs,
      maxBytes,
      ...(options.cookieHeader ? { cookieHeader: options.cookieHeader } : {}),
    });

    const name = imageFileName(absoluteUrl, contentType);

    await mkdir(options.dir, { recursive: true });
    await writeFile(path.join(options.dir, name), bytes);

    return name;
  };
}
