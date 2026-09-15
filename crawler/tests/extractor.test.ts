import { describe, expect, it } from "vitest";

import {
  extractContent,
  isContentSufficient,
  MIN_CONTENT_LENGTH,
  stripDuplicateLeadingHeading,
} from "../src/extractor/readability.js";

const filler =
  "<p>" + "这是一段足够长的正文内容，用于通过正文提取的判定阈值。".repeat(10) + "</p>";

function page(title: string, body: string): string {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>${title}</title></head><body><article>${body}</article></body></html>`;
}

describe("extractContent", () => {
  it("提取正文与标题", () => {
    const result = extractContent(page("示例标题", `<h1>示例标题</h1>${filler}`), "http://x.test/a");
    expect(result).not.toBeNull();
    expect(result?.title).toContain("示例标题");
    expect(result?.textContent.length).toBeGreaterThan(100);
  });

  it("内容不足时返回的结果不满足充分性判定", () => {
    const result = extractContent(page("短", "<p>太短</p>"), "http://x.test/a");
    expect(isContentSufficient(result)).toBe(false);
  });

  it("正文长度达到阈值时判定为充分", () => {
    const long = "字".repeat(MIN_CONTENT_LENGTH + 50);
    const result = extractContent(page("长文", `<p>${long}</p>`), "http://x.test/a");
    expect(isContentSufficient(result)).toBe(true);
  });

  it("无法解析的 HTML 不会抛出异常", () => {
    expect(() => extractContent("<<<>>>", "http://x.test/a")).not.toThrow();
  });
});

describe("stripDuplicateLeadingHeading", () => {
  it("首标题与文档标题相同时被移除", () => {
    const html = `<h2>示例标题</h2>${filler}`;
    const out = stripDuplicateLeadingHeading(html, ["示例标题"]);
    expect(out).not.toContain("<h2>");
    expect(out).toContain("这是一段足够长的正文内容");
  });

  it("首标题与文档标题不同时保留", () => {
    const html = `<h2>完全不同的标题</h2>${filler}`;
    const out = stripDuplicateLeadingHeading(html, ["示例标题"]);
    expect(out).toContain("完全不同的标题");
  });

  it("文档标题以「首标题 + 分隔符」开头时视为重复", () => {
    for (const separator of ["|", "·", "—", "-", "::"]) {
      const html = `<h2>使用指南</h2>${filler}`;
      const out = stripDuplicateLeadingHeading(html, [`使用指南 ${separator} 站点名`]);
      expect(out, `分隔符 ${separator} 未命中`).not.toContain("<h2>");
    }
  });

  it("只移除第一个重复标题，保留后续同名标题", () => {
    const html = `<h2>示例标题</h2>${filler}<h2>示例标题</h2>${filler}`;
    const out = stripDuplicateLeadingHeading(html, ["示例标题"]);
    expect(out.match(/<h2>/g)?.length).toBe(1);
  });

  it("首标题之前若已有正文则不视为文章标题", () => {
    const html = `${filler}<h2>示例标题</h2>${filler}`;
    const out = stripDuplicateLeadingHeading(html, ["示例标题"]);
    expect(out).toContain("<h2>示例标题</h2>");
  });

  it("标题比对忽略空白与大小写", () => {
    const html = `<h2>  Example   Title  </h2>${filler}`;
    expect(stripDuplicateLeadingHeading(html, ["example title"])).not.toContain("<h2>");
  });

  it("没有标题的正文不受影响", () => {
    const html = filler;
    expect(stripDuplicateLeadingHeading(html, ["示例标题"])).toBe(html);
  });

  it("空标题列表时不改变内容", () => {
    const html = `<h2>示例标题</h2>${filler}`;
    expect(stripDuplicateLeadingHeading(html, [])).toBe(html);
  });

  it("保留正文标题的原始层级（h3-h6 不受影响）", () => {
    const html = `<h2>示例标题</h2>${filler}<h3>三级</h3>${filler}<h4>四级</h4>${filler}`;
    const out = stripDuplicateLeadingHeading(html, ["示例标题"]);
    expect(out).toContain("<h3>三级</h3>");
    expect(out).toContain("<h4>四级</h4>");
    expect(out).not.toContain("<h2>示例标题</h2>");
  });
});

describe("端到端：标题层级还原", () => {
  it("h1 降级产生的重复标题被去除，其余层级保持原样", () => {
    const html = page(
      "示例标题",
      `<h1>示例标题</h1>${filler}<h2>二级标题</h2>${filler}<h3>三级标题</h3>${filler}`,
    );
    const result = extractContent(html, "http://x.test/a");
    expect(result).not.toBeNull();

    const content = result!.contentHtml;
    // Readability 把 h1 映射为 h2，该重复标题应被移除
    expect(content).not.toMatch(/<h[12][^>]*>示例标题<\/h[12]>/);
    // 原文的 h2、h3 保持原层级
    expect(content).toMatch(/<h2[^>]*>二级标题<\/h2>/);
    expect(content).toMatch(/<h3[^>]*>三级标题<\/h3>/);
  });
});
