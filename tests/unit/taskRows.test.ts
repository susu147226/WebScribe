import { describe, expect, it } from "vitest";

import { createPendingRow, createPendingRows } from "../../src/services/taskRows";

/**
 * 回归测试。
 *
 * 曾出现过的问题：任务行的 key 误用用户输入的原始 URL，而所有进度与结果
 * 事件都以 Rust 规范化后的 key 关联任务。两者在 URL 带末尾斜杠、默认端口
 * 或大写主机名时并不相同，导致这些 URL 的任务行永远停在「等待中」。
 */

describe("createPendingRow", () => {
  it("key 取自规范化值，而非原始输入", () => {
    // Rust 侧 normalize 会把 https://example.com/a/ 归一为 https://example.com/a
    const row = createPendingRow("https://example.com/a", "https://example.com/a/");

    expect(row.key).toBe("https://example.com/a");
    expect(row.url).toBe("https://example.com/a/");
  });

  it("key 与 url 不同时也不会串位", () => {
    const row = createPendingRow("https://example.com:8443/a", "HTTPS://EXAMPLE.com:8443/a");
    expect(row.key).toBe("https://example.com:8443/a");
    expect(row.url).toBe("HTTPS://EXAMPLE.com:8443/a");
  });

  it("初始状态为等待中", () => {
    const row = createPendingRow("https://example.com/a", "https://example.com/a");
    expect(row.state).toBe("Pending");
    expect(row.stateLabel).toBe("等待中");
    expect(row.progress).toBe(0);
  });

  it("初始不带错误与输出文件", () => {
    const row = createPendingRow("https://example.com/a", "https://example.com/a");
    expect(row.errorKind).toBeNull();
    expect(row.errorMessage).toBeNull();
    expect(row.errorDetail).toBeNull();
    expect(row.isDefense).toBe(false);
    expect(row.outputFiles).toEqual([]);
    expect(row.title).toBe("");
  });
});

describe("createPendingRows", () => {
  it("按输入顺序逐条创建", () => {
    const rows = createPendingRows([
      { key: "https://a.com", raw: "https://a.com/" },
      { key: "https://b.com", raw: "https://b.com" },
    ]);

    expect(rows).toHaveLength(2);
    expect(rows[0].key).toBe("https://a.com");
    expect(rows[0].url).toBe("https://a.com/");
    expect(rows[1].key).toBe("https://b.com");
  });

  it("空输入返回空数组", () => {
    expect(createPendingRows([])).toEqual([]);
  });

  it("每一行的 key 都与后续事件可匹配", () => {
    // 模拟 Rust 侧 validate_urls 的返回：raw 带末尾斜杠，key 已归一
    const accepted = [
      { key: "https://example.com/a", raw: "https://example.com/a/" },
      { key: "https://example.com/b", raw: "https://example.com/b" },
    ];

    const rows = createPendingRows(accepted);

    // 进度事件携带的 key 与任务行的 key 必须一一对应
    for (const event of accepted) {
      const matched = rows.filter((row) => row.key === event.key);
      expect(matched, `key ${event.key} 未能匹配到任务行`).toHaveLength(1);
    }
  });
});
