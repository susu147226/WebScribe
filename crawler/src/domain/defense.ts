import type { CrawlErrorKind } from "../protocol.js";

/**
 * 网站防御机制检测。
 *
 * 文档第 24 条的强制约束：本模块**只负责识别并让抓取停下来**，把决定权交还
 * 用户。任何形式的绕过——CAPTCHA 破解、Cloudflare Challenge 绕过、WAF 绕过、
 * IP/频率限制绕过、浏览器指纹伪装、代理池、MFA 绕过、访问控制绕过——都属于
 * 文档明文禁止实现的行为，不得在此处或任何调用方添加。
 *
 * 检测到信号后的正确流程（文档第 26 条）：
 *   停止自动抓取 → 向用户显示原因 → 等待用户处理
 */

export interface DefenseSignal {
  kind: Extract<
    CrawlErrorKind,
    "CaptchaDetected" | "ChallengeDetected" | "AccessDenied" | "RateLimited"
  >;
  /** 面向用户的中文说明。 */
  message: string;
  /** 触发判定的具体依据，便于用户自行核实。不含任何凭据。 */
  evidence: string;
}

/** 出现即代表页面是一个验证码挑战，而非正文内容。 */
const CAPTCHA_MARKERS: ReadonlyArray<{ pattern: RegExp; evidence: string }> = [
  { pattern: /https?:\/\/(www\.)?google\.com\/recaptcha\//i, evidence: "页面包含 reCAPTCHA 资源" },
  { pattern: /https?:\/\/(www\.)?gstatic\.com\/recaptcha\//i, evidence: "页面包含 reCAPTCHA 资源" },
  { pattern: /https?:\/\/hcaptcha\.com\//i, evidence: "页面包含 hCaptcha 资源" },
  { pattern: /https?:\/\/challenges\.cloudflare\.com\//i, evidence: "页面包含 Cloudflare Turnstile 资源" },
  { pattern: /\bclass\s*=\s*["'][^"']*\bg-recaptcha\b/i, evidence: "页面包含 g-recaptcha 元素" },
  { pattern: /\bclass\s*=\s*["'][^"']*\bh-captcha\b/i, evidence: "页面包含 h-captcha 元素" },
  { pattern: /\bclass\s*=\s*["'][^"']*\bcf-turnstile\b/i, evidence: "页面包含 cf-turnstile 元素" },
  { pattern: /\bid\s*=\s*["'](captcha|challenge-form)["']/i, evidence: "页面包含验证码容器" },
  { pattern: /\bdata-sitekey\s*=/i, evidence: "页面包含验证码 sitekey" },
  // 中文验证码：知网等站点的「请完成安全验证」、点击/滑块验证等。
  // 只匹配祈使句，避免误伤正文里「介绍验证码」的文章。
  { pattern: /请完成.{0,12}(安全|人机|行为|滑块)?验证/, evidence: "页面要求完成人机验证" },
  { pattern: /<title>[^<]*(安全验证|人机验证|行为验证|访问验证)[^<]*<\/title>/i, evidence: "页面标题为人机验证" },
];

/** 访问验证（Challenge）类信号。 */
const CHALLENGE_MARKERS: ReadonlyArray<{ pattern: RegExp; evidence: string }> = [
  { pattern: /window\._cf_chl_opt/i, evidence: "页面包含 Cloudflare 挑战脚本" },
  { pattern: /__cf_chl_/i, evidence: "页面包含 Cloudflare 挑战参数" },
  { pattern: /<title>\s*Just a moment\.\.\./i, evidence: "页面标题为 Cloudflare 等待页" },
  { pattern: /Checking your browser before accessing/i, evidence: "页面为 Cloudflare 浏览器检查页" },
  { pattern: /<title>\s*Attention Required!\s*\|\s*Cloudflare/i, evidence: "页面为 Cloudflare 拦截页" },
  { pattern: /\bcf-error-details\b/i, evidence: "页面为 Cloudflare 错误页" },
  { pattern: /Enable JavaScript and cookies to continue/i, evidence: "页面要求启用 JS 与 Cookie 才能继续" },
  { pattern: /<title>\s*(Access Denied|访问被拒绝|人机验证|访问验证)/i, evidence: "页面标题提示访问受限" },
  { pattern: /ddos-guard|DDoS protection by/i, evidence: "页面为 DDoS 防护页" },
  // WAF JS 挑战：起点等站点返回几乎为空的页面，只带一个探测脚本，
  // 靠浏览器执行 JS 才能放行。probe.js 是这类挑战的典型入口。
  { pattern: /<script[^>]+src\s*=\s*["'][^"']*probe\.js/i, evidence: "页面包含 WAF 探测脚本（probe.js）" },
];

function findMatch(
  html: string,
  markers: ReadonlyArray<{ pattern: RegExp; evidence: string }>,
): string | null {
  for (const { pattern, evidence } of markers) {
    if (pattern.test(html)) return evidence;
  }
  return null;
}

/**
 * 判定一次响应是否触发了网站防御机制。
 *
 * @param status HTTP 状态码
 * @param html   响应体（HTML 或纯文本）
 * @param headers 响应头，用于识别 `cf-mitigated` 等标志
 */
export function detectDefense(
  status: number,
  html: string,
  headers?: Headers | Record<string, string>,
): DefenseSignal | null {
  const header = (name: string): string | null => {
    if (!headers) return null;
    if (headers instanceof Headers) return headers.get(name);
    const key = Object.keys(headers).find((k) => k.toLowerCase() === name.toLowerCase());
    return key ? (headers[key] ?? null) : null;
  };

  if (status === 429) {
    const retryAfter = header("retry-after");
    return {
      kind: "RateLimited",
      message: "请求过于频繁，网站已限流。请稍后重试。",
      evidence: retryAfter ? `HTTP 429，Retry-After: ${retryAfter}` : "HTTP 429",
    };
  }

  if (header("cf-mitigated")) {
    return {
      kind: "ChallengeDetected",
      message: "网站返回了访问验证（Cloudflare Challenge），需要用户手动处理。",
      evidence: `响应头 cf-mitigated: ${header("cf-mitigated")}`,
    };
  }

  const captcha = findMatch(html, CAPTCHA_MARKERS);
  if (captcha) {
    return {
      kind: "CaptchaDetected",
      message: "页面要求完成验证码。请用户在浏览器中自行完成验证后再重试。",
      evidence: captcha,
    };
  }

  const challenge = findMatch(html, CHALLENGE_MARKERS);
  if (challenge) {
    return {
      kind: "ChallengeDetected",
      message: "页面存在访问验证，需要用户手动处理。",
      evidence: challenge,
    };
  }

  if (status === 403) {
    return {
      kind: "AccessDenied",
      message: "服务器返回 403，访问被拒绝。",
      evidence: "HTTP 403",
    };
  }

  // 451：因法律原因不可用
  if (status === 451) {
    return {
      kind: "AccessDenied",
      message: "服务器返回 451，该内容因法律原因不可访问。",
      evidence: "HTTP 451",
    };
  }

  return null;
}

/**
 * 判断页面是否呈现「内容由客户端脚本生成」的迹象。
 *
 * 文档第 40、41 条：普通页面走 HTTP，只有在 HTTP 拿不到正文或页面依赖 JS 时
 * 才启用浏览器渲染。
 *
 * 注意本函数回答的是「渲染是否**可能**有帮助」，而非「正文是否足够」：
 * 无脚本、无 SPA 容器的短页面返回 false —— 渲染它并不会产出更多内容。
 * 调用方仍需自行用 `isContentSufficient` 判断正文是否达标；
 * HTTP 正文不足时即使本函数返回 false，也应尝试一次渲染。
 */
export function looksLikeClientRendered(html: string, extractedText: string): boolean {
  // 与 extractor/readability.ts 的 MIN_CONTENT_LENGTH 保持一致：短正文（摘要、
  // 短章）不该被当成「没渲染出来」，只有真正的空壳才值得回退浏览器
  const textLength = extractedText.trim().length;
  if (textLength >= 50) return false;

  // 正文过短：若页面存在大量脚本或典型的 SPA 根容器，判定为客户端渲染
  const spaMarkers = [
    /<div[^>]+id\s*=\s*["'](root|app|__next|__nuxt)["']/i,
    /<script[^>]+type\s*=\s*["']module["']/i,
    /window\.__NUXT__|window\.__INITIAL_STATE__|__NEXT_DATA__/i,
  ];
  if (spaMarkers.some((p) => p.test(html))) return true;

  const scriptCount = (html.match(/<script\b/gi) ?? []).length;
  return scriptCount >= 3;
}

/** 该错误是否属于防御机制——命中时不得自动重试，须交还用户。 */
export function isDefenseMechanism(kind: CrawlErrorKind): boolean {
  return kind === "CaptchaDetected" || kind === "ChallengeDetected" || kind === "AccessDenied";
}
