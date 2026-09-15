/**
 * 集成测试用的本地 fixture 服务器。
 *
 * 文档第 49 条要求覆盖：静态 HTML、JavaScript 页面、SPA、登录页面、登录后页面、
 * 多页文章、同站多个页面、不同站点，以及 429 / 403 / 验证码 / Challenge /
 * 登录过期等防护场景。
 *
 * 使用本地服务器而非真实站点，保证测试可重复、不对外部站点产生流量。
 */

import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(__dirname, "..", "fixtures");

/** 一篇内容充足的静态文章，覆盖文档第 13 条要求保留的全部元素。 */
const ARTICLE_HTML = `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <title>中文示例文章 — 静态页面</title>
</head>
<body>
  <nav><a href="/">首页</a> <a href="/about">关于</a></nav>
  <article>
    <h1>中文示例文章</h1>
    <p>这是用于集成测试的正文段落。它需要足够长，以便通过 Readability 的正文判定阈值，
    因此这里重复一些内容来达到最小长度要求。正文提取应当只保留这一部分，而剥离掉导航栏、
    侧边栏与页脚等无关区域。</p>
    <h2>二级标题</h2>
    <p>段落中包含 <strong>粗体文字</strong>、<em>斜体文字</em> 与一个
    <a href="https://example.com/link">超链接</a>。</p>
    <h3>列表</h3>
    <ul>
      <li>无序项目一</li>
      <li>无序项目二</li>
    </ul>
    <ol>
      <li>有序项目一</li>
      <li>有序项目二</li>
    </ol>
    <h3>表格</h3>
    <table>
      <thead><tr><th>列一</th><th>列二</th></tr></thead>
      <tbody>
        <tr><td>值 A</td><td>值 B</td></tr>
        <tr><td>值 C</td><td>值 D</td></tr>
      </tbody>
    </table>
    <h3>代码</h3>
    <p>行内代码示例 <code>npm run build</code>。</p>
    <pre><code>const greeting = "你好";
console.log(greeting);</code></pre>
    <h3>引用</h3>
    <blockquote><p>这是一段引用文字。</p></blockquote>
    <h3>图片</h3>
    <p><img src="/images/sample.png" alt="示例图片"></p>
  </article>
  <aside><p>这是侧边栏，不应出现在正文中。</p></aside>
  <footer><p>版权所有</p></footer>
</body>
</html>`;

/** 仅靠 JavaScript 生成正文的页面。 */
const SPA_HTML = `<!doctype html>
<html lang="zh-CN">
<head><meta charset="utf-8"><title>SPA 页面</title></head>
<body>
  <div id="root"></div>
  <script type="module">
    document.getElementById('root').innerHTML = \`
      <article>
        <h1>由 JavaScript 渲染的标题</h1>
        <p>这段正文只在浏览器中执行脚本后才会出现。HTTP 阶段拿到的 HTML 里没有它，
        因此抓取流程必须在此处回退到 Playwright 渲染。为了通过正文长度阈值，
        这里同样需要补充一些说明性文字，描述该页面用于验证动态渲染路径。</p>
        <p>补充说明：此页面用于验证「HTTP First，必要时启用浏览器」这一策略。
        在 HTTP 阶段，页面只有一个空的根容器与一段脚本，正文提取会判定内容不足，
        进而触发浏览器渲染；渲染完成后再次提取，应当得到下面这段由脚本生成的标题与正文。
        这段文字本身没有实际含义，只是为了让正文长度稳定超过判定阈值，
        从而使测试结果不受阈值微调的影响。</p>
      </article>\`;
  </script>
</body>
</html>`;

