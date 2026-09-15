import { Readability } from "@mozilla/readability";
import { JSDOM, VirtualConsole } from "jsdom";

import { preprocessForReadability } from "./preprocess.js";

/**
 * 正文提取。
 *
 * 文档第 12 条推荐使用 Mozilla Readability，用于标题提取、正文提取、作者信息、
 * 摘要与正文区域识别，并去除导航、广告等无关区域。
 *
 * 该条同时提醒：Readability 不等于完整的多页文档发现系统，多页发现另见
 * `task/pagination.ts`。
 */

export interface ExtractedContent {
  title: string;
  /** 纯文本正文，用于判断内容是否充分。 */
  textContent: string;
  /** 正文 HTML，供 Turndown 转换为 Markdown。 */
  contentHtml: string;
  byline: string | null;
  excerpt: string | null;
  siteName: string | null;
  /** 文档 `<title>`，Readability 失败时作为标题回退。 */
  documentTitle: string;
}

/** 正文被认为有效的纯文本长度下限。 */
export const MIN_CONTENT_LENGTH = 200;

/**
 * 归一化标题文本，用于比对：去空白、转小写、去除首尾标点。
 */
function normalizeHeadingText(input: string): string {
  return input
    .replace(/\s+/g, " ")
    .replace(/^[\s　]*[|·—–-]\s*/, "")
    .replace(/\s*[|·—–-][\s　]*$/, "")
    .trim()
    .toLowerCase();
}

/** 标题后缀分隔符：`文章标题 | 站点名` 之类的常见形式。 */
const TITLE_SEPARATORS = ["|", "·", "—", "–", "-", "::", "»", "›"];

/**
 * 判断正文首个标题是否与文档标题重复。
 *
 * 命中两种情形之一即视为重复：
 * 1. 两者归一化后完全相同
 * 2. 文档标题以「首标题 + 分隔符」开头，例如首标题 `使用指南`、
 *    文档标题 `使用指南 | 站点名`
 */
function isDuplicateOfTitle(headingText: string, titles: readonly string[]): boolean {
  const heading = normalizeHeadingText(headingText);
  if (!heading) return false;

  for (const rawTitle of titles) {
    const title = normalizeHeadingText(rawTitle);
    if (!title) continue;
    if (title === heading) return true;

    for (const separator of TITLE_SEPARATORS) {
      if (title.startsWith(`${heading}${separator}`) || title.startsWith(`${heading} ${separator}`)) {
        return true;
      }
    }
  }

  return false;
}

/**
 * 移除正文开头与文档标题重复的标题元素。
 *
 * **为什么需要这一步：** Readability 会把正文中的 `h1` 映射为 `h2`（它认为
 * 页面 `h1` 就是文章标题，已通过 `title` 单独返回），而 `h2`–`h6` 原样保留。
 * 由于本工具的文档结构（文档第 33 条）已经把标题渲染为 `# 页面标题`，正文里
 * 那个被降级的 `h1` 就成了重复内容，且层级与原文不符。
 *
 * 删除它与文档标题重复的首个标题后，正文中的 `h2`–`h6` 恰好保持原文层级，
 * 符合文档第 13 条「尽可能保留 H1-H6」的要求。
 *
 * 只处理**第一个**标题元素：后续出现的同名标题属于正文内容，不应删除。
 */
export function stripDuplicateLeadingHeading(
  contentHtml: string,
  titles: readonly string[],
): string {
  const headingPattern = /<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/i;
  const match = contentHtml.match(headingPattern);
  if (!match || match.index === undefined) return contentHtml;

  // 首个标题之前若已有实质性正文，说明它不是文章标题，保持原样
  const before = contentHtml.slice(0, match.index);
  if (/<(p|ul|ol|table|pre|blockquote)\b/i.test(before)) return contentHtml;

  const headingText = match[2].replace(/<[^>]+>/g, "");
  if (!isDuplicateOfTitle(headingText, titles)) return contentHtml;

  return contentHtml.slice(0, match.index) + contentHtml.slice(match.index + match[0].length);
}

/**
 * 取正文开头的标题元素——通常就是这篇文章自己的标题。
 *
 * **为什么优先用它而不是 `article.title`：** Readability 的 `title` 取自网页的
 * `<title>` 标签，而文档站普遍在 `<title>` 里拼上一段栏目后缀。例如某 HarmonyOS
 * 文档页的 `<title>` 是
 *
 *   变量：全局变量<GlobalVariable>-基础功能-HarmonyOS 5.0及以上版本主题引擎规范-...
 *
 * 每页都拖着同一段后缀，用作文档标题与文件名时看起来全都一样。而正文里的标题
 * （h1）才是这一页真正的名字：`变量：全局变量<GlobalVariable>`。
 *
 * 仅当标题出现在正文开头时才采用 —— 若它之前已经有段落、列表或表格，说明那只是
 * 一个小节标题，不足以代表整篇文档。
 */
