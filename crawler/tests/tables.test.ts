import { describe, expect, it } from "vitest";

import { extractContent } from "../src/extractor/readability.js";
import { toMarkdown } from "../src/markdown/convert.js";
import { promoteTableHeaders } from "../src/markdown/tables.js";

/**
 * 回归测试。
 *
 * 曾出现过的问题：文档站的表格普遍写作
 * `<table><tbody><tr><td>参数</td><td>说明</td></tr>...` —— 表头行用 `<td>`
 * 且没有 `<thead>`。Turndown 的 GFM 表格规则要求首行是 `<th>`，否则放弃转换、
 * 整张表以原始 HTML 输出，文档第 13 条要求的「保留表格」实际失效。
 */

/** 取自真实文档页的表格结构（表头行是 td、带 id 属性、单元格内有 p 包裹）。 */
const REAL_WORLD_TABLE = `<table id="ZH-CN_TOPIC_1__table103591574327"><tbody><tr id="ZH-CN_TOPIC_1__row173771577323"><td><p id="ZH-CN_TOPIC_1__p20377057123212"><strong>参数</strong></p></td><td><p id="ZH-CN_TOPIC_1__p143771577320"><strong>注释</strong></p></td></tr><tr id="ZH-CN_TOPIC_1__row1137745743218"><td><p id="ZH-CN_TOPIC_1__p4971243162713">touch_x</p></td><td><p id="ZH-CN_TOPIC_1__p797143112711">当前触摸点的x坐标</p></td></tr></tbody></table>`;

describe("promoteTableHeaders", () => {
  it("无表格时原样返回", () => {
    const html = "<h2>标题</h2><p>正文</p>";
    expect(promoteTableHeaders(html)).toBe(html);
  });

  it("把首行 td 提升为 th", () => {
    const out = promoteTableHeaders(REAL_WORLD_TABLE);
    expect(out).toContain("<thead>");
    expect(out).toMatch(/<th>\s*<strong>参数<\/strong>\s*<\/th>/);
    expect(out).toMatch(/<th>\s*<strong>注释<\/strong>\s*<\/th>/);
  });

  it("数据行保持为 td", () => {
    const out = promoteTableHeaders(REAL_WORLD_TABLE);
    expect(out).toMatch(/<td>\s*touch_x\s*<\/td>/);
    expect(out).toMatch(/<td>\s*当前触摸点的x坐标\s*<\/td>/);
  });

  it("去掉单元格内唯一的 p 包裹", () => {
    // <p> 是块级元素，保留会在 Markdown 表格行中插入换行
    const out = promoteTableHeaders(REAL_WORLD_TABLE);
    expect(out).not.toContain("<p>");
    expect(out).not.toContain("<p ");
  });

  it("单元格含多个段落时保留结构", () => {
    const html =
      "<table><tbody><tr><td>头</td></tr><tr><td><p>第一段</p><p>第二段</p></td></tr></tbody></table>";
    const out = promoteTableHeaders(html);
    expect(out).toContain("第一段");
    expect(out).toContain("第二段");
    expect(out.match(/<p>/g)?.length).toBe(2);
  });

  it("清理表格内部的 id 属性", () => {
    const out = promoteTableHeaders(REAL_WORLD_TABLE);
    expect(out).not.toContain("id=");
    expect(out).not.toContain("ZH-CN_TOPIC_1");
  });

  it("已有 thead 的表格不被改动结构", () => {
    const html =
      "<table><thead><tr><th>甲</th></tr></thead><tbody><tr><td>1</td></tr></tbody></table>";
    const out = promoteTableHeaders(html);
    expect(out.match(/<thead>/g)?.length).toBe(1);
    expect(out).toContain("<th>甲</th>");
  });

  it("首行已是 th 的表格不被改动", () => {
    const html = "<table><tr><th>甲</th></tr><tr><td>1</td></tr></table>";
    const out = promoteTableHeaders(html);
    // 首行本来就是 th，GFM 规则可直接转换，无需补 thead
    expect(out).toContain("<th>甲</th>");
    expect(out).toContain("<td>1</td>");
  });

  it("多张表格都被处理", () => {
    const html = REAL_WORLD_TABLE + REAL_WORLD_TABLE.replace("103591574327", "999");
    const out = promoteTableHeaders(html);
    expect(out.match(/<thead>/g)?.length).toBe(2);
  });

  it("嵌套表格保持原样", () => {
    const html =
      "<table><tbody><tr><td>外1</td><td>外2</td></tr><tr><td><table><tbody><tr><td>内1</td><td>内2</td></tr></tbody></table></td><td>x</td></tr></tbody></table>";
    const out = promoteTableHeaders(html);
    // 外层表格被正规化，内层不动
    expect(out.match(/<thead>/g)?.length).toBe(1);
  });

  it("无法解析的输入不抛异常", () => {
    expect(() => promoteTableHeaders("<table><tr>")).not.toThrow();
  });
});

