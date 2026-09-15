/**
 * crawler sidecar 的端到端测试。
 *
 * 直接以子进程方式启动 crawler，通过 NDJSON 下发抓取命令，对接本地 fixture
 * 服务器，逐项核对文档第 49、50 条要求的验收场景。
 *
 * 运行：npm run test:integration
 */

import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { startFixtureServer } from "./server.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, "..", "..");
const NODE_EXE = path.join(PROJECT_ROOT, "runtime", "node", "node.exe");
const CRAWLER_ENTRY = path.join(PROJECT_ROOT, "crawler", "dist", "index.js");
const BROWSERS_DIR = path.join(PROJECT_ROOT, "runtime", "browsers");

// ---------------------------------------------------------------------------
// 极简断言
// ---------------------------------------------------------------------------

let passed = 0;
const failures = [];

function check(name, condition, detail = "") {
  if (condition) {
    passed += 1;
    console.log(`  ✓ ${name}`);
  } else {
    failures.push({ name, detail });
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

// ---------------------------------------------------------------------------
// crawler 进程封装
// ---------------------------------------------------------------------------

class CrawlerProcess {
  constructor(child) {
    this.child = child;
    this.messages = [];
    this.waiters = [];
    this.buffer = "";

    child.stdout.on("data", (chunk) => {
      this.buffer += chunk.toString("utf8");
      const lines = this.buffer.split("\n");
      this.buffer = lines.pop() ?? "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const message = JSON.parse(trimmed);
          this.messages.push(message);
          for (const waiter of [...this.waiters]) {
            if (waiter.predicate(message)) {
              this.waiters.splice(this.waiters.indexOf(waiter), 1);
              waiter.resolve(message);
            }
          }
        } catch {
          // 非协议输出，忽略
        }
      }
    });
  }

  send(message) {
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  /** 等待满足条件的消息，超时抛错。 */
  waitFor(predicate, timeoutMs = 30_000, label = "消息") {
    const existing = this.messages.find(predicate);
    if (existing) return Promise.resolve(existing);

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`等待「${label}」超时（${timeoutMs}ms）`));
      }, timeoutMs);

      this.waiters.push({
        predicate,
        resolve: (message) => {
          clearTimeout(timer);
          resolve(message);
        },
      });
    });
  }

  async stop() {
    try {
      this.send({ cmd: "shutdown" });
    } catch {
      // 进程可能已退出
    }
    await new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.child.kill();
        resolve();
      }, 3000);
      this.child.on("exit", () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }
}

async function spawnCrawler(authDir, stagingDir) {
  const child = spawn(NODE_EXE, [CRAWLER_ENTRY], {
    env: {
      ...process.env,
      PLAYWRIGHT_BROWSERS_PATH: BROWSERS_DIR,
      PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: "1",
    },
    stdio: ["pipe", "pipe", "pipe"],
  });

  child.stderr.on("data", (chunk) => {
    const text = chunk.toString("utf8").trim();
    if (text) console.log(`    [crawler stderr] ${text}`);
  });

  const proc = new CrawlerProcess(child);
  await proc.waitFor((m) => m.type === "ready", 15_000, "crawler 就绪");

  // authDir / stagingDir 由调用方通过命令行环境传入 crawl 命令
  proc.authDir = authDir;
  proc.stagingDir = stagingDir;
  return proc;
}

function crawlCommand(proc, targets, options) {
  return {
    cmd: "crawl",
    targets,
    options: {
      format: "markdown",
      imageStrategy: "remote",
      followPagination: false,
      maxPagination: 5,
      separateOutput: false,
      obeyRobots: true,
      ...options,
    },
    authDir: proc.authDir,
    stagingDir: proc.stagingDir,
  };
}

/** 构造 crawler 需要的 target（siteKey 由 Rust 侧正常提供，此处按同规则计算）。 */
function target(url, siteKey) {
  return { raw: url, key: url, siteKey: siteKey ?? new URL(url).hostname };
}

// ---------------------------------------------------------------------------
// 测试场景
// ---------------------------------------------------------------------------