export function leadingHeadingText(contentHtml: string): string {
  const match = contentHtml.match(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/i);
  if (!match || match.index === undefined) return "";

  const before = contentHtml.slice(0, match.index);
  if (/<(p|ul|ol|table|pre|blockquote)\b/i.test(before)) return "";

  return match[2]
    .replace(/<[^>]+>/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * 取页面自己的标题——文档中的 `<h1>`。
 *
 * **为什么必须在 Readability 之前取：** 不少文档站（OPPO、vivo 的开放平台等）把
 * 每个页面的 `<title>` 都写成站点级的固定文案，例如每一页都是
 * `OPPO 开放平台-OPPO开发者服务中心`；页面真正的名字在正文的 `<h1>` 里。
 *
 * 而 Readability 的 `_headerDuplicatesTitle` 会用 0.75 的文本相似度阈值判断
 * 「这个标题与文章标题重复」，把这类 h1 一并删除——`OPPO开发者服务协议` 与
 * `OPPO 开放平台-OPPO开发者服务中心` 因共享 `OPPO`、`开发者` 等词而被误判。
 * 等到 Readability 之后再找，页面标题已经没了。
 */
function documentHeading(document: Document): string {
  for (const h1 of Array.from(document.querySelectorAll("h1"))) {
    const text = (h1.textContent ?? "").replace(/\s+/g, " ").trim();
    if (text.length > 0) return text;
  }
  return "";
}

/**
 * 从 HTML 中提取正文。
 *
 * @param html 原始 HTML
 * @param url  页面 URL，用于解析相对链接与图片
 */
export function extractContent(html: string, url: string): ExtractedContent | null {
  const virtualConsole = new VirtualConsole();
  // 忽略页面自身脚本抛出的错误，它们与提取无关
  virtualConsole.on("jsdomError", () => {});

  let dom: JSDOM;
  try {
    dom = new JSDOM(html, {
      url,
      // HTTP 阶段不执行页面脚本，避免触发页面逻辑
      runScripts: undefined,
      virtualConsole,
    });
  } catch {
    return null;
  }

  const documentTitle = dom.window.document.title ?? "";
  const headingTitle = documentHeading(dom.window.document);

  // 必须在 Readability 之前：拆掉包裹代码块的装饰性 div（否则 Readability 会
  // 连同其中的 <pre> 一并删除），并把代码规范化为 pre > code
  preprocessForReadability(dom.window.document);

  let article: ReturnType<Readability["parse"]> = null;
  try {
    article = new Readability(dom.window.document, {
      charThreshold: 100,
    }).parse();
  } catch {
    article = null;
  } finally {
    dom.window.close();
  }

  if (!article) {
    // Readability 判定页面无正文，但纯文本仍可能有价值，交由调用方决定
    return null;
  }

  const title = resolveArticleTitle(article, headingTitle, documentTitle);
  const contentHtml = stripDuplicateLeadingHeading(article.content ?? "", [
    title,
    documentTitle,
  ]);

  return {
    title,
    textContent: (article.textContent ?? "").trim(),
    contentHtml,
    byline: article.byline ?? null,
    excerpt: article.excerpt ?? null,
    siteName: article.siteName ?? null,
    documentTitle: documentTitle.trim(),
  };
}

/**
 * 决定文档标题。
 *
 * 优先级：
 *
 * 1. **页面自己的 `<h1>`** —— 文档站里每页真正不同的名字
 * 2. **提取后正文开头的标题** —— 页面没有 h1，但文章以小标题开头时
 * 3. Readability 从 `<title>` 推出的标题
 * 4. `<title>` 本身
 *
 * 后两者在文档站上往往是站点级固定文案，因此排在最后。
 */
function resolveArticleTitle(
  article: NonNullable<ReturnType<Readability["parse"]>>,
  documentHeadingTitle: string,
  documentTitle: string,
): string {
  const candidates = [
    documentHeadingTitle,
    leadingHeadingText(article.content ?? ""),
    (article.title ?? "").trim(),
    documentTitle.trim(),
  ];

  for (const candidate of candidates) {
    if (candidate && candidate.trim().length > 0) return candidate.trim();
  }
  return "";
}

/** 判断提取结果是否达到「正文充分」的标准。 */
export function isContentSufficient(content: ExtractedContent | null): boolean {
  return content !== null && content.textContent.length >= MIN_CONTENT_LENGTH;
}

/**
 * 从 HTML 中取出 `<title>`，作为 Readability 的兜底标题来源。
 */
export function extractDocumentTitle(html: string): string {
  const match = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (!match) return "";
  return decodeEntities(match[1]).trim();
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  mdash: "—",
  ndash: "–",
  hellip: "…",
};

function decodeEntities(input: string): string {
  return input.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (whole, entity: string) => {
    if (entity.startsWith("#x") || entity.startsWith("#X")) {
      const code = Number.parseInt(entity.slice(2), 16);
      return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
    }
    if (entity.startsWith("#")) {
      const code = Number.parseInt(entity.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
    }
    return NAMED_ENTITIES[entity.toLowerCase()] ?? whole;
  });
}
