/**
 * 链接数量扩展的可行性压测。
 *
 * 直接以子进程方式驱动 crawler（10 条上限由 Rust 侧施加，crawler 本身不限），
 * 对接本地 fixture 服务器，测量不同链接数量下的耗时与内存峰值。
 *
 * 用法：node tests/benchmark/scale.mjs
 */

import { spawn, execSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { startFixtureServer } from "../integration/server.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, "..", "..");
const NODE_EXE = path.join(PROJECT_ROOT, "runtime", "node", "node.exe");
const CRAWLER_ENTRY = path.join(PROJECT_ROOT, "crawler", "dist", "index.js");
const BROWSERS_DIR = path.join(PROJECT_ROOT, "runtime", "browsers");
const STAGING = path.join(PROJECT_ROOT, "runtime", "bench-staging");

/** 同一站点的多个不同 URL（用查询串区分），用于测「同站串行」这一最慢情形。 */
function targetUrls(base, count) {
  return Array.from({ length: count }, (_, i) => `${base}/static?v=${i}`);
}

/** 采样进程工作集，返回 { peakBytes, samples }。 */
function startMemoryProbe(pid) {
  let peak = 0;
  const samples = [];

  const timer = setInterval(() => {
    try {
      const out = execSync(
        `tasklist /FI "PID eq ${pid}" /FO CSV /NH`,
        { encoding: "utf8", windowsHide: true },
      );
      // 形如 "node.exe","1234","Console","1","67,720 K"
      const match = out.match(/"([\d,]+) K"/);
      if (match) {
        const kb = Number(match[1].replace(/,/g, ""));
        const bytes = kb * 1024;
        samples.push(bytes);
        if (bytes > peak) peak = bytes;
      }
    } catch {
      // 进程已退出
    }
  }, 250);

  return {
    stop() {
      clearInterval(timer);
      return { peakBytes: peak, samples: samples.length };
    },
  };
}

async function runScale(baseUrl, count) {
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
  const progress = { count: 0 };

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

      if (msg.type === "result") {
        results += 1;
        // 只统计正文体积；行本身不保留，避免测量工具自身占用内存
        resultBytes += Buffer.byteLength(msg.markdown ?? "", "utf8");
      } else if (msg.type === "progress") {
        progress.count += 1;
      } else if (msg.type === "done") {
        done = msg;
      }
    }
  });

  const started = Date.now();

  const ready = await new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), 20000);
    const check = setInterval(() => {
      if (progress.ready) {
        clearTimeout(timer);
        clearInterval(check);
        resolve(true);
      }
    }, 100);
    child.stdout.once("data", () => {
      progress.ready = true;
      clearTimeout(timer);
      clearInterval(check);
      resolve(true);
    });
  });

  if (!ready) {
    probe.stop();
    child.kill();
    throw new Error("crawler 未能在 20 秒内就绪");
  }

  const targets = targetUrls(baseUrl, count).map((raw) => ({
    raw,
    key: raw,
    siteKey: "127.0.0.1",
  }));

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
      stagingDir: STAGING,
    }) + "\n",
  );

  await new Promise((resolve) => {
    const timer = setTimeout(resolve, 900_000);
    const check = setInterval(() => {
      if (done) {
        clearTimeout(timer);
        clearInterval(check);
        resolve();
      }
    }, 200);
  });

  const elapsedMs = Date.now() - started;
  const { peakBytes, samples } = probe.stop();

  child.stdin.write(JSON.stringify({ cmd: "shutdown" }) + "\n");
  await new Promise((r) => setTimeout(r, 1200));
  child.kill();

  return {
    count,
    elapsedMs,
    succeeded: done?.succeeded ?? 0,
    failed: done?.failed ?? 0,
    results,
    resultMb: resultBytes / 1048576,
    peakMb: peakBytes / 1048576,
    samples,
    progressCount: progress.count,
  };
}

async function main() {
  const fixture = await startFixtureServer(0);
  console.log(`fixture 服务器: ${fixture.baseUrl}`);
  console.log("每个页面的正文约 30 KB（见 tests/integration/server.mjs 的 /static）");
  console.log("");

  const counts = [10, 50, 100];
  const rows = [];

  for (const count of counts) {
    process.stdout.write(`正在压测 ${count} 条 … `);
    const row = await runScale(fixture.baseUrl, count);
    rows.push(row);
    console.log(
      `完成（${(row.elapsedMs / 1000).toFixed(1)}s，峰值 ${row.peakMb.toFixed(0)} MB，` +
        `正文合计 ${row.resultMb.toFixed(1)} MB）`,
    );
  }

  await fixture.close();

  console.log("");
  console.log("=".repeat(76));
  console.log(
    "链接数".padEnd(8) +
      "耗时(s)".padEnd(11) +
      "成功".padEnd(7) +
      "正文合计(MB)".padEnd(15) +
      "内存峰值(MB)".padEnd(14) +
      "每条均摊(MB)",
  );
  console.log("-".repeat(76));

  for (const row of rows) {
    console.log(
      String(row.count).padEnd(10) +
        (row.elapsedMs / 1000).toFixed(1).padEnd(12) +
        String(row.succeeded).padEnd(8) +
        row.resultMb.toFixed(1).padEnd(16) +
        row.peakMb.toFixed(0).padEnd(15) +
        (row.peakMb / row.count).toFixed(1),
    );
  }

  console.log("-".repeat(76));
  console.log("注：耗时包含同站串行所需的 1 秒最小间隔；内存峰值为 node 进程工作集。");
}

main().catch((error) => {
  console.error("压测失败:", error);
  process.exit(1);
});
