/**
 * 实地诊断：文档站每个页面的标题是否都取了站点级的 `<title>`。
 *
 * 用法：
 *   node tools/title-check.mjs <列表页URL>
 *   node tools/title-check.mjs <文档页URL> <文档页URL> ...
 *
 * 对每个页面输出：网页 <title>、Readability 标题、最终采用的标题、正文首个标题。
 */

import { pathToFileURL } from "node:url";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(here, "..");

const { extractContent } = await import(
  pathToFileURL(path.join(projectRoot, "dist", "extractor", "readability.js")).href
);

const { chromium } = await import("playwright");

const arg = process.argv[2];
if (!arg) {
  console.log("用法: node tools/title-check.mjs <URL> [URL...]");
  process.exit(1);
}

const browser = await chromium.launch({ headless: true, channel: "chromium" });
const page = await browser.newPage();

async function render(url) {
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForTimeout(4000);
  return page.content();
}

/** 列表页：找出同一站点下若干文档页链接。 */
async function discover(listUrl) {
  await page.goto(listUrl, { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForTimeout(4000);

  const hrefs = await page.evaluate(() => {
    const out = [];
    for (const a of document.querySelectorAll("a[href]")) {
      const href = a.href;
      if (!href.startsWith("http")) continue;
      if (/(info|doc|detail|document)/i.test(href) && a.textContent.trim().length > 1) {
        out.push({ href, text: a.textContent.trim().slice(0, 30) });
      }
    }
    return out;
  });

  // 同站点、去掉重复
  const seen = new Set();
  const picked = [];
  for (const h of hrefs) {
    if (new URL(h.href).host !== new URL(listUrl).host) continue;
    const key = h.href.split("#")[0];
    if (seen.has(key)) continue;
    seen.add(key);
    picked.push(h.href);
    if (picked.length >= 3) break;
  }
  return picked;
}

const targets = process.argv.length > 3 ? process.argv.slice(2) : await discover(arg);
if (targets.length === 0) {
  console.log("未从该页发现文档链接，请直接传入文档页 URL。");
  await browser.close();
  process.exit(0);
}

console.log(`拟检查 ${targets.length} 个页面\n`);

const rows = [];
for (const url of targets) {
  try {
    const html = await render(url);
    const r = extractContent(html, url);
    if (!r) {
      rows.push({ url, err: "提取失败" });
      continue;
    }
    const m = r.contentHtml.match(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/i);
    rows.push({
      url,
      docTitle: r.documentTitle,
      used: r.title,
      heading: m ? m[2].replace(/<[^>]+>/g, "").trim() : "(无)",
      textLen: r.textContent.length,
    });
  } catch (e) {
    rows.push({ url, err: String(e).slice(0, 80) });
  }
  await new Promise((r) => setTimeout(r, 1200)); // 低频，避免给站点添麻烦
}

await browser.close();

for (const row of rows) {
  console.log("─".repeat(78));
  console.log("页面      :", row.url.replace(/^https?:\/\/[^/]+/, "").slice(0, 66));
  if (row.err) {
    console.log("  错误    :", row.err);
    continue;
  }
  console.log("  <title> :", row.docTitle || "(空)");
  console.log("  采用标题:", row.used);
  console.log("  正文首标题:", row.heading);
  console.log("  正文字符:", row.textLen);
}

console.log("─".repeat(78));
const used = rows.filter((r) => !r.err).map((r) => r.used);
const unique = new Set(used);
console.log(`\n采用标题去重后：${unique.size} 个不同标题 / 共 ${used.length} 个页面`);
if (unique.size === 1 && used.length > 1) {
  console.log("→ 所有页面标题相同，问题未解决");
} else if (unique.size === used.length) {
  console.log("→ 每个页面各自不同，符合预期");
} else {
  console.log("→ 部分重复，需要进一步查看");
}
