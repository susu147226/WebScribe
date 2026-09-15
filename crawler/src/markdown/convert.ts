import TurndownService from "turndown";
import { gfm } from "turndown-plugin-gfm";

import { promoteTableHeaders } from "./tables.js";

/**
 * HTML → Markdown 转换。
 *
 * 文档第 13 条推荐 Turndown，并要求尽可能保留：H1-H6、段落、粗体、斜体、
 * 超链接、图片、无序列表、有序列表、表格、引用、行内代码、代码块。
 * 表格 / 删除线 / 任务列表由 GFM 插件提供。
 */

export type ImageStrategy = "remote" | "local";

export interface ConvertOptions {
  /** 图片处理策略（文档第 34 条，经作者确认为两者同时支持）。 */
  imageStrategy: ImageStrategy;
  /**
   * `local` 策略下，Markdown 中图片路径的占位前缀。
   *
   * 实际资产目录由 Rust 侧决定（取决于净化后的文件名），crawler 无从得知，
   * 因此这里写入占位符，由 Rust 在落盘时替换为真实相对路径。
   */
  assetsPlaceholder?: string;
  /**
   * `local` 策略下的图片下载器，返回图片在暂存目录中的文件名。
   * 返回 `null` 表示下载失败，此时保留远程 URL。
   */
  downloadImage?: (absoluteUrl: string) => Promise<string | null>;
}

export const DEFAULT_ASSETS_PLACEHOLDER = "{{ASSETS}}";

/** 懒加载属性，按优先级排列——真实地址往往不在 `src` 上。 */
const LAZY_SRC_ATTRS = [
  "data-src",
  "data-original",
  "data-lazy-src",
  "data-actualsrc",
  "data-original-src",
  "data-echo",
];

/** 从 `srcset` 中挑选候选地址（优先取最后一个，通常是最大尺寸）。 */
export function pickFromSrcset(srcset: string): string | null {
  const candidates = srcset
    .split(",")
    .map((part) => part.trim().split(/\s+/)[0])
    .filter((url) => url.length > 0);
  return candidates.length > 0 ? candidates[candidates.length - 1] : null;
}

/** 将协议相对 URL（`//host/path`）补全为绝对 URL。 */
export function resolveImageUrl(raw: string, base: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  try {
    return new URL(trimmed, base).toString();
  } catch {
    return null;
  }
}

function createService(): TurndownService {
  const service = new TurndownService({
    headingStyle: "atx",
    hr: "---",
    bulletListMarker: "-",
    codeBlockStyle: "fenced",
    fence: "```",
    emDelimiter: "*",
    strongDelimiter: "**",
    linkStyle: "inlined",
    br: " ",
  });

  service.use(gfm);

  service.keep(["iframe"]);

  return service;
}

/**
 * 将正文 HTML 转换为 Markdown。
 *
 * @param html 正文 HTML（通常来自 Readability 的 `content`）
 * @param baseUrl 页面 URL，用于解析相对与协议相对资源地址
 */
export async function toMarkdown(
  html: string,
  baseUrl: string,
  options: ConvertOptions,
): Promise<string> {
  const placeholder = options.assetsPlaceholder ?? DEFAULT_ASSETS_PLACEHOLDER;
  const service = createService();

  // 真实图片地址已由 normalizeImageAttributes 提升到 src 上，此处只读 src
  service.addRule("webscribeImage", {
    filter: "img",
    replacement: (_content, node) => {
      const el = node as unknown as HTMLImageElement;
      const alt = (el.getAttribute("alt") ?? "").replace(/[[\]]/g, "");
      const title = el.getAttribute("title");
      const src = resolveImageUrl(el.getAttribute("src") ?? "", baseUrl);

      if (!src) return "";
      const suffix = title ? ` "${title.replace(/"/g, "'")}"` : "";
      return `![${alt}](${src}${suffix})`;
    },
  });

  // 先补齐表格的表头结构：GFM 表格规则要求首行是 th，否则整张表会退化为
  // 原始 HTML（见 tables.ts 的说明）
  const normalized = promoteTableHeaders(normalizeImageAttributes(html, baseUrl));

  const markdown = service.turndown(normalized);

  if (options.imageStrategy === "remote" || !options.downloadImage) {
    return markdown;
  }

  return await localizeImages(markdown, baseUrl, placeholder, options.downloadImage);
}

/**
 * 把懒加载与 srcset 中的真实图片地址提升到 `src` 属性上。
 *
 * 文档第 34 条要求正确处理绝对 URL、相对 URL、协议相对 URL、lazy loading
 * 与 srcset。
 */
export function normalizeImageAttributes(html: string, baseUrl: string): string {
  return html.replace(/<img\b[^>]*>/gi, (tag) => {
    const attrs = parseAttributes(tag);

    let candidate: string | null = null;
    for (const attr of LAZY_SRC_ATTRS) {
      const value = attrs[attr];
      if (value) {
        candidate = value;
        break;
      }
    }

    if (!candidate && attrs["srcset"]) {
      candidate = pickFromSrcset(attrs["srcset"]) ?? null;
    }

    if (!candidate && attrs["src"]) {
      candidate = attrs["src"];
    }

    if (!candidate) return tag;

    const absolute = resolveImageUrl(candidate, baseUrl);
    if (!absolute) return tag;

    return setAttribute(tag, "src", absolute);
  });
}

function parseAttributes(tag: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const re = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(tag)) !== null) {
    attrs[match[1].toLowerCase()] = match[2] ?? match[3] ?? match[4] ?? "";
  }
  return attrs;
}

function setAttribute(tag: string, name: string, value: string): string {
  const escaped = value.replace(/"/g, "&quot;");
  const existing = new RegExp(`\\s${name}\\s*=\\s*(?:"[^"]*"|'[^']*'|[^\\s"'>]+)`, "i");
  if (existing.test(tag)) {
    return tag.replace(existing, ` ${name}="${escaped}"`);
  }
  return tag.replace(/\s*\/?>$/, (tail) => ` ${name}="${escaped}"${tail.trimStart() || ">"}`);
}

async function localizeImages(
  markdown: string,
  baseUrl: string,
  placeholder: string,
  downloadImage: (absoluteUrl: string) => Promise<string | null>,
): Promise<string> {
  const imageRe = /!\[([^\]]*)\]\(([^\s)]+)(\s+"[^"]*")?\)/g;
  const matches = [...markdown.matchAll(imageRe)];
  if (matches.length === 0) return markdown;

  const resolution = new Map<string, string>();
  const uniqueUrls = [...new Set(matches.map((m) => m[2]))];

  await Promise.all(
    uniqueUrls.map(async (url) => {
      const absolute = resolveImageUrl(url, baseUrl);
      if (!absolute || !/^https?:/i.test(absolute)) return;
      try {
        const filename = await downloadImage(absolute);
        if (filename) resolution.set(url, `${placeholder}/${filename}`);
      } catch {
        // 下载失败时保留远程 URL，不阻断整篇文档
      }
    }),
  );

  if (resolution.size === 0) return markdown;

  return markdown.replace(imageRe, (whole, alt: string, url: string, title?: string) => {
    const local = resolution.get(url);
    if (!local) return whole;
    return `![${alt}](${local}${title ?? ""})`;
  });
}
