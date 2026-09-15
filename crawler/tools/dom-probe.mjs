/**
 * 诊断：文档页渲染后的 DOM 里，页面的标题究竟以什么形式存在。
 *
 * 用于解释「所有页面标题相同」——即 `<title>` 是站点级的、而正文里没有 h1
 * 时，标题该从哪里取。
 */

import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(here, "..");
const { chromium } = await import("playwright");

const url = process.argv[2];
if (!url) {
  console.log("用法: node tools/dom-probe.mjs <URL>");
  process.exit(1);
}

const browser = await chromium.launch({ headless: true, channel: "chromium" });
const page = await browser.newPage();
await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
await page.waitForTimeout(4500);

const info = await page.evaluate(() => {
  const clean = (s) => (s || "").replace(/\s+/g, " ").trim();

  const headings = [...document.querySelectorAll("h1,h2,h3,h4,h5,h6")].slice(0, 12).map((h) => ({
    tag: h.tagName.toLowerCase(),
    text: clean(h.textContent).slice(0, 60),
    cls: String(h.className).slice(0, 50),
  }));

  // 页面里最靠上的、字数适中的粗体/大字号块，往往是真正的页面标题
  const candidates = [];
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT);
  let n;
  let visited = 0;
  while ((n = walker.nextNode()) && visited < 4000) {
    visited++;
    const el = n;
    if (!el.offsetParent) continue;
    const text = clean(el.textContent);
    if (text.length < 2 || text.length > 80) continue;
    if (el.children.length > 2) continue;

    const cs = getComputedStyle(el);
    const size = parseFloat(cs.fontSize);
    const weight = parseInt(cs.fontWeight, 10) || 400;
    if (size >= 18 || weight >= 600) {
      const r = el.getBoundingClientRect();
      candidates.push({
        tag: el.tagName.toLowerCase(),
        text: text.slice(0, 60),
        fontSize: Math.round(size),
        weight,
        top: Math.round(r.top),
        cls: String(el.className).slice(0, 44),
      });
    }
  }
  candidates.sort((a, b) => a.top - b.top);

  return {
    title: document.title,
    headings,
    topCandidates: candidates.slice(0, 10),
  };
});

await browser.close();

console.log("网页 <title> :", info.title);
console.log("");
console.log("=== 页面中的标题元素 ===");
if (info.headings.length === 0) console.log("  (没有任何 h1-h6)");
for (const h of info.headings) console.log(`  ${h.tag}  「${h.text}」  class=${h.cls}`);

console.log("");
console.log("=== 位置靠上的大字号 / 粗体文本（可能是真正的页面标题）===");
for (const c of info.topCandidates) {
  console.log(`  y=${String(c.top).padStart(5)}  ${c.tag}(${c.fontSize}px/${c.weight})  「${c.text}」`);
}
