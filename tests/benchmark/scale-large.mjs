/**
 * 大页面下的链接数量压测。
 *
 * 上一次压测用的 fixture 页面只产出约 1 KB Markdown，不足以回答「链接变多会不会
 * 吃内存」。这里换成三种页面体量，观察 Node 侧内存是否随「链接数 × 页面体积」增长。
 *
 * 注意：本脚本只测 Node（crawler）进程。结果累积发生在 Rust 侧，其占用可由
 * 「总正文体积」直接推算，不在此测量范围内。
 *
 * 用法：node tests/benchmark/scale-large.mjs
 */

import { spawn, execSync } from "node:child_process";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, "..", "..");
const NODE_EXE = path.join(PROJECT_ROOT, "runtime", "node", "node.exe");
const CRAWLER_ENTRY = path.join(PROJECT_ROOT, "crawler", "dist", "index.js");
const BROWSERS_DIR = path.join(PROJECT_ROOT, "runtime", "browsers");

/**
 * 构造一个正文体量可控的文章页。
 *
 * @param repeat 段落重复次数，粗略控制产出 Markdown 的体积
 */
function articlePage(repeat) {
  const paragraph =
    "这是用于压测的正文段落。它需要足够长，以便通过正文提取的判定阈值，" +
    "并让结果具备与实际文档页相当的体量。段落中混合中英文与数字 1234567890，" +
    "以及一些标点符号，用于模拟真实的文本密度与字符分布。";

  const body = Array.from(
    { length: repeat },
    (_, i) => `<h3>小节 ${i + 1}</h3><p>${paragraph}</p>`,
  ).join("\n");

  return `<!doctype html>
<html lang="zh-CN">
<head><meta charset="utf-8"><title>压测页面</title></head>
<body>
<nav><a href="/">首页</a></nav>
<article>
<h1>压测页面</h1>
${body}
</article>
<footer><p>页脚</p></footer>
</body>
</html>`;
}

/** 采样进程工作集。 */
function startMemoryProbe(pid) {
  let peak = 0;
  const timer = setInterval(() => {
    try {
      const out = execSync(`tasklist /FI "PID eq ${pid}" /FO CSV /NH`, {
        encoding: "utf8",
        windowsHide: true,
      });
      const match = out.match(/"([\d,]+) K"/);
      if (match) {
        const bytes = Number(match[1].replace(/,/g, "")) * 1024;
        if (bytes > peak) peak = bytes;
      }
    } catch {
      // 进程已退出
    }
  }, 250);

  return {
    stop() {
      clearInterval(timer);
      return peak;
    },
  };
}

async function runOnce(baseUrl, count, pagePath) {
  const child = spawn(NODE_EXE, [CRAWLER_ENTRY], {
    cwd: path.join(PROJECT_ROOT, "crawler", "dist"),
    env: {
      ...process.env,
      PLAYWRIGHT_BROWSERS_PATH: BROWSERS_DIR,
      PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: "1",
    },
    stdio: ["pipe", "pipe", "pipe"],
  });

  const probe = startMemoryProbe(child.pid);

  let buf = "";
  let resultBytes = 0;
  let results = 0;
  let done = null;
  let ready = false;

  child.stdout.on("data", (chunk) => {
    buf += chunk.toString("utf8");
    const lines = buf.split("\n");
    buf = lines.pop() ?? "";

    for (const line of lines) {
      if (!line.trim()) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }

      if (msg.type === "ready") ready = true;
      else if (msg.type === "result") {
        results += 1;
        resultBytes += Buffer.byteLength(msg.markdown ?? "", "utf8");
      } else if (msg.type === "done") done = msg;
    }
  });

  const started = Date.now();

  await new Promise((resolve) => {
    const timer = setTimeout(resolve, 15000);
    const check = setInterval(() => {
      if (ready) {
        clearTimeout(timer);
        clearInterval(check);
        resolve();
      }
    }, 100);
  });

  const targets = Array.from({ length: count }, (_, i) => {
    const raw = `${baseUrl}${pagePath}?n=${i}`;
    return { raw, key: raw, siteKey: "127.0.0.1" };
  });

  child.stdin.write(
    JSON.stringify({
      cmd: "crawl",
      targets,
      options: {
        format: "markdown",
        imageStrategy: "remote",
        followPagination: false,
        maxPagination: 5,
        separateOutput: false,
        obeyRobots: true,
      },
      authDir: path.join(PROJECT_ROOT, "runtime", "bench-auth"),
      stagingDir: path.join(PROJECT_ROOT, "runtime", "bench-staging"),
    }) + "\n",
  );

  await new Promise((resolve) => {
    const timer = setTimeout(resolve, 600_000);
    const check = setInterval(() => {
      if (done) {
        clearTimeout(timer);
        clearInterval(check);
        resolve();
      }
    }, 200);
  });

  const elapsedMs = Date.now() - started;
  const peak = probe.stop();

  child.stdin.write(JSON.stringify({ cmd: "shutdown" }) + "\n");
  await new Promise((r) => setTimeout(r, 1000));
  child.kill();

  return {
    count,
    elapsedMs,
    succeeded: done?.succeeded ?? 0,
    results,
    resultMb: resultBytes / 1048576,
    peakMb: peak / 1048576,
  };
}

