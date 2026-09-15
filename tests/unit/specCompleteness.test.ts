import { describe, expect, it } from "vitest";

import {
  ERROR_LABELS,
  FALLBACK_LINK_LIMIT_TIERS,
  MAX_PAGINATION,
  STATE_LABELS,
  type CrawlErrorKind,
  type TaskState,
} from "../../src/types";

/**
 * 文档一致性测试。
 *
 * 这些断言用来防止后续修改悄悄丢掉某个状态或错误类型——
 * 文档第 36、37 条分别明确列出了 11 种任务状态与 15 种错误类型。
 */

const DOC_TASK_STATES: TaskState[] = [
  "Pending",
  "Fetching",
  "Rendering",
  "Extracting",
  "Converting",
  "Saving",
  "Completed",
  "Skipped",
  "Failed",
  "Blocked",
  "RequiresLogin",
];

const DOC_ERROR_KINDS: CrawlErrorKind[] = [
  "InvalidURL",
  "NetworkError",
  "Timeout",
  "HTTPError",
  "AccessDenied",
  "RateLimited",
  "CaptchaDetected",
  "ChallengeDetected",
  "LoginRequired",
  "PageRenderFailed",
  "ContentExtractionFailed",
  "MarkdownConversionFailed",
  "PDFConversionFailed",
  "SaveFailed",
  "DuplicateURL",
];

describe("文档第 36 条：任务状态", () => {
  it("共 11 种", () => {
    expect(DOC_TASK_STATES).toHaveLength(11);
  });

  it("每一种都有中文说明", () => {
    for (const state of DOC_TASK_STATES) {
      expect(STATE_LABELS[state], `${state} 缺少说明`).toBeTruthy();
    }
  });

  it("说明表没有多余条目", () => {
    expect(Object.keys(STATE_LABELS).sort()).toEqual([...DOC_TASK_STATES].sort());
  });
});

describe("文档第 37 条：错误类型", () => {
  it("共 15 种", () => {
    expect(DOC_ERROR_KINDS).toHaveLength(15);
  });

  it("每一种都有中文说明", () => {
    for (const kind of DOC_ERROR_KINDS) {
      expect(ERROR_LABELS[kind], `${kind} 缺少说明`).toBeTruthy();
    }
  });

  it("说明表没有多余条目", () => {
    expect(Object.keys(ERROR_LABELS).sort()).toEqual([...DOC_ERROR_KINDS].sort());
  });
});

describe("上限常量", () => {
  it("自动续页上限为 5", () => {
    expect(MAX_PAGINATION).toBe(5);
  });

  it("链接数量档位由小到大且包含 10", () => {
    const tiers = FALLBACK_LINK_LIMIT_TIERS;
    expect(tiers).toContain(10);
    expect([...tiers].sort((a, b) => a - b)).toEqual(tiers);
  });

  it("档位均为正整数", () => {
    for (const tier of FALLBACK_LINK_LIMIT_TIERS) {
      expect(Number.isInteger(tier) && tier > 0, `${tier} 不是正整数`).toBe(true);
    }
  });
});
