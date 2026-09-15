import { describe, expect, it } from "vitest";

import { mergeUrls, parseUrls } from "../../src/services/urlInput";

describe("parseUrls", () => {
  it("一行一个 URL", () => {
    expect(parseUrls("https://a.com\nhttps://b.com")).toEqual([
      "https://a.com",
      "https://b.com",
    ]);
  });

  it("兼容 Windows 换行", () => {
    expect(parseUrls("https://a.com\r\nhttps://b.com")).toEqual([
      "https://a.com",
      "https://b.com",
    ]);
  });

  it("忽略空行与纯空白行", () => {
    expect(parseUrls("\n\n  \nhttps://a.com\n\n\t\n")).toEqual(["https://a.com"]);
  });

  it("去除每行首尾空白", () => {
    expect(parseUrls("  https://a.com  \n\thttps://b.com\t")).toEqual([
      "https://a.com",
      "https://b.com",
    ]);
  });

  it("空输入返回空数组", () => {
    expect(parseUrls("")).toEqual([]);
    expect(parseUrls("\n\n\n")).toEqual([]);
  });

  it("保留 URL 内部的空白以外的字符", () => {
    expect(parseUrls("https://e.com/a?b=1&c=2#frag")).toEqual([
      "https://e.com/a?b=1&c=2#frag",
    ]);
  });
});

describe("mergeUrls", () => {
  it("合并已有内容与新增内容", () => {
    const result = mergeUrls("https://a.com", "https://b.com", 10);
    expect(result.urls).toEqual(["https://a.com", "https://b.com"]);
    expect(result.overLimit).toBe(false);
  });

  it("恰好达到上限时不报超限", () => {
    const nine = Array.from({ length: 9 }, (_, i) => `https://e.com/${i}`).join("\n");
    const result = mergeUrls(nine, "https://e.com/10", 10);
    expect(result.urls).toHaveLength(10);
    expect(result.overLimit).toBe(false);
  });

  it("超过上限时标记超限但不截断", () => {
    const ten = Array.from({ length: 10 }, (_, i) => `https://e.com/${i}`).join("\n");
    const result = mergeUrls(ten, "https://e.com/extra", 10);
    // 文档第 16 条：不得静默截断，必须保留全部内容以便提示用户
    expect(result.urls).toHaveLength(11);
    expect(result.overLimit).toBe(true);
  });

  it("空行不占用名额", () => {
    const ten = Array.from({ length: 10 }, (_, i) => `https://e.com/${i}`).join("\n");
    const result = mergeUrls(ten, "\n\n  \n", 10);
    expect(result.urls).toHaveLength(10);
    expect(result.overLimit).toBe(false);
  });

  it("已有内容为空时等同于解析新增内容", () => {
    expect(mergeUrls("", "https://a.com\nhttps://b.com", 10).urls).toEqual([
      "https://a.com",
      "https://b.com",
    ]);
  });
});
