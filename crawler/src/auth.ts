import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

/**
 * 登录态读取（文档第 28、30 条）。
 *
 * 登录态由用户在 Playwright 打开的窗口中自行完成登录后保存，本模块只负责
 * 读取并在后续请求中复用。它**不读取、不解析、不记录任何明文密码**。
 *
 * 文档第 30 条：认证状态属于敏感数据，不得写入日志、不得上传、不得提交 Git。
 * 因此这里只返回内存中的 Cookie，绝不打印其内容。
 */

/** Playwright `storageState` 中的 Cookie 条目。 */
export interface StoredCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  expires?: number;
  secure?: boolean;
  httpOnly?: boolean;
}

interface StorageState {
  cookies?: StoredCookie[];
  origins?: Array<{ origin: string; localStorage?: Array<{ name: string; value: string }> }>;
}

/**
 * 读取登录态目录下的全部 Cookie。
 *
 * 目录中可能同时存在多个站点的登录态，调用方按 URL 过滤即可，
 * 无需在此处判断站点归属。
 */
export async function loadCookies(authDir: string): Promise<StoredCookie[]> {
  let entries: string[];
  try {
    entries = await readdir(authDir);
  } catch {
    // 目录不存在表示尚无任何登录态
    return [];
  }

  const all: StoredCookie[] = [];

  for (const entry of entries) {
    if (!entry.toLowerCase().endsWith(".json")) continue;

    try {
      const raw = await readFile(path.join(authDir, entry), "utf8");
      const state = JSON.parse(raw) as StorageState;
      if (Array.isArray(state.cookies)) {
        for (const cookie of state.cookies) {
          if (typeof cookie?.name === "string" && typeof cookie?.value === "string") {
            all.push(cookie);
          }
        }
      }
    } catch {
      // 单个文件损坏不应影响其余站点
    }
  }

  return all;
}

/** 按 RFC 6265 的简化规则判断 Cookie 是否适用于该主机。 */
export function domainMatches(host: string, cookieDomain: string): boolean {
  const hostLower = host.toLowerCase();
  const domain = cookieDomain.toLowerCase();

  if (domain.startsWith(".")) {
    const bare = domain.slice(1);
    return hostLower === bare || hostLower.endsWith(domain);
  }
  return hostLower === domain;
}

function pathMatches(requestPath: string, cookiePath: string): boolean {
  if (!cookiePath || cookiePath === "/") return true;
  if (requestPath === cookiePath) return true;
  const prefix = cookiePath.endsWith("/") ? cookiePath : `${cookiePath}/`;
  return requestPath.startsWith(prefix);
}

/**
 * 为某个 URL 构造 Cookie 请求头。
 *
 * 依据域名、路径、有效期与 Secure 属性筛选，不匹配的 Cookie 不会外泄到
 * 其他站点。
 *
 * @returns 形如 `a=1; b=2` 的请求头值；无可用 Cookie 时返回 undefined
 */
export function cookieHeaderFor(
  cookies: readonly StoredCookie[],
  url: string,
  now: number = Date.now(),
): string | undefined {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return undefined;
  }

  const host = parsed.hostname;
  const isSecure = parsed.protocol === "https:";

  const applicable = cookies.filter((cookie) => {
    if (!domainMatches(host, cookie.domain)) return false;
    if (!pathMatches(parsed.pathname || "/", cookie.path)) return false;
    if (cookie.secure && !isSecure) return false;
    // expires 为 -1 或缺失表示会话 Cookie，仍然有效
    if (typeof cookie.expires === "number" && cookie.expires > 0) {
      const expiresMs = cookie.expires * 1000;
      if (expiresMs <= now) return false;
    }
    return true;
  });

  if (applicable.length === 0) return undefined;

  return applicable.map((c) => `${c.name}=${c.value}`).join("; ");
}

/** 判断某个 URL 是否已有可用的登录态。 */
export function hasLoginState(
  cookies: readonly StoredCookie[],
  url: string,
  now: number = Date.now(),
): boolean {
  return cookieHeaderFor(cookies, url, now) !== undefined;
}
