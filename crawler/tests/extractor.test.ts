import { describe, expect, it } from "vitest";

import {
  extractContent,
  isContentSufficient,
  MIN_CONTENT_LENGTH,
  stripDuplicateLeadingHeading,
} from "../src/extractor/readability.js";

const filler =
  "<p>" + "这是一段足够长的正文内容，用于通过正文提取的判定阈值。".repeat(10) + "</p>";

function page(title: string, body: string): string {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>${title}</title></head><body><article>${body}</article></body></html>`;
}

describe("extractContent", () => {
  it("提取正文与标题", () => {
    const result = extractContent(page("示例标题", `<h1>示例标题</h1>${filler}`), "http://x.test/a");
    expect(result).not.toBeNull();
    expect(result?.title).toContain("示例标题");
    expect(result?.textContent.length).toBeGreaterThan(100);
  });

  it("内容不足时返回的结果不满足充分性判定", () => {
    const result = extractContent(page("短", "<p>太短</p>"), "http://x.test/a");
    expect(isContentSufficient(result)).toBe(false);
  });

  it("正文长度达到阈值时判定为充分", () => {
    const long = "字".repeat(MIN_CONTENT_LENGTH + 50);
    const result = extractContent(page("长文", `<p>${long}</p>`), "http://x.test/a");
    expect(isContentSufficient(result)).toBe(true);
  });

  it("无法解析的 HTML 不会抛出异常", () => {
    expect(() => extractContent("<<<>>>", "http://x.test/a")).not.toThrow();
  });
});

describe("stripDuplicateLeadingHeading", () => {
  it("首标题与文档标题相同时被移除", () => {
    const html = `<h2>示例标题</h2>${filler}`;
    const out = stripDuplicateLeadingHeading(html, ["示例标题"]);
    expect(out).not.toContain("<h2>");
    expect(out).toContain("这是一段足够长的正文内容");
  });

  it("首标题与文档标题不同时保留", () => {
    const html = `<h2>完全不同的标题</h2>${filler}`;
    const out = stripDuplicateLeadingHeading(html, ["示例标题"]);
    expect(out).toContain("完全不同的标题");
  });

  it("文档标题以「首标题 + 分隔符」开头时视为重复", () => {
    for (const separator of ["|", "·", "—", "-", "::"]) {
      const html = `<h2>使用指南</h2>${filler}`;
      const out = stripDuplicateLeadingHeading(html, [`使用指南 ${separator} 站点名`]);
      expect(out, `分隔符 ${separator} 未命中`).not.toContain("<h2>");
    }
  });

  it("只移除第一个重复标题，保留后续同名标题", () => {
    const html = `<h2>示例标题</h2>${filler}<h2>示例标题</h2>${filler}`;
    const out = stripDuplicateLeadingHeading(html, ["示例标题"]);
    expect(out.match(/<h2>/g)?.length).toBe(1);
  });

  it("首标题之前若已有正文则不视为文章标题", () => {
    const html = `${filler}<h2>示例标题</h2>${filler}`;
    const out = stripDuplicateLeadingHeading(html, ["示例标题"]);
    expect(out).toContain("<h2>示例标题</h2>");
  });

  it("标题比对忽略空白与大小写", () => {
    const html = `<h2>  Example   Title  </h2>${filler}`;
    expect(stripDuplicateLeadingHeading(html, ["example title"])).not.toContain("<h2>");
  });

  it("没有标题的正文不受影响", () => {
    const html = filler;
    expect(stripDuplicateLeadingHeading(html, ["示例标题"])).toBe(html);
  });

  it("空标题列表时不改变内容", () => {
    const html = `<h2>示例标题</h2>${filler}`;
    expect(stripDuplicateLeadingHeading(html, [])).toBe(html);
  });

  it("保留正文标题的原始层级（h3-h6 不受影响）", () => {
    const html = `<h2>示例标题</h2>${filler}<h3>三级</h3>${filler}<h4>四级</h4>${filler}`;
    const out = stripDuplicateLeadingHeading(html, ["示例标题"]);
    expect(out).toContain("<h3>三级</h3>");
    expect(out).toContain("<h4>四级</h4>");
    expect(out).not.toContain("<h2>示例标题</h2>");
  });
});

describe("端到端：标题层级还原", () => {
  it("h1 降级产生的重复标题被去除，其余层级保持原样", () => {
    const html = page(
      "示例标题",
      `<h1>示例标题</h1>${filler}<h2>二级标题</h2>${filler}<h3>三级标题</h3>${filler}`,
    );
    const result = extractContent(html, "http://x.test/a");
    expect(result).not.toBeNull();

    const content = result!.contentHtml;
    // Readability 把 h1 映射为 h2，该重复标题应被移除
    expect(content).not.toMatch(/<h[12][^>]*>示例标题<\/h[12]>/);
    // 原文的 h2、h3 保持原层级
    expect(content).toMatch(/<h2[^>]*>二级标题<\/h2>/);
    expect(content).toMatch(/<h3[^>]*>三级标题<\/h3>/);
  });
});

/**
 * 回归：文档站把 `<title>` 写成站点级固定文案时，标题必须取自页面自己的 h1。
 *
 * OPPO、vivo 的开放平台每页的 `<title>` 都是同一串（如
 * `OPPO 开放平台-OPPO开发者服务中心`），页面真正的名字在正文的 `<h1>` 里。
 * 更麻烦的是 Readability 的 `_headerDuplicatesTitle` 会按 0.75 的相似度阈值
 * 把这个 h1 当作「与标题重复」删掉，因此必须在交给它之前先取到。
 */
describe("文档标题的取值", () => {
  /** 模拟文档站：<title> 站点级固定，页面自己的名字在 h1 里。 */
  function docSitePage(h1: string, title = "OPPO 开放平台-OPPO开发者服务中心"): string {
    return page(title, `<h1>${h1}</h1>${filler}<h3>1. 定义</h3>${filler}`);
  }

  it("站点级 <title> 相同的两个页面，标题各自不同", () => {
    const a = extractContent(docSitePage("OPPO开发者服务协议"), "http://x.test/a");
    const b = extractContent(docSitePage("OPPO 开放平台个人信息保护政策"), "http://x.test/b");

    expect(a?.title).toBe("OPPO开发者服务协议");
    expect(b?.title).toBe("OPPO 开放平台个人信息保护政策");
    expect(a?.title).not.toBe(b?.title);
  });

  it("取自 h1 而不是站点级的 <title>", () => {
    const result = extractContent(docSitePage("OPPO开发者服务协议"), "http://x.test/a");
    expect(result?.title).not.toContain("OPPO 开放平台-OPPO开发者服务中心");
  });

  it("作为标题的 h1 不会在正文里重复出现", () => {
    const result = extractContent(docSitePage("OPPO开发者服务协议"), "http://x.test/a");
    expect(result?.contentHtml).not.toMatch(/<h[12][^>]*>OPPO开发者服务协议<\/h[12]>/);
  });

  it("页面没有 h1 时退回 <title>", () => {
    const html = page("某站点名", `${filler}<h3>小节</h3>${filler}`);
    const result = extractContent(html, "http://x.test/a");
    expect(result?.title).toBe("某站点名");
  });

  it("标题带栏目后缀的页面也取短标题", () => {
    const html = page(
      "变量：全局变量<GlobalVariable>-基础功能-HarmonyOS 5.0及以上版本主题引擎规范 - 华为HarmonyOS开发者",
      `<h1>变量：全局变量&lt;GlobalVariable&gt;</h1>${filler}`,
    );
    const result = extractContent(html, "http://x.test/a");
    expect(result?.title).toBe("变量：全局变量<GlobalVariable>");
  });

  it("h1 为空时忽略它，继续往下找", () => {
    const html = page("兜底标题", `<h1>   </h1><h1>真正的标题</h1>${filler}`);
    const result = extractContent(html, "http://x.test/a");
    expect(result?.title).toBe("真正的标题");
  });
});

/**
 * 回归：文档标题不一定用 `<h1>` 渲染。
 *
 * 有些站点用 `<span>` / `<div>` / `<p>` 再挂一个 `title` 类来渲染文档标题。
 * 只看标签会漏掉，退回站点级的 `<title>`，导致所有文档标题都一样。
 * 因此改为**按内容结构判断**：不预设标签名，只要求元素带「标题」命名、
 * 位于正文区域、文本长度合理。
 */
describe("文档标题：不依赖标签，按结构判断", () => {
  /** 没有 h1，标题由 span / div / p 加 title 类渲染。 */
  function titleByMarkup(tag: string, attrs: string): string {
    return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>某开放平台</title></head><body>
      <div id="app">
        <${tag} ${attrs}>接入指南</${tag}>
        ${filler}
        <h3>第一步</h3>${filler}
      </div>
    </body></html>`;
  }

  it("识别 div.title 渲染的标题", () => {
    const result = extractContent(titleByMarkup("div", 'class="title"'), "http://x.test/a");
    expect(result?.title).toBe("接入指南");
  });

  it("识别 span.title 渲染的标题", () => {
    const result = extractContent(titleByMarkup("span", 'class="title"'), "http://x.test/a");
    expect(result?.title).toBe("接入指南");
  });

  it("识别 p.title 渲染的标题", () => {
    const result = extractContent(titleByMarkup("p", 'class="title"'), "http://x.test/a");
    expect(result?.title).toBe("接入指南");
  });

  it("识别复合类名与 id 写法", () => {
    for (const attrs of ['class="doc-title"', 'class="article_title"', 'class="title-wrap"', 'id="page-title"']) {
      const result = extractContent(titleByMarkup("div", attrs), "http://x.test/a");
      expect(result?.title, `${attrs} 未被识别`).toBe("接入指南");
    }
  });

  it("不把 subtitle 之类的类名当作标题", () => {
    const result = extractContent(titleByMarkup("div", 'class="subtitle"'), "http://x.test/a");
    expect(result?.title).not.toBe("接入指南");
  });

  it("站点外壳（导航/页头/页脚）里的 title 不算文章标题", () => {
    const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>站点级标题</title></head><body>
      <header><div class="title">站点名</div></header>
      <nav><span class="title">导航标题</span></nav>
      <article>${filler}</article>
      <footer><p class="title">版权信息</p></footer>
    </body></html>`;

    const result = extractContent(html, "http://x.test/a");
    expect(result?.title).not.toBe("站点名");
    expect(result?.title).not.toBe("导航标题");
    expect(result?.title).not.toBe("版权信息");
  });

  it("包住整个文档的 title 容器因文本过长被排除", () => {
    const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>兜底</title></head><body>
      <div class="title">${filler}${filler}${filler}</div>
    </body></html>`;

    const result = extractContent(html, "http://x.test/a");
    expect(result?.title).not.toContain("这是一段足够长的正文内容");
  });

  it("h1 存在时优先用 h1，不回退到 title 类", () => {
    const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>站点级</title></head><body>
      <div class="title">次要标题</div>
      <article><h1>真正的标题</h1>${filler}</article>
    </body></html>`;

    expect(extractContent(html, "http://x.test/a")?.title).toBe("真正的标题");
  });

  it("多个候选时取文档顺序最靠前的", () => {
    const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>站点级</title></head><body>
      <div id="app">
        <div class="title">第一个标题</div>
        ${filler}
        <div class="title">第二个标题</div>
      </div>
    </body></html>`;

    expect(extractContent(html, "http://x.test/a")?.title).toBe("第一个标题");
  });

  it("没有 h1 也没有 title 类时，取正文开头的标题", () => {
    // 荣耀的文档站就是这种结构：正文标题与小节标题同级，只能靠「正文开头」定位
    const html = page("站点级标题", `<h3>功能描述</h3>${filler}`);
    expect(extractContent(html, "http://x.test/a")?.title).toBe("功能描述");
  });

  it("正文开头之前已有段落时，退回 <title>", () => {
    const html = page("站点级标题", `${filler}<h3>小节</h3>${filler}`);
    expect(extractContent(html, "http://x.test/a")?.title).toBe("站点级标题");
  });

  it("候选嵌套时只取最内层，不带上旁边的按钮", () => {
    // 荣耀的文档站结构：外层 div 与内层 span 都带 title 命名，
    // 外层还会把「智能摘要」按钮的文本一并带上
    const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>站点级</title></head><body>
      <div id="content-box">
        <div class="document-title">
          <span class="title">锁屏、桌面、桌面小组件联动</span>
          <span class="document-title-summary-button"><i class="icon"></i><span class="text">智能摘要</span></span>
        </div>
        ${filler}
      </div>
    </body></html>`;

    const result = extractContent(html, "http://x.test/a");
    expect(result?.title).toBe("锁屏、桌面、桌面小组件联动");
    expect(result?.title).not.toContain("智能摘要");
  });

  it("id/class 层面的导航容器里的 title 不算文章标题", () => {
    // 只看 <nav>/<header> 标签不够：不少站点用 div#header、.menu-title 之类的命名
    const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>站点级</title></head><body>
      <div id="header"><div class="customer-dialog-wrapper"><div class="dialog">
        <span class="dialog-title">智能客服声明</span>
      </div></div></div>
      <div class="changeMore"><div class="menu-title"><div class="item"><div class="title">应用分发</div></div></div></div>
      <div id="content-box"><span class="title">真正的标题</span>${filler}</div>
    </body></html>`;

    expect(extractContent(html, "http://x.test/a")?.title).toBe("真正的标题");
  });

  it("导航里的 title 全部被排除时，退回正文开头的标题", () => {
    const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>站点级</title></head><body>
      <div class="menu-title"><div class="title">应用分发</div></div>
      <div id="content-box"><h3>功能描述</h3>${filler}</div>
    </body></html>`;

    expect(extractContent(html, "http://x.test/a")?.title).toBe("功能描述");
  });
});
