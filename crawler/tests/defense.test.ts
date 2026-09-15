import { describe, expect, it } from "vitest";

import {
  detectDefense,
  isDefenseMechanism,
  looksLikeClientRendered,
} from "../src/domain/defense.js";

describe("detectDefense", () => {
  it("429 识别为限流并保留 Retry-After", () => {
    const signal = detectDefense(429, "", { "retry-after": "120" });
    expect(signal?.kind).toBe("RateLimited");
    expect(signal?.evidence).toContain("120");
  });

  it("403 识别为访问拒绝", () => {
    expect(detectDefense(403, "<html></html>")?.kind).toBe("AccessDenied");
  });

  it("451 识别为访问拒绝", () => {
    expect(detectDefense(451, "")?.kind).toBe("AccessDenied");
  });

  it("识别 reCAPTCHA", () => {
    const html = '<script src="https://www.google.com/recaptcha/api.js"></script>';
    expect(detectDefense(200, html)?.kind).toBe("CaptchaDetected");
  });

  it("识别 hCaptcha", () => {
    const html = '<script src="https://hcaptcha.com/1/api.js"></script>';
    expect(detectDefense(200, html)?.kind).toBe("CaptchaDetected");
  });

  it("识别 Cloudflare Turnstile", () => {
    const html = '<div class="cf-turnstile" data-sitekey="x"></div>';
    expect(detectDefense(200, html)?.kind).toBe("CaptchaDetected");
  });

  it("识别 Cloudflare Challenge（响应头）", () => {
    const signal = detectDefense(200, "<html></html>", { "cf-mitigated": "challenge" });
    expect(signal?.kind).toBe("ChallengeDetected");
    expect(signal?.evidence).toContain("cf-mitigated");
  });

  it("识别 Cloudflare 等待页", () => {
    const html = "<html><head><title>Just a moment...</title></head><body></body></html>";
    expect(detectDefense(200, html)?.kind).toBe("ChallengeDetected");
  });

  it("识别浏览器检查页", () => {
    const html = "<p>Checking your browser before accessing example.com</p>";
    expect(detectDefense(200, html)?.kind).toBe("ChallengeDetected");
  });

  it("识别 DDoS 防护页", () => {
    expect(detectDefense(200, "DDoS protection by Example")?.kind).toBe("ChallengeDetected");
  });

  it("正常页面不误报", () => {
    const html = "<html><head><title>正常文章</title></head><body><p>正文</p></body></html>";
    expect(detectDefense(200, html)).toBeNull();
  });

  it("普通 404 不视为防御机制", () => {
    expect(detectDefense(404, "Not Found")).toBeNull();
  });

  it("提到验证码一词的普通文章不误报", () => {
    // 仅出现文字、没有验证码资源或容器时不应判定为验证码页
    const html = "<article><p>本文介绍如何设计一个 captcha 系统的原理与历史。</p></article>";
    expect(detectDefense(200, html)).toBeNull();
  });

  it("防御机制判定与错误类型一致", () => {
    expect(isDefenseMechanism("CaptchaDetected")).toBe(true);
    expect(isDefenseMechanism("ChallengeDetected")).toBe(true);
    expect(isDefenseMechanism("AccessDenied")).toBe(true);
    expect(isDefenseMechanism("RateLimited")).toBe(false);
    expect(isDefenseMechanism("NetworkError")).toBe(false);
  });
});

describe("looksLikeClientRendered", () => {
  it("正文充足时不需要浏览器", () => {
    const long = "字".repeat(500);
    expect(looksLikeClientRendered("<html><body><p>x</p></body></html>", long)).toBe(false);
  });

  it("正文不足且存在 SPA 根容器时需要浏览器", () => {
    const html = '<html><body><div id="root"></div><script type="module"></script></body></html>';
    expect(looksLikeClientRendered(html, "")).toBe(true);
  });

  it("识别 Next.js 与 Nuxt 的根容器", () => {
    expect(looksLikeClientRendered('<div id="__next"></div>', "")).toBe(true);
    expect(looksLikeClientRendered('<div id="__nuxt"></div>', "")).toBe(true);
    expect(looksLikeClientRendered("<script>window.__NEXT_DATA__={}</script>", "")).toBe(true);
  });

  it("正文不足且脚本众多时需要浏览器", () => {
    const html = "<script></script><script></script><script></script>";
    expect(looksLikeClientRendered(html, "")).toBe(true);
  });

  it("无脚本信号的短页面不判定需要浏览器", () => {
    // 渲染这种页面不会产出更多内容；正文不足的情况由调用方按
    // isContentSufficient 判断后另行尝试渲染
    expect(looksLikeClientRendered("<html><body><p>短</p></body></html>", "短")).toBe(false);
  });
});
