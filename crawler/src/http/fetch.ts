import { CrawlFailure, ERROR_MESSAGES, toCrawlFailure } from "../errors.js";

/**
 * HTTP First 抓取（文档第 40 条）。
 *
 * 普通页面只走 HTTP，不启动浏览器；只有当 HTTP 拿不到正文、页面依赖 JS 或
 * 需要登录时，才交由 `browser/render.ts` 处理。
 */

/**
 * 如实标识本工具。
 *
 * 文档第 24 条明确禁止浏览器指纹伪装等规避手段，因此这里不使用伪造的浏览器
 * UA，而是给出可识别、可追责的真实标识，便于站点管理员判断流量来源。
 */
export const USER_AGENT = "WebScribe/0.1 (+local document archiver)";

/** 单次响应体上限，防止异常大的页面耗尽内存。 */
export const DEFAULT_MAX_BYTES = 10 * 1024 * 1024;

export const DEFAULT_TIMEOUT_MS = 30_000;

export interface FetchOptions {
  timeoutMs?: number;
  maxBytes?: number;
  /** 已保存的登录态 Cookie，用于访问登录后可读的页面。 */
  cookieHeader?: string;
  /** 目标站点的 robots.txt 已由调用方检查，此处不重复处理。 */
  accept?: string;
}

export interface FetchOutcome {
  status: number;
  body: string;
  headers: Headers;
  /** 跟随重定向后的最终地址。 */
  finalUrl: string;
  /** 响应体是否因超过上限而被截断。 */
  truncated: boolean;
}

/**
 * 发起一次 GET 请求。
 *
 * 仅返回响应，不做重试——重试与退避策略集中在 `task/queue.ts`，
 * 以便区分「可重试」与「命中防御机制不可重试」两类情况。
 */
export async function fetchPage(url: string, options: FetchOptions = {}): Promise<FetchOutcome> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;

  const headers: Record<string, string> = {
    "User-Agent": USER_AGENT,
    Accept: options.accept ?? "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
  };
  if (options.cookieHeader) {
    headers["Cookie"] = options.cookieHeader;
  }

  let response: Response;
  try {
    response = await fetch(url, {
      method: "GET",
      headers,
      redirect: "follow",
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    throw toCrawlFailure(error);
  }

  const { body, truncated } = await readBodyCapped(response, maxBytes);

  return {
    status: response.status,
    body,
    headers: response.headers,
    finalUrl: response.url || url,
    truncated,
  };
}

async function readBodyCapped(
  response: Response,
  maxBytes: number,
): Promise<{ body: string; truncated: boolean }> {
  if (!response.body) {
    return { body: await response.text(), truncated: false };
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let truncated = false;

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;

      total += value.byteLength;
      if (total > maxBytes) {
        truncated = true;
        const keep = value.byteLength - (total - maxBytes);
        if (keep > 0) chunks.push(value.subarray(0, keep));
        break;
      }
      chunks.push(value);
    }
  } catch (error) {
    throw toCrawlFailure(error);
  } finally {
    await reader.cancel().catch(() => {});
  }

  const merged = new Uint8Array(chunks.reduce((sum, c) => sum + c.byteLength, 0));
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return { body: new TextDecoder("utf-8").decode(merged), truncated };
}

/**
 * 下载二进制资源（图片等）。
 *
 * 与页面抓取分开，以便单独设置更小的体积上限与更短的超时。
 */
export async function fetchBinary(
  url: string,
  options: FetchOptions = {},
): Promise<{ bytes: Uint8Array; contentType: string | null }> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxBytes = options.maxBytes ?? 5 * 1024 * 1024;

  let response: Response;
  try {
    response = await fetch(url, {
      method: "GET",
      headers: {
        "User-Agent": USER_AGENT,
        Accept: "image/*,*/*;q=0.8",
        ...(options.cookieHeader ? { Cookie: options.cookieHeader } : {}),
      },
      redirect: "follow",
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    throw toCrawlFailure(error);
  }

  if (!response.ok) {
    throw new CrawlFailure("NetworkError", ERROR_MESSAGES.NetworkError, `HTTP ${response.status}`);
  }

  const buffer = await response.arrayBuffer();
  if (buffer.byteLength > maxBytes) {
    throw new CrawlFailure("NetworkError", ERROR_MESSAGES.NetworkError, "图片超出体积上限");
  }

  return {
    bytes: new Uint8Array(buffer),
    contentType: response.headers.get("content-type"),
  };
}
