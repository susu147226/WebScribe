import { describe, expect, it } from "vitest";
import { JSDOM } from "jsdom";

import { extractContent } from "../src/extractor/readability.js";
import {
  detectLanguage,
  extractCodeText,
  normalizeCodeBlocks,
  unwrapCodeBlockWrappers,
} from "../src/extractor/preprocess.js";
import { toMarkdown } from "../src/markdown/convert.js";

/**
 * 回归测试。
 *
 * 曾出现过的问题：真实文档站把代码包在装饰性 div 里
 * （`div.highlight-scroll-div > div.highlight-div > pre`），Readability 的
 * `_cleanConditionally(articleContent, "div")` 会把这层 div 判为无用内容删除，
 * 其中的代码块随之全部消失 —— 实测某页面 3 段示例代码全部丢失。
 *
 * 同时，这类站点把代码写作 `pre > ol.linenums > li`，不是 Turndown 要求的
 * `pre > code`，即便侥幸保留也不会转成围栏代码块。
 */

const PAGE_URL = "https://example.com/doc";
const FILLER = "<p>" + "这是一段足够长的正文内容用于通过提取阈值。".repeat(12) + "</p>";

function page(body: string): string {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>代码页</title></head><body><article><h1>代码页</h1>${FILLER}${body}${FILLER}</article></body></html>`;
}

function parse(html: string): Document {
  return new JSDOM(`<!doctype html><html><body>${html}</body></html>`).window.document;
}

/** 取自真实文档页的结构：装饰性 div 包裹 + ol/li 逐行 + hljs 着色。 */
const REAL_WORLD_CODE = `<div class="highlight-scroll-div"><div class="highlight-div"><pre class="screen prettyprint linenums hljs language-vbnet" id="T__screen1" data-highlighted="yes"><ol class="linenums"><li>&lt;<span class="hljs-keyword">Var</span> <span class="hljs-attr">name</span>=<span class="hljs-string">""</span> /&gt;</li><li>&lt;Text x="40" /&gt;</li></ol></pre></div></div>`;

describe("unwrapCodeBlockWrappers", () => {
  it("拆掉只包着代码块的多层 div", () => {
    const doc = parse(REAL_WORLD_CODE);
    const removed = unwrapCodeBlockWrappers(doc);

    expect(removed).toBe(2);
    expect(doc.querySelector("div.highlight-scroll-div")).toBeNull();
    expect(doc.querySelector("pre")).not.toBeNull();
    // 拆开后 pre 直接挂在 body 下
    expect(doc.querySelector("pre")!.parentElement!.tagName).toBe("BODY");
  });

  it("含其它内容的 div 不被拆", () => {
    const doc = parse('<div><pre>code</pre><p>说明文字</p></div>');
    expect(unwrapCodeBlockWrappers(doc)).toBe(0);
    expect(doc.querySelector("div")).not.toBeNull();
  });

  it("含文本节点的 div 不被拆", () => {
    const doc = parse("<div>前置文字<pre>code</pre></div>");
    expect(unwrapCodeBlockWrappers(doc)).toBe(0);
  });

  it("没有代码块时不做任何改动", () => {
    const doc = parse("<div><p>正文</p></div>");
    expect(unwrapCodeBlockWrappers(doc)).toBe(0);
  });
});

describe("extractCodeText", () => {
  it("按 li 逐行还原代码", () => {
    const doc = parse("<pre><ol><li>第一行</li><li>第二行</li><li>第三行</li></ol></pre>");
    expect(extractCodeText(doc.querySelector("pre")!)).toBe("第一行\n第二行\n第三行");
  });

  it("剥离高亮 span，只保留纯文本", () => {
    const doc = parse(
      '<pre><ol><li>&lt;<span class="hljs-keyword">Var</span> /&gt;</li></ol></pre>',
    );
    expect(extractCodeText(doc.querySelector("pre")!)).toBe("<Var />");
  });

  it("标准 pre > code 直接取文本", () => {
    const doc = parse("<pre><code>const a = 1;</code></pre>");
    expect(extractCodeText(doc.querySelector("pre")!)).toBe("const a = 1;");
  });

  it("pre 内纯文本也能取出", () => {
    const doc = parse("<pre>plain code</pre>");
    expect(extractCodeText(doc.querySelector("pre")!)).toBe("plain code");
  });
});

describe("语言识别", () => {
  it("带 hljs 标记时不输出语言（自动识别结果不可信）", () => {
    const doc = parse('<pre class="hljs language-vbnet" data-highlighted="yes"><code>x</code></pre>');
    expect(detectLanguage(doc.querySelector("pre")!)).toBeNull();
  });

  it("作者显式声明时保留语言", () => {
    const doc = parse('<pre class="language-python"><code>x</code></pre>');
    expect(detectLanguage(doc.querySelector("pre")!)).toBe("python");
  });

  it("code 上的 language 类被识别", () => {
    const doc = parse('<pre><code class="language-rust">x</code></pre>');
    expect(detectLanguage(doc.querySelector("pre")!)).toBe("rust");
  });
});

describe("normalizeCodeBlocks", () => {
  it("把 ol/li 结构改写为 pre > code", () => {
    const doc = parse(REAL_WORLD_CODE);
    unwrapCodeBlockWrappers(doc);
    normalizeCodeBlocks(doc);

    const pre = doc.querySelector("pre")!;
    expect(pre.children.length).toBe(1);
    expect(pre.firstElementChild!.tagName).toBe("CODE");
    expect(pre.textContent).toContain("<Var");
    expect(pre.textContent).toContain('<Text x="40" />');
    expect(pre.querySelector("ol")).toBeNull();
    expect(pre.querySelector("span")).toBeNull();
  });

  it("已是标准结构且内容一致时保持原样", () => {
    const doc = parse("<pre><code>const a = 1;</code></pre>");
    normalizeCodeBlocks(doc);
    const pre = doc.querySelector("pre")!;
    expect(pre.children.length).toBe(1);
    expect(pre.textContent).toBe("const a = 1;");
  });
});

describe("端到端：装饰性容器内的代码块", () => {
  it("代码块不再被 Readability 删除", () => {
    const extracted = extractContent(page(REAL_WORLD_CODE), PAGE_URL);
    expect(extracted).not.toBeNull();
    expect(extracted!.contentHtml).toContain("<pre");
    expect(extracted!.contentHtml).toContain("&lt;Var");
  });

  it("代码块转换为围栏代码块，且不带误判的语言标注", async () => {
    const extracted = extractContent(page(REAL_WORLD_CODE), PAGE_URL)!;
    const md = await toMarkdown(extracted.contentHtml, PAGE_URL, { imageStrategy: "remote" });

    expect(md).toContain("```");
    expect(md).toContain("<Var");
    expect(md).toContain('<Text x="40" />');
    // hljs 把 XML 主题代码误判为 vbnet/perl，不应写进 Markdown
    expect(md).not.toContain("```vbnet");
    expect(md).not.toContain("```perl");
  });

  it("代码内容完整保留在围栏块内，未被当作 HTML 解析", async () => {
    const extracted = extractContent(page(REAL_WORLD_CODE), PAGE_URL)!;
    const md = await toMarkdown(extracted.contentHtml, PAGE_URL, { imageStrategy: "remote" });

    const lines = md.split("\n");
    const open = lines.findIndex((line) => line.trim() === "```");
    expect(open, "未找到代码块起始围栏").toBeGreaterThanOrEqual(0);

    const close = lines.findIndex((line, i) => i > open && line.trim() === "```");
    expect(close, "未找到代码块结束围栏").toBeGreaterThan(open);

    const block = lines.slice(open + 1, close).join("\n");
    // 尖括号在围栏块内应保持字面量，不得被解析成 HTML 元素
    expect(block).toContain('<Var name="" />');
    expect(block).toContain('<Text x="40" />');
  });
});
