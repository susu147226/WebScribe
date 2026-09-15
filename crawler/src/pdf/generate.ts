import { marked } from "marked";
import type { BrowserSession } from "../browser/session.js";

/**
 * PDF 生成（文档第 14 条）。
 *
 * 经作者确认，PDF 引擎复用 Playwright/Chromium 的打印能力。流程为
 * Markdown → HTML → Chromium PDF，因此 PDF 与 Markdown 内容严格一致。
 *
 * 文档第 14 条要求 PDF 尽量保留标题、段落、图片、表格、代码、页面结构与
 * 中文字符，因此这里提供了一套自带中文与等宽字体回退的打印样式。
 */

/**
 * 打印样式。
 *
 * 字体栈覆盖 Windows 常见中文字体（微软雅黑 / 苹方 / 思源黑体 / 无衬线回退），
 * 避免生成 PDF 时中文缺字或退化成方框。代码块使用等宽字体栈。
 */
const PRINT_STYLES = `
  :root { color-scheme: light; }
  * { box-sizing: border-box; }
  body {
    font-family: "Microsoft YaHei", "PingFang SC", "Hiragino Sans GB",
                 "Source Han Sans SC", "Noto Sans CJK SC", -apple-system,
                 "Segoe UI", Roboto, sans-serif;
    font-size: 15px;
    line-height: 1.75;
    color: #1a1a1a;
    margin: 0;
    word-wrap: break-word;
  }
  h1, h2, h3, h4, h5, h6 {
    line-height: 1.35;
    margin: 1.6em 0 0.6em;
    page-break-after: avoid;
    break-after: avoid;
  }
  h1 { font-size: 1.9em; border-bottom: 1px solid #e5e5e5; padding-bottom: 0.3em; }
  h2 { font-size: 1.5em; border-bottom: 1px solid #eee; padding-bottom: 0.25em; }
  h3 { font-size: 1.25em; }
  p { margin: 0.85em 0; }
  blockquote {
    margin: 1em 0;
    padding: 0.5em 1em;
    border-left: 4px solid #d0d0d0;
    background: #fafafa;
    color: #444;
  }
  blockquote > p { margin: 0.25em 0; }
  img { max-width: 100%; height: auto; page-break-inside: avoid; break-inside: avoid; }
  pre {
    background: #f6f8fa;
    border: 1px solid #e5e5e5;
    border-radius: 6px;
    padding: 0.9em 1em;
    overflow-x: auto;
    page-break-inside: avoid;
    break-inside: avoid;
    white-space: pre-wrap;
    word-wrap: break-word;
  }
  code {
    font-family: "Cascadia Mono", Consolas, "Courier New", "Microsoft YaHei",
                 monospace;
    font-size: 0.9em;
  }
  pre code { font-size: 0.87em; background: none; padding: 0; }
  :not(pre) > code {
    background: #f0f1f3;
    padding: 0.15em 0.4em;
    border-radius: 4px;
  }
  table {
    border-collapse: collapse;
    width: 100%;
    margin: 1em 0;
    page-break-inside: avoid;
    break-inside: avoid;
  }
  th, td { border: 1px solid #d8d8d8; padding: 0.5em 0.75em; text-align: left; }
  th { background: #f2f3f5; font-weight: 600; }
  hr { border: none; border-top: 1px solid #e0e0e0; margin: 2em 0; }
  ul, ol { padding-left: 1.6em; }
  li { margin: 0.3em 0; }
  a { color: #1a5fb4; text-decoration: none; }
  @page { margin: 18mm 16mm; }
`;

/** 转义用于 `<title>` 的文本。 */
function escapeHtml(input: string): string {
  return input
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * 将 Markdown 文档渲染为完整 HTML。
 *
 * `baseUrl` 用于解析文档中的相对资源地址；留空时以 `about:blank` 为基准，
 * 此时相对图片无法加载，但文档结构仍完整。
 */
export function markdownToHtml(markdown: string, title: string, baseUrl?: string): string {
  const body = marked.parse(markdown, {
    gfm: true,
    breaks: false,
    async: false,
  }) as string;

  const baseTag = baseUrl ? `<base href="${escapeHtml(baseUrl)}">` : "";

  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
${baseTag}
<title>${escapeHtml(title)}</title>
<style>${PRINT_STYLES}</style>
</head>
<body>
${body}
</body>
</html>`;
}

/**
 * 将 Markdown 渲染为 PDF 字节。
 *
 * @param markdown 已组装完成的 Markdown 文档（含元数据块与多页接续）
 */
export async function markdownToPdf(
  markdown: string,
  title: string,
  browser: BrowserSession,
  baseUrl?: string,
): Promise<Uint8Array> {
  const html = markdownToHtml(markdown, title, baseUrl);
  return await browser.htmlToPdf(html);
}
