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

/** 正文被认为有效的纯文本长度下限。
 *
 * 这里设得较低（50 字符），是为了容纳**论文摘要、小说短章、诗歌**这类正当但
 * 篇幅短的正文 —— 它们常常不足一两百字，若阈值过高（如 200）会被误判为
 * 「无法获取正文」。50 字符的底线足以排除纯导航、版权声明、空白页等零星噪声。
 */
export const MIN_CONTENT_LENGTH = 50;

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
 * 判断某个 class / id 标记是否属于「标题」命名。
 *
 * 命中 `title`、`doc-title`、`article_title`、`title-wrap` 这类写法；
 * `subtitle`、`titled` 之类不算 —— 它们不是标题本身。
 */
function isTitleToken(token: string): boolean {
  return /(^|[-_])title([-_]|$)/i.test(token.trim());
}

/** 元素是否位于站点外壳里 —— 那里的「标题」不是文章标题。 */
const CHROME_TAGS = "nav, header, footer, aside";

/**
 * 标记名里带这些词的，属于站点外壳：导航、菜单、页头页脚、弹窗等。
 *
 * 只看标签名不够：荣耀的文档站把页头写成 `<div id="header">`、导航项写成
 * `<div class="title">` 挂在 `.menu-title` 下，全是 class/id，标签层面看不出来。
 */
const CHROME_MARKERS =
  /(^|[-_])(nav|navbar|menu|sidebar|side|aside|header|footer|foot|dialog|modal|toolbar|breadcrumb|crumb|tab|pager|pagination)([-_]|$)/i;

function insideSiteChrome(element: Element): boolean {
  const body = element.ownerDocument.body;
  let current: Element | null = element;

  while (current && current !== body) {
    if (current.matches(CHROME_TAGS)) return true;

    const markers = [...current.classList, current.getAttribute("id") ?? ""];
    if (markers.some((marker) => CHROME_MARKERS.test(marker))) return true;

    current = current.parentElement;
  }

  return false;
}

/**
 * 取页面自己的标题。
 *
 * **为什么要按结构判断，而不是只看标签：** 不少站点的文档标题并不用 `<h1>` 渲染，
 * 而是用 `<span>` / `<div>` / `<p>` 再挂一个 `title` 类。只看标签会漏掉这类页面，
 * 退回站点级的 `<title>`，结果所有文档标题都一样。
 *
 * 判定顺序：
 *
 * 1. 文档里的第一个 `<h1>` —— 最明确的信号
 * 2. 带「标题」命名的元素（**任意标签**），但必须位于正文区域：不在导航、菜单、
 *    页头页脚、弹窗等外壳内，文本长度合理
 * 3. 提取后正文开头的标题 —— 覆盖「文档标题与小节标题同级」的站点
 *
 * 第 2 步只做结构判断，不预设标签名，因此 `div.title`、`span.title`、`p.title`
 * 都能识别；第 3 步则覆盖另一种常见结构。**荣耀的文档站正是第 3 种**：它的正文
 * 标题与小节标题都是 `<h3>`（`功能描述`、`版本限制`……），而页面上所有带 `title`
 * 类名的元素都是导航菜单，只有靠「正文开头的标题」才能取对。
 *
 * **为什么必须在 Readability 之前取：** Readability 的 `_headerDuplicatesTitle`
 * 会用 0.75 的文本相似度判断「这个标题与文章标题重复」，把这类元素一并删除。
 * 等到 Readability 之后再找，页面标题已经没了。
 */
function documentHeading(document: Document): string {
  const clean = (text: string | null | undefined): string =>
    (text ?? "").replace(/\s+/g, " ").trim();

  // 1) h1 最明确
  for (const h1 of Array.from(document.querySelectorAll("h1"))) {
    const text = clean(h1.textContent);
    if (text.length > 0) return text;
  }

  // 2) 按结构找带「标题」命名的元素（任意标签）
  const MAX_TITLE_CHARS = 200;
  const candidates: Element[] = [];

  for (const element of Array.from(document.querySelectorAll("[class], [id]"))) {
    const markers = [
      ...Array.from(element.classList),
      element.getAttribute("id") ?? "",
    ];
    if (!markers.some(isTitleToken)) continue;
    if (insideSiteChrome(element)) continue;

    const text = clean(element.textContent);
    if (text.length < 2 || text.length > MAX_TITLE_CHARS) continue;

    candidates.push(element);
  }

  // 候选之间常是嵌套关系，例如荣耀的文档站：
  //
  //   <div class="document-title">
  //     <span class="title">锁屏、桌面、桌面小组件联动</span>
  //     <span class="document-title-summary-button">智能摘要</span>
  //   </div>
  //
  // 外层 div 同样带「title」命名，但它的文本把旁边的按钮也捎上了。
  // 只保留最内层的那一个，才能拿到干净的标题。
  const innermost = candidates.filter(
    (element) => !candidates.some((other) => other !== element && element.contains(other)),
  );

  if (innermost.length > 0) {
    return clean(innermost[0].textContent);
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
