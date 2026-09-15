import { describe, expect, it } from "vitest";

import { isBlank, mergeEntries, splitUrls } from "../../src/services/urlInput";

describe("splitUrls", () => {
  it("一行一个链接", () => {
    expect(splitUrls("https://a.com\nhttps://b.com")).toEqual([
      "https://a.com",
      "https://b.com",
    ]);
  });

  it("兼容 Windows 换行", () => {
    expect(splitUrls("https://a.com\r\nhttps://b.com")).toEqual([
      "https://a.com",
      "https://b.com",
    ]);
  });

  it("忽略空行与纯空白行", () => {
    expect(splitUrls("\n\n  \nhttps://a.com\n\n\t\n")).toEqual(["https://a.com"]);
  });

  it("去除每行首尾空白", () => {
    expect(splitUrls("  https://a.com  \n\thttps://b.com\t")).toEqual([
      "https://a.com",
      "https://b.com",
    ]);
  });

  // 回归：把两个链接挤在一行是最常见的输入错误
  it("把一行里的多个链接拆开", () => {
    expect(splitUrls("https://a.com https://b.com")).toEqual(["https://a.com", "https://b.com"]);
    expect(splitUrls("https://a.comhttps://b.com")).toEqual(["https://a.com", "https://b.com"]);
    expect(splitUrls("https://a.com,https://b.com\nhttps://c.com")).toEqual([
      "https://a.com,",
      "https://b.com",
      "https://c.com",
    ]);
  });

  it("一行里混合 http 与 https 也能拆开", () => {
    expect(splitUrls("http://a.com https://b.com")).toEqual(["http://a.com", "https://b.com"]);
  });

  it("无法识别的文本原样保留，交由校验给出原因", () => {
    expect(splitUrls("这不是URL")).toEqual(["这不是URL"]);
    expect(splitUrls("example.com/a")).toEqual(["example.com/a"]);
  });

  it("保留 URL 内部的查询串与锚点", () => {
    expect(splitUrls("https://e.com/a?b=1&c=2#frag")).toEqual(["https://e.com/a?b=1&c=2#frag"]);
  });

  it("空输入返回空数组", () => {
    expect(splitUrls("")).toEqual([]);
    expect(splitUrls("\n\n\n")).toEqual([]);
  });
});

describe("mergeEntries", () => {
  it("并入已有条目", () => {
    const result = mergeEntries(["https://a.com"], "https://b.com", 10);
    expect(result.entries).toEqual(["https://a.com", "https://b.com"]);
    expect(result.overLimit).toBe(false);
  });

  it("恰好达到上限时不报超限", () => {
    const nine = Array.from({ length: 9 }, (_, i) => `https://e.com/${i}`);
    const result = mergeEntries(nine, "https://e.com/10", 10);
    expect(result.entries).toHaveLength(10);
    expect(result.overLimit).toBe(false);
  });

  it("超过上限时标记超限但不截断", () => {
    const ten = Array.from({ length: 10 }, (_, i) => `https://e.com/${i}`);
    const result = mergeEntries(ten, "https://e.com/extra", 10);
    // 必须保留全部内容，才能让用户自己决定删哪一条
    expect(result.entries).toHaveLength(11);
    expect(result.overLimit).toBe(true);
  });

  it("空行不占用名额", () => {
    const ten = Array.from({ length: 10 }, (_, i) => `https://e.com/${i}`);
    const result = mergeEntries(ten, "\n\n  \n", 10);
    expect(result.entries).toHaveLength(10);
    expect(result.overLimit).toBe(false);
  });

  it("一次粘贴多个链接按顺序并入", () => {
    const result = mergeEntries([], "https://a.com https://b.com\nhttps://c.com", 10);
    expect(result.entries).toEqual(["https://a.com", "https://b.com", "https://c.com"]);
  });
});

describe("isBlank", () => {
  it("空串与纯空白视为空", () => {
    expect(isBlank("")).toBe(true);
    expect(isBlank("   ")).toBe(true);
    expect(isBlank("\t\n")).toBe(true);
  });

  it("有内容则不为空", () => {
    expect(isBlank("https://a.com")).toBe(false);
  });
});