async function main() {
  // 三种页面体量：接近用户实际文档页、较大文档页、极端长文
  const sizes = [
    { label: "约 30 KB/页", repeat: 120, path: "/small" },
    { label: "约 200 KB/页", repeat: 800, path: "/large" },
  ];

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname === "/robots.txt") {
      res.writeHead(200, { "content-type": "text/plain" });
      return res.end("User-agent: *\nAllow: /\n");
    }
    const size = sizes.find((s) => s.path === url.pathname) ?? sizes[0];
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(articlePage(size.repeat));
  });

  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  // 先量一下实际产出体量（Windows 下动态 import 需要 file:// URL）
  const { extractContent } = await import(
    pathToFileURL(path.join(PROJECT_ROOT, "crawler", "dist", "extractor", "readability.js")).href
  );
  const { toMarkdown } = await import(
    pathToFileURL(path.join(PROJECT_ROOT, "crawler", "dist", "markdown", "convert.js")).href
  );

  for (const size of sizes) {
    const html = articlePage(size.repeat);
    const ex = extractContent(html, `${baseUrl}${size.path}`);
    const md = await toMarkdown(ex.contentHtml, `${baseUrl}${size.path}`, {
      imageStrategy: "remote",
    });
    size.actualKb = Buffer.byteLength(md, "utf8") / 1024;
  }

  console.log("页面体量实测：");
  for (const s of sizes) console.log(`  ${s.path.padEnd(8)} ${s.actualKb.toFixed(0)} KB/页`);
  console.log("");

  const rows = [];

  for (const size of sizes) {
    for (const count of [10, 50, 100]) {
      process.stdout.write(`压测 ${size.path} × ${count} 条 … `);
      const row = await runOnce(baseUrl, count, size.path);
      row.label = size.path;
      row.perPageKb = size.actualKb;
      rows.push(row);
      console.log(
        `${(row.elapsedMs / 1000).toFixed(0)}s，正文合计 ${row.resultMb.toFixed(1)} MB，` +
          `峰值 ${row.peakMb.toFixed(0)} MB`,
      );
    }
  }

  await new Promise((r) => server.close(r));

  console.log("");
  console.log("=".repeat(88));
  console.log(
    "页面".padEnd(10) +
      "页体积".padEnd(11) +
      "链接数".padEnd(9) +
      "耗时(s)".padEnd(10) +
      "正文合计(MB)".padEnd(15) +
      "峰值(MB)".padEnd(11) +
      "较基线增量(MB)",
  );
  console.log("-".repeat(88));

  const baselines = new Map();
  for (const row of rows) {
    if (!baselines.has(row.label)) baselines.set(row.label, row.peakMb);
    const base = baselines.get(row.label);
    console.log(
      row.label.padEnd(12) +
        `${row.perPageKb.toFixed(0)} KB`.padEnd(13) +
        String(row.count).padEnd(11) +
        (row.elapsedMs / 1000).toFixed(0).padEnd(12) +
        row.resultMb.toFixed(1).padEnd(17) +
        row.peakMb.toFixed(0).padEnd(13) +
        `+${(row.peakMb - base).toFixed(0)}`,
    );
  }
  console.log("-".repeat(88));
  console.log("基线 = 该体量下 10 条时的峰值；增量反映 Node 侧是否随链接数累积。");
}

main().catch((error) => {
  console.error("压测失败:", error);
  process.exit(1);
});