describe("端到端：表格转换为 Markdown", () => {
  const BASE = "https://example.com/a";

  it("表头行用 td 的表格被正确转换", async () => {
    const md = await toMarkdown(REAL_WORLD_TABLE, BASE, { imageStrategy: "remote" });

    expect(md).not.toContain("<table");
    expect(md).not.toContain("id=");
    // 原文表头是 <strong>，加粗应当保留
    expect(md).toContain("| **参数** | **注释** |");
    // 下划线被 Turndown 转义，这是正确行为
    expect(md).toContain("| touch\\_x | 当前触摸点的x坐标 |");
    expect(md).toMatch(/^\|\s*-+\s*\|\s*-+\s*\|$/m);
  });

  it("表头单元格不产生多余换行", async () => {
    const md = await toMarkdown(REAL_WORLD_TABLE, BASE, { imageStrategy: "remote" });

    // 回归：单元格内的 <p> 曾把一行表格拆成多行
    const tableLines = md.split("\n").filter((line) => line.trim().length > 0);
    expect(tableLines).toHaveLength(3);
    for (const line of tableLines) {
      expect(line.startsWith("|") && line.endsWith("|"), `表格行格式异常: ${line}`).toBe(true);
      expect(line.split("|").length, `列数异常: ${line}`).toBe(4);
    }
  });

  it("带 thead 的表格转换结果不变", async () => {
    const html =
      "<table><thead><tr><th>甲</th><th>乙</th></tr></thead><tbody><tr><td>1</td><td>2</td></tr></tbody></table>";
    const md = await toMarkdown(html, BASE, { imageStrategy: "remote" });
    expect(md).toContain("| 甲 | 乙 |");
    expect(md).toContain("| 1 | 2 |");
  });

  it("多行多列表格保持结构", async () => {
    const html =
      "<table><tbody><tr><td>H1</td><td>H2</td><td>H3</td></tr><tr><td>a</td><td>b</td><td>c</td></tr><tr><td>d</td><td>e</td><td>f</td></tr></tbody></table>";
    const md = await toMarkdown(html, BASE, { imageStrategy: "remote" });
    expect(md).toContain("| H1 | H2 | H3 |");
    expect(md).toContain("| a | b | c |");
    expect(md).toContain("| d | e | f |");
  });

  it("表格中的链接与行内代码被保留，且相对地址被解析为绝对地址", async () => {
    // 走完整管线：Readability 负责把相对地址补成绝对地址。
    // 表格需保持较低的链接密度，否则会被 Readability 当作导航表格剔除。
    const rows = Array.from(
      { length: 6 },
      (_, i) => `<tr><td>字段${i}</td><td>这是第 ${i} 行的说明文字，不含链接。</td></tr>`,
    ).join("");

    const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>表格页</title></head><body><article>
      <h1>表格页</h1>
      <p>${"补充正文内容以使提取阈值达成。".repeat(20)}</p>
      <table><tbody><tr><td>项</td><td>值</td></tr>${rows}<tr><td>文档</td><td><a href="/doc">链接</a> 与 <code>code</code></td></tr></tbody></table>
      <p>${"补充正文内容以使提取阈值达成。".repeat(20)}</p>
    </article></body></html>`;

    const extracted = extractContent(html, BASE);
    expect(extracted).not.toBeNull();
    expect(extracted!.contentHtml).toContain("<table");

    const md = await toMarkdown(extracted!.contentHtml, BASE, { imageStrategy: "remote" });
    expect(md).toContain("[链接](https://example.com/doc)");
    expect(md).toContain("`code`");
    expect(md).not.toContain("<table");
  });

  it("表格中的中文表头不被破坏", async () => {
    const html =
      "<table><tbody><tr><td>参数名称</td><td>取值范围</td></tr><tr><td>month</td><td>0~11</td></tr></tbody></table>";
    const md = await toMarkdown(html, BASE, { imageStrategy: "remote" });
    expect(md).toContain("| 参数名称 | 取值范围 |");
    expect(md).toContain("| month | 0~11 |");
  });
});
