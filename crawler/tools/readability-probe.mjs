/**
 * 诊断：Readability 是否把页面自己的 h1 当作「与标题重复」删掉了。
 *
 * 对比三处：
 *   1. 渲染后 DOM 里的 h1（页面真正的标题）
 *   2. Readability 的 article.title（取自 <title>）
 *   3. Readability 的 article.content 里是否还有那个 h1
 */

import path from "node:path";
import { fileURLToPath } from "node:url";
import { JSDOM } from "jsdom";
import { Readability } from "@mozilla/readability";

const here = path.dirname(fileURLToPath(import.meta.url));
const { chromium } = await import("playwright");

const url = process.argv[2];
if (!url) {
  console.log("用法: node tools/readability-probe.mjs <URL>");
  process.exit(1);
}

const browser = await chromium.launch({ headless: true, channel: "chromium" });
const page = await browser.newPage();
await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
await page.waitForTimeout(4500);
const html = await page.content();
await browser.close();

// 渲染后 DOM 里的 h1
const dom = new JSDOM(html, { url });
const docH1 = [...dom.window.document.querySelectorAll("h1")].map((h) =>
  (h.textContent || "").replace(/\s+/g, " ").trim(),
);
const docTitle = dom.window.document.title;

// 交给 Readability（用全新文档，避免前一实例被改动）
const dom2 = new JSDOM(html, { url });
const article = new Readability(dom2.window.document, { charThreshold: 100 }).parse();
dom.window.close();
dom2.window.close();

console.log("网页 <title>            :", docTitle);
console.log("渲染后 DOM 里的 h1      :", docH1.length ? docH1.join(" | ") : "(无)");
console.log("");
console.log("Readability article.title:", article ? article.title : "(解析失败)");
const content = article?.content ?? "";
console.log("article.content 含该 h1  :", docH1.length && content.includes(docH1[0]) ? "是" : "否（已被删除）");
console.log("article.content 含 h2    :", /<h2/i.test(content) ? "是" : "否");
console.log("article.content 前 160 字符:");

// 去掉标签后看正文开头
const text = content.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
console.log("  ", text.slice(0, 160));
