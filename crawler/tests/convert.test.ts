import { describe, expect, it } from "vitest";

import {
  DEFAULT_ASSETS_PLACEHOLDER,
  normalizeImageAttributes,
  pickFromSrcset,
  resolveImageUrl,
  toMarkdown,
} from "../src/markdown/convert.js";
import { imageFileName } from "../src/markdown/images.js";

const BASE = "https://example.com/a/b";

describe("resolveImageUrl", () => {
  it("解析绝对地址", () => {
    expect(resolveImageUrl("https://cdn.test/x.png", BASE)).toBe("https://cdn.test/x.png");
  });

  it("解析相对于主机的地址", () => {
    expect(resolveImageUrl("/x.png", BASE)).toBe("https://example.com/x.png");
  });

  it("解析相对于路径的地址", () => {
    expect(resolveImageUrl("x.png", BASE)).toBe("https://example.com/a/x.png");
  });

  it("解析协议相对地址", () => {
    expect(resolveImageUrl("//cdn.test/x.png", BASE)).toBe("https://cdn.test/x.png");
  });

  it("空地址返回 null", () => {
    expect(resolveImageUrl("", BASE)).toBeNull();
    expect(resolveImageUrl("   ", BASE)).toBeNull();
  });

  it("无法解析的地址返回 null", () => {
    expect(resolveImageUrl("http://[invalid", BASE)).toBeNull();
  });
});

describe("pickFromSrcset", () => {
  it("取最后一项（通常是最大尺寸）", () => {
    expect(pickFromSrcset("a.png 1x, b.png 2x")).toBe("b.png");
    expect(pickFromSrcset("a.png 480w, b.png 1024w, c.png 2048w")).toBe("c.png");
  });

  it("仅一项时取该项", () => {
    expect(pickFromSrcset("only.png")).toBe("only.png");
  });

  it("空字符串返回 null", () => {
    expect(pickFromSrcset("")).toBeNull();
    expect(pickFromSrcset("  ,  ")).toBeNull();
  });
});

describe("normalizeImageAttributes", () => {
  it("把 srcset 中的地址提升到 src", () => {
    const html = '<img srcset="a.png 480w, b.png 1024w" src="placeholder.png">';
    const out = normalizeImageAttributes(html, BASE);
    expect(out).toContain('src="https://example.com/a/b.png"');
  });

  it("优先采用懒加载属性中的真实地址", () => {
    const html = '<img data-src="/real.png" src="/placeholder.png">';
    const out = normalizeImageAttributes(html, BASE);
    expect(out).toContain('src="https://example.com/real.png"');
  });

  it("支持多种懒加载属性名", () => {
    for (const attr of ["data-original", "data-lazy-src", "data-actualsrc", "data-echo"]) {
      const html = `<img ${attr}="/real.png" src="/placeholder.png">`;
      const out = normalizeImageAttributes(html, BASE);
      expect(out, `${attr} 未被识别`).toContain('src="https://example.com/real.png"');
    }
  });

  it("懒加载属性优先于 srcset", () => {
    const html = '<img data-src="/real.png" srcset="b.png 1024w">';
    expect(normalizeImageAttributes(html, BASE)).toContain('src="https://example.com/real.png"');
  });

  it("仅有 src 时解析为绝对地址", () => {
    const html = '<img src="/only.png">';
    expect(normalizeImageAttributes(html, BASE)).toContain('src="https://example.com/only.png"');
  });

  it("保留 alt 与 title 等其余属性", () => {
    const html = '<img src="/x.png" alt="说明" title="标题" class="pic">';
    const out = normalizeImageAttributes(html, BASE);
    expect(out).toContain('alt="说明"');
    expect(out).toContain('title="标题"');
    expect(out).toContain('class="pic"');
  });

  it("无 src 来源的 img 保持原样", () => {
    const html = "<img alt=\"无地址\">";
    expect(normalizeImageAttributes(html, BASE)).toBe(html);
  });

  it("非自闭合的 img 标签也能处理", () => {
    const html = '<img src="/x.png" alt="a">';
    expect(normalizeImageAttributes(html, BASE)).toContain(">");
  });
});

