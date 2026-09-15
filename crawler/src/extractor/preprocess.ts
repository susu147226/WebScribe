/**
 * 交给 Readability 之前的正文预处理。
 *
 * 解决的问题（均在真实文档站上复现）：
 *
 * 1. **代码块被整体丢弃。** 文档站普遍把代码包在装饰性容器里，例如
 *    `div.highlight-scroll-div > div.highlight-div > pre`。Readability 的
 *    `_cleanConditionally(articleContent, "div")` 会把这类「只有一个子元素、
 *    没有段落也没有图片」的 div 判为无用内容并删除，其中的 `<pre>` 随之消失。
 *    实测某 HarmonyOS 文档页的 3 段示例代码因此全部丢失。
 *    处理方式：把这层只起排版作用的 div 拆掉，让 `<pre>` 直接挂在正文容器下。
 *
 * 2. **代码块结构不标准，无法转为围栏代码块。** 同样的文档站把代码写成
 *    `pre > ol.linenums > li`（每行一个 li）并已由 highlight.js 着色，
 *    而不是标准的 `pre > code`。Turndown 的围栏代码规则要求 `pre` 的首个子
 *    元素是 `<code>`，否则不会生成 ``` 代码块。
 *    处理方式：还原为 `pre > code`，代码正文取自各 `<li>` 的纯文本。
 *
 * 两步都在既有的 jsdom 文档上原地完成，不额外解析 HTML。
 */

/** 拆掉只包着代码块的装饰性 div（含多层嵌套）。 */
export function unwrapCodeBlockWrappers(document: Document): number {
  let total = 0;

  // 逐层展开；每轮至少处理一层，上限用于防御异常深的结构
  for (let pass = 0; pass < 8; pass++) {
    let changed = false;

    for (const div of Array.from(document.querySelectorAll("div"))) {
      if (!div.parentNode) continue;

      const meaningful = Array.from(div.childNodes).filter(
        (node) =>
          node.nodeType === 1 ||
          (node.nodeType === 3 && (node.textContent ?? "").trim().length > 0),
      );

      if (meaningful.length !== 1) continue;

      const only = meaningful[0];
      if (only.nodeType !== 1 || (only as Element).tagName !== "PRE") continue;

      div.replaceWith(only);
      total += 1;
      changed = true;
    }

    if (!changed) break;
  }

  return total;
}

/**
 * 从 `<pre>` 的 class 推断语言标识。
 *
 * 已由 highlight.js 处理过的代码块会带上 `hljs` 类，其 `language-xxx` 是
 * highlight.js **自动识别**的结果而非作者声明 —— 实测某页面的 XML 主题代码
 * 被识别成 `vbnet`、`perl`、`php-template`。把这种猜测写进 Markdown 会产生
 * 误导，因此带 `hljs` 标记时一律不输出语言。
 */
export function detectLanguage(pre: Element): string | null {
  const code = pre.querySelector(":scope > code");
  if (code) {
    const fromCode = matchLanguage(code.getAttribute("class"));
    if (fromCode) return fromCode;
  }

  const className = pre.getAttribute("class") ?? "";
  if (/(^|\s)hljs(\s|$)/.test(className)) return null;

  return matchLanguage(className);
}

function matchLanguage(className: string | null): string | null {
  const match = (className ?? "").match(/(?:^|\s)language-([\w+#-]+)/);
  return match ? match[1] : null;
}

/** 取 `<pre>` 中的代码纯文本，正确处理 `ol > li` 的逐行结构。 */
export function extractCodeText(pre: Element): string {
  const list = pre.querySelector("ol, ul");
  if (list) {
    const lines = Array.from(list.querySelectorAll("li")).map((li) =>
      (li.textContent ?? "").replace(/\s+$/, ""),
    );
    if (lines.length > 0) return lines.join("\n");
  }

  const code = pre.querySelector(":scope > code");
  return ((code ?? pre).textContent ?? "").replace(/^\s*\n/, "").replace(/\s+$/, "");
}

/**
 * 把代码块规范化为 `pre > code`，使 Turndown 能生成围栏代码块。
 *
 * @returns 被规范化处理的 `<pre>` 数量
 */
export function normalizeCodeBlocks(document: Document): number {
  let count = 0;

  for (const pre of Array.from(document.querySelectorAll("pre"))) {
    const code = extractCodeText(pre);

    // 已经是标准的 pre > code 且内容一致时无需重建，避免破坏原有结构
    const existingCode = pre.querySelector(":scope > code");
    if (existingCode && pre.childNodes.length === 1 && existingCode.textContent === code) {
      count += 1;
      continue;
    }

    const language = detectLanguage(pre);

    const codeElement = document.createElement("code");
    if (language) codeElement.setAttribute("class", `language-${language}`);
    // 用 textContent 赋值：高亮 span 被自动剥离，且无需手工转义
    codeElement.textContent = code;

    pre.textContent = "";
    pre.appendChild(codeElement);
    count += 1;
  }

  return count;
}

/** 统一入口：在 Readability 之前调用。 */
export function preprocessForReadability(document: Document): void {
  unwrapCodeBlockWrappers(document);
  normalizeCodeBlocks(document);
}
