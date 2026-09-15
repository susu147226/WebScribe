import { JSDOM, VirtualConsole } from "jsdom";

/**
 * 多页文档自动发现（文档第 22 条）。
 *
 * 约束：
 * - 只识别明确的分页关系（`rel="next"`、`下一页`、`Next`、`Next Page`、`>` 等）
 * - 不得无限探索：上限、去重、同站范围限制、错误次数限制由调用方统一施加
 * - **无法可靠判断下一页时必须停止并提示用户，不得猜测**
 */

/** 视为「下一页」的链接文本。比对时去空白并转小写。 */
const NEXT_LINK_TEXTS: ReadonlySet<string> = new Set([
  "下一页",
  "下页",
  "下一頁",
  "next",
  "nextpage",
  "next page",
  "older",
  "›",
  "»",
  ">",
  "→",
  "next →",
]);

/** 分页容器的常见 class / id 关键字。 */
const PAGINATION_HINTS = ["pagination", "pager", "page-nav", "pagenav", "next-page", "nextpage"];

export interface PaginationContext {
  /** 已访问过的规范化 URL，用于去重。 */
  visited: ReadonlySet<string>;
  /** 判断候选地址是否仍在本站范围内（按注册域）。 */
  isSameSite: (url: string) => boolean;
  /** 规范化函数，与 URL 查重口径保持一致。 */
  normalize: (url: string) => string;
}

export interface NextPageMatch {
  url: string;
  /** 判定依据，用于向用户说明自动续页的原因。 */
  evidence: string;
}

/**
 * 在当前页面中寻找「下一页」链接。
 *
 * 判定优先级：
 * 1. `<link rel="next">` —— 最可靠的机器可读信号
 * 2. `<a rel="next">` —— 同样明确的语义标注
 * 3. 分页容器内、文本精确匹配「下一页 / Next / Next Page / >」等的链接
 *
 * 第 3 类要求文本**精确**匹配（去空白、忽略大小写），不做包含匹配，
 * 以免把「Next.js 教程」这类普通链接误判为翻页。
 */
export function findNextPage(
  html: string,
  currentUrl: string,
  context: PaginationContext,
): NextPageMatch | null {
  const virtualConsole = new VirtualConsole();
  virtualConsole.on("jsdomError", () => {});

  let document: Document;
  try {
    const dom = new JSDOM(html, { url: currentUrl, virtualConsole });
    document = dom.window.document;
  } catch {
    return null;
  }

  try {
    // 1) <link rel="next">
    for (const link of Array.from(document.querySelectorAll('link[rel~="next" i]'))) {
      const href = link.getAttribute("href");
      const match = accept(href, currentUrl, context, "页面声明 <link rel=\"next\">");
      if (match) return match;
    }

    // 2) <a rel="next">
    for (const anchor of Array.from(document.querySelectorAll('a[rel~="next" i]'))) {
      const match = accept(
        anchor.getAttribute("href"),
        currentUrl,
        context,
        "页面声明 <a rel=\"next\">",
      );
      if (match) return match;
    }

    // 3) 分页容器内的精确文本匹配
    for (const anchor of Array.from(document.querySelectorAll("a[href]"))) {
      const text = normalizeText(anchor.textContent ?? "");
      if (!NEXT_LINK_TEXTS.has(text)) continue;

      const title = normalizeText(anchor.getAttribute("title") ?? "");
      const aria = normalizeText(anchor.getAttribute("aria-label") ?? "");
      const classAndId = [
        anchor.className ?? "",
        anchor.id,
        anchor.parentElement?.className ?? "",
        anchor.parentElement?.id ?? "",
      ]
        .join(" ")
        .toLowerCase();

      const inPaginationBlock = PAGINATION_HINTS.some((hint) => classAndId.includes(hint));
      const labelled = NEXT_LINK_TEXTS.has(title) || NEXT_LINK_TEXTS.has(aria);

      // 文本为 ">" 一类模糊符号时，必须有额外的语义线索才采信
      const ambiguous = text.length <= 2 && !/[\p{Script=Han}a-z]/u.test(text);
      if (ambiguous && !inPaginationBlock && !labelled) continue;

      const match = accept(
        anchor.getAttribute("href"),
        currentUrl,
        context,
        inPaginationBlock ? `分页区域内的「${text}」链接` : `文本为「${text}」的链接`,
      );
      if (match) return match;
    }
  } finally {
    document.defaultView?.close();
  }

  return null;
}

function accept(
  href: string | null,
  currentUrl: string,
  context: PaginationContext,
  evidence: string,
): NextPageMatch | null {
  if (!href) return null;

  let absolute: URL;
  try {
    absolute = new URL(href.trim(), currentUrl);
  } catch {
    return null;
  }

  // 仅接受 http/https
  if (absolute.protocol !== "http:" && absolute.protocol !== "https:") return null;

  const candidate = absolute.toString();
  const normalized = context.normalize(candidate);

  // 同站范围限制：不得跨站自动续页
  if (!context.isSameSite(candidate)) return null;

  // 去重：已访问过的不再排队
  if (context.visited.has(normalized)) return null;

  // 指向自身的链接不是有效的下一页
  if (normalized === context.normalize(currentUrl)) return null;

  return { url: candidate, evidence };
}

function normalizeText(input: string): string {
  return input.replace(/\s+/g, " ").trim().toLowerCase();
}
