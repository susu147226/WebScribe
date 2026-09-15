import { describe, expect, it } from "vitest";

import { cookieHeaderFor, domainMatches, hasLoginState, type StoredCookie } from "../src/auth.js";

function cookie(overrides: Partial<StoredCookie> = {}): StoredCookie {
  return {
    name: "sid",
    value: "abc",
    domain: "example.com",
    path: "/",
    ...overrides,
  };
}

describe("domainMatches", () => {
  it("主机名完全一致时匹配", () => {
    expect(domainMatches("example.com", "example.com")).toBe(true);
  });

  it("子域匹配以点开头的域", () => {
    expect(domainMatches("www.example.com", ".example.com")).toBe(true);
    expect(domainMatches("example.com", ".example.com")).toBe(true);
  });

  it("不匹配相似但无关的域名", () => {
    expect(domainMatches("notexample.com", ".example.com")).toBe(false);
    expect(domainMatches("example.com.evil.net", ".example.com")).toBe(false);
  });

  it("无点前缀时要求完全一致", () => {
    expect(domainMatches("www.example.com", "example.com")).toBe(false);
  });

  it("忽略大小写", () => {
    expect(domainMatches("WWW.Example.COM", ".example.com")).toBe(true);
  });
});

describe("cookieHeaderFor", () => {
  it("构造 Cookie 请求头", () => {
    expect(cookieHeaderFor([cookie()], "https://example.com/a")).toBe("sid=abc");
  });

  it("多个 Cookie 以分号连接", () => {
    const cookies = [cookie({ name: "a", value: "1" }), cookie({ name: "b", value: "2" })];
    expect(cookieHeaderFor(cookies, "https://example.com/a")).toBe("a=1; b=2");
  });

  it("不把 Cookie 发给无关站点", () => {
    expect(cookieHeaderFor([cookie()], "https://other.com/a")).toBeUndefined();
  });

  it("尊重路径前缀", () => {
    const c = cookie({ path: "/admin" });
    expect(cookieHeaderFor([c], "https://example.com/admin/x")).toBe("sid=abc");
    expect(cookieHeaderFor([c], "https://example.com/public/x")).toBeUndefined();
  });

  it("Secure Cookie 不通过 http 发送", () => {
    const c = cookie({ secure: true });
    expect(cookieHeaderFor([c], "https://example.com/a")).toBe("sid=abc");
    expect(cookieHeaderFor([c], "http://example.com/a")).toBeUndefined();
  });

  it("已过期的 Cookie 被忽略", () => {
    const past = Math.floor(Date.now() / 1000) - 3600;
    expect(cookieHeaderFor([cookie({ expires: past })], "https://example.com/a")).toBeUndefined();
  });

  it("未过期的 Cookie 被使用", () => {
    const future = Math.floor(Date.now() / 1000) + 3600;
    expect(cookieHeaderFor([cookie({ expires: future })], "https://example.com/a")).toBe("sid=abc");
  });

  it("expires 为 -1 的会话 Cookie 仍有效", () => {
    expect(cookieHeaderFor([cookie({ expires: -1 })], "https://example.com/a")).toBe("sid=abc");
  });

  it("无可用 Cookie 时返回 undefined", () => {
    expect(cookieHeaderFor([], "https://example.com/a")).toBeUndefined();
  });

  it("非法 URL 返回 undefined", () => {
    expect(cookieHeaderFor([cookie()], "不是URL")).toBeUndefined();
  });
});

describe("hasLoginState", () => {
  it("有可用 Cookie 时为真", () => {
    expect(hasLoginState([cookie()], "https://example.com/a")).toBe(true);
  });

  it("无可用 Cookie 时为假", () => {
    expect(hasLoginState([cookie()], "https://other.com/a")).toBe(false);
  });
});
