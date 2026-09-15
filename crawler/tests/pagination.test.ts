import { describe, expect, it } from "vitest";

import { findNextPage, type PaginationContext } from "../src/task/pagination.js";

const CURRENT = "https://example.com/article?page=1";

function context(overrides: Partial<PaginationContext> = {}): PaginationContext {
  return {
    visited: new Set<string>(),
    isSameSite: () => true,
    normalize: (url: string) => url,
    ...overrides,
  };
}

function page(body: string): string {
  return `<!doctype html><html><body>${body}</body></html>`;
}

describe("findNextPage", () => {
  it("优先识别 link rel=next", () => {
    const html = page(
      '<link rel="next" href="/article?page=2"><a href="/other">下一页</a>',
    );
    const match = findNextPage(html, CURRENT, context());
    expect(match?.url).toContain("/article?page=2");
    expect(match?.evidence).toContain("link");
  });

  it("识别 a rel=next", () => {
    const html = page('<a rel="next" href="/article?page=2">继续</a>');
    expect(findNextPage(html, CURRENT, context())?.url).toContain("/article?page=2");
  });

  it("识别文本为「下一页」的分页链接", () => {
    const html = page('<nav class="pagination"><a href="/article?page=2">下一页</a></nav>');
    expect(findNextPage(html, CURRENT, context())?.url).toContain("/article?page=2");
  });

  it("识别英文 Next 与 Next Page", () => {
    for (const text of ["Next", "Next Page", "next"]) {
      const html = page(`<nav class="pager"><a href="/article?page=2">${text}</a></nav>`);
      expect(findNextPage(html, CURRENT, context()), `文本 ${text} 未命中`).not.toBeNull();
    }
  });

  it("分页容器内的 > 符号被识别", () => {
    const html = page('<div class="pagination"><a href="/article?page=2">&gt;</a></div>');
    expect(findNextPage(html, CURRENT, context())?.url).toContain("/article?page=2");
  });

  it("无分页线索的页面不误报符号链接", () => {
    // 正文里的 > 符号链接不应被当成下一页
    const html = page('<p>参见 <a href="/article?page=2">&gt;</a> 处的说明</p>');
    expect(findNextPage(html, CURRENT, context())).toBeNull();
  });

  it("「Next.js 教程」这类普通链接不被误判", () => {
    const html = page('<a href="/nextjs-guide">Next.js 教程</a>');
    expect(findNextPage(html, CURRENT, context())).toBeNull();
  });

  it("已访问过的地址不重复返回", () => {
    const html = page('<nav class="pagination"><a href="/article?page=2">下一页</a></nav>');
    // visited 中存放的是规范化后的绝对地址，与 crawler 的实际用法一致
    const ctx = context({ visited: new Set(["https://example.com/article?page=2"]) });
    expect(findNextPage(html, CURRENT, ctx)).toBeNull();
  });

  it("使用传入的规范化函数判定重复", () => {
    const html = page('<nav class="pagination"><a href="/article?page=2">下一页</a></nav>');
    // 规范化函数去掉查询串，此时不同页码会归为同一地址
    const ctx = context({
      normalize: (url) => url.split("?")[0],
      visited: new Set(["https://example.com/article"]),
    });
    expect(findNextPage(html, CURRENT, ctx)).toBeNull();
  });

  it("跨站链接被拒绝", () => {
    const html = page('<nav class="pagination"><a href="https://other.com/a?page=2">下一页</a></nav>');
    const ctx = context({ isSameSite: (url) => url.includes("example.com") });
    expect(findNextPage(html, CURRENT, ctx)).toBeNull();
  });

  it("指向自身的链接不被采信", () => {
    const html = page('<nav class="pagination"><a href="/article?page=1">下一页</a></nav>');
    expect(findNextPage(html, CURRENT, context())).toBeNull();
  });

  it("非 http 协议的链接被拒绝", () => {
    const html = page('<nav class="pagination"><a href="javascript:void(0)">下一页</a></nav>');
    expect(findNextPage(html, CURRENT, context())).toBeNull();
  });

  it("相对地址按当前 URL 解析为绝对地址", () => {
    const html = page('<nav class="pagination"><a href="?page=2">下一页</a></nav>');
    const match = findNextPage(html, CURRENT, context());
    expect(match?.url).toBe("https://example.com/article?page=2");
  });

  it("没有下一页时返回 null", () => {
    const html = page("<article><p>正文</p></article>");
    expect(findNextPage(html, CURRENT, context())).toBeNull();
  });
});
