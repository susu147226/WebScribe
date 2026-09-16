/**
 * 诊断：页面里的各级标题，经过提取之后还剩下多少。
 *
 * 分别列出渲染后 DOM 里的 h1-h6、以及提取结果里的标题，直接看出丢了哪些。
 */

import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(here, "..");

const { extractContent } = await import(
  pathToFileURL(path.join(projectRoot, "dist", "extractor", "readability.js")).href
);
const { chromium } = await import("playwright");

const url = process.argv[2];
if (!url) {
  console.log("用法: node tools/heading-probe.mjs <URL>");
  process.exit(1);
}

const browser = await chromium.launch({ headless: true, channel: "chromium" });
const page = await browser.newPage();
await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
await page.waitForTimeout(4500);

const domHeadings = await page.evaluate(() =>
  [...document.querySelectorAll("h1,h2,h3,h4,h5,h6")]
    .filter((h) => h.offsetParent !== null)
    .map((h) => ({
      tag: h.tagName.toLowerCase(),
      text: (h.textContent || "").replace(/\s+/g, " ").trim().slice(0, 60),
    })),
);

const html = await page.content();
await browser.close();

const result = extractContent(html, url);
const outHeadings = result
  ? [...(result.contentHtml.matchAll(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi) ?? [])].map((m) => ({
      tag: `h${m[1]}`,
      text: m[2].replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim().slice(0, 60),
    }))
  : [];

console.log("页面 <title> :", result?.documentTitle ?? "(解析失败)");
console.log("采用标题    :", result?.title ?? "-");
console.log("");
console.log(`渲染后 DOM 里的标题（${domHeadings.length} 个）:`);
for (const h of domHeadings) console.log(`  ${h.tag}  ${h.text}`);

console.log("");
console.log(`提取结果里的标题（${outHeadings.length} 个）:`);
for (const h of outHeadings) console.log(`  ${h.tag}  ${h.text}`);

console.log("");
const keptTexts = new Set(outHeadings.map((h) => h.text));
const usedAsTitle = result?.title ?? "";
const lost = domHeadings.filter((h) => !keptTexts.has(h.text));
console.log(`丢失的标题（${lost.length} 个）:`);
for (const h of lost) {
  const asTitle = h.text && usedAsTitle.includes(h.text) ? "  ← 被当作文档标题" : "";
  console.log(`  ${h.tag}  ${h.text}${asTitle}`);
}