async function main() {
  const runtimeMissing = !(await exists(NODE_EXE)) || !(await exists(CRAWLER_ENTRY));
  if (runtimeMissing) {
    console.error("缺少运行时或 crawler 构建产物，请先运行 scripts/fetch-runtime.ps1");
    process.exit(1);
  }

  const fixture = await startFixtureServer(0);
  const workDir = await mkdtemp(path.join(os.tmpdir(), "webscribe-e2e-"));
  const authDir = path.join(workDir, "auth");
  const stagingDir = path.join(workDir, "staging");

  console.log(`fixture 服务器: ${fixture.baseUrl}`);
  console.log(`工作目录: ${workDir}\n`);

  let proc;

  try {
    // =====================================================================
    console.log("场景 1：单网页（静态 HTML）");
    proc = await spawnCrawler(authDir, stagingDir);
    proc.send(
      crawlCommand(proc, [target(`${fixture.baseUrl}/static`)], {}),
    );
    const done1 = await proc.waitFor((m) => m.type === "done", 60_000, "done");

    const result1 = proc.messages.find((m) => m.type === "result");
    check("单 URL 抓取成功", done1.succeeded === 1 && done1.failed === 0,
      `succeeded=${done1.succeeded} failed=${done1.failed}`);
    check("产出了 Markdown 正文", typeof result1?.markdown === "string" && result1.markdown.length > 100,
      `长度=${result1?.markdown?.length ?? 0}`);
    check("标题被正确提取", result1?.title?.includes("中文示例文章"), `title=${result1?.title}`);
    // 经作者确认：还原原始层级并去重。Readability 把 h1 映射为 h2，
    // 该重复标题应被移除，而原文的 h2、h3 保持原层级
    check("去除了与文档标题重复的正文首标题",
      !/^##\s+中文示例文章\s*$/m.test(result1?.markdown ?? ""),
      "正文仍含重复的标题行");
    check("原文 h2 保持二级", /^##\s+二级标题\s*$/m.test(result1?.markdown ?? ""), "");
    check("原文 h3 保持三级", /^###\s+列表\s*$/m.test(result1?.markdown ?? ""), "");
    check("保留了粗体", result1?.markdown?.includes("**粗体文字**"), "");
    check("保留了斜体", result1?.markdown?.includes("*斜体文字*"), "");
    check("保留了超链接", result1?.markdown?.includes("](https://example.com/link)"), "");
    // 列表标记后的空白宽度不作要求，只要标记与内容正确即可
    check("保留了无序列表", /^-\s+无序项目一$/m.test(result1?.markdown ?? ""), "");
    check("保留了无序列表第二项", /^-\s+无序项目二$/m.test(result1?.markdown ?? ""), "");
    check("保留了有序列表", /^1\.\s+有序项目一$/m.test(result1?.markdown ?? ""), "");
    check("保留了表格", result1?.markdown?.includes("| 列一 |"), "");
    check("保留了行内代码", result1?.markdown?.includes("`npm run build`"), "");
    check("保留了代码块", result1?.markdown?.includes("```"), "");
    check("保留了引用", result1?.markdown?.includes("> 这是一段引用文字"), "");
    check("保留了图片", result1?.markdown?.includes("![示例图片]"), "");
    check("图片地址被解析为绝对路径", result1?.markdown?.includes(`${fixture.baseUrl}/images/sample.png`), "");
    check("剥离了导航栏等无关区域", !result1?.markdown?.includes("这是侧边栏"), "");
    check("未启用浏览器渲染", result1?.rendered === false, `rendered=${result1?.rendered}`);
    await proc.stop();

    // =====================================================================
    console.log("\n场景 2：多页文章自动接续（默认关闭）");
    proc = await spawnCrawler(authDir, stagingDir);
    proc.send(crawlCommand(proc, [target(`${fixture.baseUrl}/multi/1`)], { followPagination: false }));
    await proc.waitFor((m) => m.type === "done", 60_000, "done");
    const pageCount = proc.messages.filter((m) => m.type === "result").length;
    check("默认不自动续页", pageCount === 1, `实际产出 ${pageCount} 页`);
    await proc.stop();

    // =====================================================================
    console.log("\n场景 3：多页文章自动接续（开启，上限 5）");
    proc = await spawnCrawler(authDir, stagingDir);
    proc.send(
      crawlCommand(proc, [target(`${fixture.baseUrl}/multi/1`)], {
        followPagination: true,
        maxPagination: 5,
      }),
    );
    await proc.waitFor((m) => m.type === "done", 90_000, "done");
    const results = proc.messages.filter((m) => m.type === "result");
    const sequences = results.map((r) => r.sequence).sort((a, b) => a - b);
    check("自动续页抓到全部 3 页", results.length === 3, `实际 ${results.length} 页`);
    check("页码顺序连续", JSON.stringify(sequences) === "[0,1,2]", `sequences=${JSON.stringify(sequences)}`);
    check("第 2 页来源正确", results.some((r) => r.url.endsWith("/multi/2")), "");
    check("第 3 页来源正确", results.some((r) => r.url.endsWith("/multi/3")), "");
    check("未超出页面上限", results.length <= 5, "");
    await proc.stop();

    // =====================================================================
    console.log("\n场景 4：10 个 URL 跨站并发（同站串行）");
    proc = await spawnCrawler(authDir, stagingDir);
    const tenTargets = Array.from({ length: 10 }, (_, i) =>
      // 通过 query 参数制造 10 个互不重复的 URL，仍属同一站点
      target(`${fixture.baseUrl}/static?v=${i}`),
    );
    proc.send(crawlCommand(proc, tenTargets, {}));
    const done10 = await proc.waitFor((m) => m.type === "done", 120_000, "done");
    check("10 个 URL 全部处理", done10.succeeded + done10.failed === 10,
      `succeeded=${done10.succeeded} failed=${done10.failed}`);
    check("10 个 URL 全部成功", done10.succeeded === 10, "");
    check("产出 10 份结果", proc.messages.filter((m) => m.type === "result").length === 10, "");
    await proc.stop();

    // =====================================================================
    console.log("\n场景 5：网站防护——429 限流");
    proc = await spawnCrawler(authDir, stagingDir);
    proc.send(crawlCommand(proc, [target(`${fixture.baseUrl}/rate-limit`)], {}));
    await proc.waitFor((m) => m.type === "done", 90_000, "done");
    const rateError = proc.messages.find((m) => m.type === "error");
    check("429 被识别为 RateLimited", rateError?.errorKind === "RateLimited",
      `errorKind=${rateError?.errorKind}`);
    check("429 未产生结果", !proc.messages.some((m) => m.type === "result"), "");
    await proc.stop();

    // =====================================================================
    console.log("\n场景 6：网站防护——403 访问拒绝");
    proc = await spawnCrawler(authDir, stagingDir);
    proc.send(crawlCommand(proc, [target(`${fixture.baseUrl}/forbidden`)], {}));
    await proc.waitFor((m) => m.type === "done", 60_000, "done");
    const forbidError = proc.messages.find((m) => m.type === "error");
    check("403 被识别为 AccessDenied", forbidError?.errorKind === "AccessDenied",
      `errorKind=${forbidError?.errorKind}`);
    check("403 未产生结果", !proc.messages.some((m) => m.type === "result"), "");
    await proc.stop();

    // =====================================================================
    console.log("\n场景 7：网站防护——验证码");
    proc = await spawnCrawler(authDir, stagingDir);
    proc.send(crawlCommand(proc, [target(`${fixture.baseUrl}/captcha`)], {}));
    await proc.waitFor((m) => m.type === "done", 60_000, "done");
    const captchaError = proc.messages.find((m) => m.type === "error");
    check("验证码被识别为 CaptchaDetected", captchaError?.errorKind === "CaptchaDetected",
      `errorKind=${captchaError?.errorKind}`);
    check("验证码页面未被当作正文", !proc.messages.some((m) => m.type === "result"), "");
    // 文档第 24、26 条：不得绕过，必须停止并交还用户
    check("未尝试绕过验证码（无重试结果）",
      proc.messages.filter((m) => m.type === "error").length === 1, "");
    await proc.stop();

    // =====================================================================
    console.log("\n场景 8：网站防护——Challenge");
    proc = await spawnCrawler(authDir, stagingDir);
    proc.send(crawlCommand(proc, [target(`${fixture.baseUrl}/challenge`)], {}));
    await proc.waitFor((m) => m.type === "done", 60_000, "done");
    const challengeError = proc.messages.find((m) => m.type === "error");
    check("Challenge 被识别为 ChallengeDetected", challengeError?.errorKind === "ChallengeDetected",
      `errorKind=${challengeError?.errorKind}`);
    check("Challenge 未产生结果", !proc.messages.some((m) => m.type === "result"), "");
    await proc.stop();

    // =====================================================================
    console.log("\n场景 9：SPA 页面回退到 Playwright 渲染");
    proc = await spawnCrawler(authDir, stagingDir);
    proc.send(crawlCommand(proc, [target(`${fixture.baseUrl}/spa`)], {}));
    await proc.waitFor((m) => m.type === "done", 120_000, "done");
    const spaResult = proc.messages.find((m) => m.type === "result");
    const spaError = proc.messages.find((m) => m.type === "error");

    if (spaResult) {
      check("SPA 页面成功提取", true, "");
      check("SPA 标记为已渲染", spaResult.rendered === true, `rendered=${spaResult.rendered}`);
      check("提取到 JS 生成的正文", spaResult.markdown.includes("由 JavaScript 渲染的标题"), "");
    } else {
      check("SPA 页面成功提取", false,
        `未产出结果；error=${spaError?.errorKind}: ${spaError?.message}`);
    }
    await proc.stop();

    // =====================================================================
    console.log("\n场景 10：结果不包含凭据字段");
    proc = await spawnCrawler(authDir, stagingDir);
    proc.send(crawlCommand(proc, [target(`${fixture.baseUrl}/static`)], {}));
    await proc.waitFor((m) => m.type === "done", 60_000, "done");
    const serialized = JSON.stringify(proc.messages);
    check("结果中不含密码字段", !/password/i.test(serialized), "");
    check("结果中不含 Cookie 字段", !/set-cookie/i.test(serialized), "");
    await proc.stop();

    // =====================================================================
    console.log("\n场景 11：Markdown → PDF（复用 Chromium 打印）");
    proc = await spawnCrawler(authDir, stagingDir);

    const pdfMarkdown = [
      "# PDF 测试文档",
      "> Source: https://example.com/a",
      ">",
      "> Crawled At: 2026-09-15 10:00:00",
      "",
      "## 中文段落",
      "",
      "这是一段中文正文，用于验证 PDF 中的中文字符是否正确嵌入。",
      "",
      "## 表格",
      "",
      "| 列一 | 列二 |",
      "| --- | --- |",
      "| 值 A | 值 B |",
      "",
      "## 代码",
      "",
      "```js",
      "const x = 1;",
      "```",
      "",
    ].join("\n");

    proc.send({ cmd: "render-pdf", id: "pdf-test", markdown: pdfMarkdown, title: "PDF 测试文档" });
    const pdfMessage = await proc.waitFor(
      (m) => m.type === "pdf" || m.type === "pdf-error",
      120_000,
      "PDF 应答",
    );

    if (pdfMessage.type === "pdf") {
      const bytes = Buffer.from(pdfMessage.pdfBase64, "base64");
      check("PDF 渲染成功", true, "");
      check("PDF 非空", bytes.length > 1000, `大小=${bytes.length} 字节`);
      check("PDF 文件头正确", bytes.subarray(0, 5).toString("latin1") === "%PDF-", "");
      check("PDF 含 EOF 标记",
        bytes.subarray(-1024).toString("latin1").includes("%%EOF"), "");
    } else {
      check("PDF 渲染成功", false, `${pdfMessage.message} ${pdfMessage.detail ?? ""}`);
    }
    await proc.stop();
  } finally {
    if (proc) await proc.stop().catch(() => {});
    await fixture.close();
    await rm(workDir, { recursive: true, force: true }).catch(() => {});
  }

  // ---------------------------------------------------------------------
  console.log("\n" + "=".repeat(60));
  console.log(`通过 ${passed} 项，失败 ${failures.length} 项`);

  if (failures.length > 0) {
    console.log("\n失败明细:");
    for (const f of failures) {
      console.log(`  ✗ ${f.name}${f.detail ? ` — ${f.detail}` : ""}`);
    }
    process.exit(1);
  }
}

async function exists(p) {
  try {
    const { access } = await import("node:fs/promises");
    await access(p);
    return true;
  } catch {
    return false;
  }
}

main().catch((error) => {
  console.error("测试执行失败:", error);
  process.exit(1);
});
