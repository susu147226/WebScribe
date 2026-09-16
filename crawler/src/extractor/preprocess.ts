import { Readability } from "@mozilla/readability";

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
  neutralizeHeadingIds(document);
  normalizeCodeBlocks(document);
}

/**
 * 改写标题元素上会被 Readability 误判为「页头」的 id / class。
 *
 * **问题：** Readability 的 `_stripUnlikelyCandidates` 会把 id 或 class 命中
 * 「可疑元素」正则的节点直接删掉，该正则里包含 `header` —— 本意是剥掉页面顶部的
 * 导航，但不少文档站把**正文标题**的 id 就命名为 `header-0`、`header-1`……
 *
 * 实测某 OPPO 文档页：`#wikiContent` 下 173 个有文本的子元素里，161 个正常保留，
 * 被丢掉的 12 个恰好是全部 h3 小节标题（`id="header-1"` … `id="header-12"`），
 * 正文都在、标题全没了。关闭 Readability 的 `FLAG_STRIP_UNLIKELYS` 后 12 个标题
 * 全部回来，据此确认原因。
 *
 * **做法：** 只对 **h1–h6** 处理 —— 带这类 id 的标题几乎必然是正文章节标题，
 * 而不是页面导航（导航很少是编号连续的标题元素）。改写时保留原名作为后缀，
 * 并同步指向它的页内锚点，避免破坏文档内的跳转。
 *
 * 正则直接取自 Readability 自身，不另抄一份，以免它升级后两边失配。
 */
export function neutralizeHeadingIds(document: Document): number {
  // REGEXPS 挂在 Readability 的原型上，但其类型声明未导出，这里显式断言
  const patterns = (
    Readability.prototype as unknown as {
      REGEXPS: { unlikelyCandidates: RegExp; okMaybeItsACandidate: RegExp };
    }
  ).REGEXPS;

  const unlikely = patterns.unlikelyCandidates;
  const maybe = patterns.okMaybeItsACandidate;

  const matches = (pattern: RegExp, text: string): boolean => {
    // 这些正则理论上不带 g，重置 lastIndex 只是防御
    pattern.lastIndex = 0;
    return pattern.test(text);
  };

  // 生成的新 id 必须避开页面上已有的 id
  const taken = new Set(
    Array.from(document.querySelectorAll("[id]")).map((el) => el.getAttribute("id") ?? ""),
  );
  const freshId = (): string => {
    let n = 0;
    for (;;) {
      const candidate = `section-${n}`;
      if (!taken.has(candidate)) {
        taken.add(candidate);
        return candidate;
      }
      n += 1;
    }
  };

  let changed = 0;

  for (const heading of Array.from(document.querySelectorAll("h1,h2,h3,h4,h5,h6"))) {
    const id = heading.getAttribute("id") ?? "";
    const className = typeof heading.className === "string" ? heading.className : "";

    if (!id && !className) continue;
    if (!matches(unlikely, `${className} ${id}`)) continue;
    // 命中「可能是正文」的词就不必动它 —— Readability 本来也不会删
    if (matches(maybe, `${className} ${id}`)) continue;

    if (id) {
      // 注意：不能只在原名前加前缀 —— `ws-header-1` 里依旧带着 `header`，
      // 仍会被正则命中。必须整体换成一个不含触发词的新 id。
      const renamed = freshId();
      heading.setAttribute("id", renamed);

      // 同步页内锚点，别把文档里的跳转弄坏
      for (const anchor of Array.from(document.querySelectorAll('a[href^="#"]'))) {
        if (anchor.getAttribute("href") === `#${id}`) {
          anchor.setAttribute("href", `#${renamed}`);
        }
      }
    }

    if (className) {
      // class 里逐个 token 检查，只丢掉会触发误判的那些
      const kept = className
        .split(/\s+/)
        .filter((token) => token.length > 0 && !matches(unlikely, token));

      if (kept.length > 0) heading.setAttribute("class", kept.join(" "));
      else heading.removeAttribute("class");
    }

    changed += 1;
  }

  return changed;
}