describe("toMarkdown", () => {
  it("转换基本结构", async () => {
    const html = "<h2>标题</h2><p>正文 <strong>粗体</strong></p><ul><li>项目</li></ul>";
    const md = await toMarkdown(html, BASE, { imageStrategy: "remote" });
    expect(md).toContain("## 标题");
    expect(md).toContain("**粗体**");
    expect(md).toMatch(/^-\s+项目$/m);
  });

  it("转换表格", async () => {
    const html =
      "<table><thead><tr><th>甲</th><th>乙</th></tr></thead><tbody><tr><td>1</td><td>2</td></tr></tbody></table>";
    const md = await toMarkdown(html, BASE, { imageStrategy: "remote" });
    expect(md).toContain("| 甲 | 乙 |");
  });

  it("转换代码块与行内代码", async () => {
    const html = "<pre><code>const a = 1;</code></pre><p>行内 <code>x</code></p>";
    const md = await toMarkdown(html, BASE, { imageStrategy: "remote" });
    expect(md).toContain("```");
    expect(md).toContain("const a = 1;");
    expect(md).toContain("`x`");
  });

  it("转换引用", async () => {
    const html = "<blockquote><p>引用文字</p></blockquote>";
    expect(await toMarkdown(html, BASE, { imageStrategy: "remote" })).toContain("> 引用文字");
  });

  it("remote 策略保留远程图片地址", async () => {
    const html = '<img src="/pic.png" alt="图">';
    const md = await toMarkdown(html, BASE, { imageStrategy: "remote" });
    expect(md).toContain("![图](https://example.com/pic.png)");
  });

  it("local 策略把图片改写为占位前缀", async () => {
    const html = '<img src="/pic.png" alt="图">';
    const md = await toMarkdown(html, BASE, {
      imageStrategy: "local",
      downloadImage: async () => "abc123.png",
    });
    expect(md).toContain(`![图](${DEFAULT_ASSETS_PLACEHOLDER}/abc123.png)`);
  });

  it("local 策略下下载失败时回退为远程地址", async () => {
    const html = '<img src="/pic.png" alt="图">';
    const md = await toMarkdown(html, BASE, {
      imageStrategy: "local",
      downloadImage: async () => null,
    });
    expect(md).toContain("https://example.com/pic.png");
    expect(md).not.toContain(DEFAULT_ASSETS_PLACEHOLDER);
  });

  it("local 策略下下载抛错不中断整体转换", async () => {
    const html = '<p>正文</p><img src="/pic.png" alt="图">';
    const md = await toMarkdown(html, BASE, {
      imageStrategy: "local",
      downloadImage: async () => {
        throw new Error("网络错误");
      },
    });
    expect(md).toContain("正文");
    expect(md).toContain("https://example.com/pic.png");
  });

  it("同一图片只下载一次", async () => {
    let calls = 0;
    const html = '<img src="/same.png"><img src="/same.png">';
    await toMarkdown(html, BASE, {
      imageStrategy: "local",
      downloadImage: async () => {
        calls += 1;
        return "x.png";
      },
    });
    expect(calls).toBe(1);
  });
});

describe("imageFileName", () => {
  it("同一 URL 生成相同文件名", () => {
    expect(imageFileName("https://x.test/a.png", "image/png")).toBe(
      imageFileName("https://x.test/a.png", "image/png"),
    );
  });

  it("不同 URL 生成不同文件名", () => {
    expect(imageFileName("https://x.test/a.png", null)).not.toBe(
      imageFileName("https://x.test/b.png", null),
    );
  });

  it("按 MIME 推断扩展名", () => {
    expect(imageFileName("https://x.test/a", "image/png")).toMatch(/\.png$/);
    expect(imageFileName("https://x.test/a", "image/jpeg")).toMatch(/\.jpg$/);
    expect(imageFileName("https://x.test/a", "image/webp")).toMatch(/\.webp$/);
    expect(imageFileName("https://x.test/a", "image/svg+xml")).toMatch(/\.svg$/);
  });

  it("无 MIME 时按 URL 扩展名推断", () => {
    expect(imageFileName("https://x.test/a.gif", null)).toMatch(/\.gif$/);
  });

  it("文件名不含路径分隔符等非法字符", () => {
    const name = imageFileName("https://x.test/a/b/c.png?v=1", "image/png");
    expect(name).not.toMatch(/[\\/:*?"<>|]/);
  });
});