/** 三页连载文章，带「下一页」链接。 */
function paginationPage(current, total) {
  const next =
    current < total
      ? `<a class="pagination__next" rel="next" href="/multi/${current + 1}">下一页</a>`
      : "";
  return `<!doctype html>
<html lang="zh-CN">
<head><meta charset="utf-8"><title>连载文章 第 ${current} 页</title></head>
<body>
  <article>
    <h1>连载文章 第 ${current} 页</h1>
    <p>这是连载文章的第 ${current} 页正文，共 ${total} 页。多页自动发现应当识别出
    「下一页」链接并在上限内继续抓取，最终把各页接续为同一份 Markdown 文档。</p>
    <p>为了让正文长度稳定超过提取阈值，这里补充一段说明性文字。多页发现的判定优先级为：
    首先检查页面是否声明了 link rel="next"，其次检查 a rel="next"，
    最后才回退到分页容器内文本精确匹配「下一页」等字样的链接。
    任何一步都无法可靠判断时，程序应当停止自动续页并向用户提示，而不是猜测下一页的位置。
    这一段文字不对应任何真实内容，仅用于测试。</p>
  </article>
  <nav class="pagination">${next}</nav>
</body>
</html>`;
}

const ROUTES = {
  "/robots.txt": { type: "text/plain", body: "User-agent: *\nAllow: /\n" },

  "/static": { type: "text/html; charset=utf-8", body: ARTICLE_HTML },
  "/spa": { type: "text/html; charset=utf-8", body: SPA_HTML },

  "/multi/1": { type: "text/html; charset=utf-8", body: paginationPage(1, 3) },
  "/multi/2": { type: "text/html; charset=utf-8", body: paginationPage(2, 3) },
  "/multi/3": { type: "text/html; charset=utf-8", body: paginationPage(3, 3) },
};

export function createFixtureServer() {
  return createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");

    // ---- 防护场景 ----
    if (url.pathname === "/rate-limit") {
      res.writeHead(429, { "content-type": "text/plain", "retry-after": "1" });
      res.end("Too Many Requests");
      return;
    }

    if (url.pathname === "/forbidden") {
      res.writeHead(403, { "content-type": "text/html; charset=utf-8" });
      res.end("<html><body><h1>403 Forbidden</h1></body></html>");
      return;
    }

    if (url.pathname === "/captcha") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(`<!doctype html><html><head><title>人机验证</title>
        <script src="https://www.google.com/recaptcha/api.js"></script></head>
        <body><div class="g-recaptcha" data-sitekey="test"></div></body></html>`);
      return;
    }

    if (url.pathname === "/challenge") {
      res.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "cf-mitigated": "challenge",
      });
      res.end(`<!doctype html><html><head><title>Just a moment...</title></head>
        <body><script>window._cf_chl_opt = {};</script></body></html>`);
      return;
    }

    // ---- 图片 ----
    if (url.pathname === "/images/sample.png") {
      // 1x1 最小 PNG
      const png = Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
        "base64",
      );
      res.writeHead(200, { "content-type": "image/png" });
      res.end(png);
      return;
    }

    // ---- 固定路由 ----
    const route = ROUTES[url.pathname];
    if (route) {
      res.writeHead(200, { "content-type": route.type });
      res.end(route.body);
      return;
    }

    res.writeHead(404, { "content-type": "text/plain" });
    res.end("Not Found");
  });
}

/** 启动服务器并返回其基地址。 */
export async function startFixtureServer(port = 0) {
  const server = createFixtureServer();
  await new Promise((resolve) => server.listen(port, "127.0.0.1", resolve));
  const address = server.address();
  const actualPort = typeof address === "object" && address ? address.port : port;
  return {
    server,
    baseUrl: `http://127.0.0.1:${actualPort}`,
    async close() {
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

// 直接运行时作为独立服务器启动
if (process.argv[1] && process.argv[1].endsWith("server.mjs")) {
  const { baseUrl } = await startFixtureServer(8787);
  console.log(`fixture 服务器已启动: ${baseUrl}`);
  console.log(`  ${baseUrl}/static        静态文章`);
  console.log(`  ${baseUrl}/spa           SPA 页面`);
  console.log(`  ${baseUrl}/multi/1       多页文章`);
  console.log(`  ${baseUrl}/rate-limit    429`);
  console.log(`  ${baseUrl}/forbidden     403`);
  console.log(`  ${baseUrl}/captcha       验证码`);
  console.log(`  ${baseUrl}/challenge     Challenge`);
}

export { FIXTURES, readFile };
