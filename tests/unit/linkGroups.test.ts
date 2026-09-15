import { describe, expect, it } from "vitest";

import {
  buildLinkGroups,
  defaultExpandedGroups,
  estimateMinSeconds,
  hostOf,
  problemIndexes,
  visibleIndexes,
} from "../../src/services/linkGroups";
import type { UrlCheck } from "../../src/types";

/** 造一条校验结果。 */
function check(overrides: Partial<UrlCheck> = {}): UrlCheck {
  return {
    raw: "https://example.com/a",
    key: "https://example.com/a",
    docGroup: "example.com",
    error: null,
    duplicateOf: null,
    ...overrides,
  };
}

const ok = (group: string) => check({ docGroup: group });
const bad = () => check({ key: null, docGroup: null, error: "URL 格式不合法" });
const dup = (of: number, group: string) => check({ docGroup: group, duplicateOf: of });

describe("buildLinkGroups", () => {
  it("同分组的条目归到一起", () => {
    const entries = ["a", "b", "c"];
    const checks = [ok("example.com/docs"), ok("example.com/docs"), ok("example.com/docs")];

    const groups = buildLinkGroups(entries, checks);
    expect(groups).toHaveLength(1);
    expect(groups[0].label).toBe("example.com/docs");
    expect(groups[0].indexes).toEqual([0, 1, 2]);
  });

  it("不同分组各自成组", () => {
    const entries = ["a", "b"];
    const checks = [ok("example.com/docs"), ok("example.com/blog")];

    const groups = buildLinkGroups(entries, checks);
    expect(groups).toHaveLength(2);
    expect(groups.map((g) => g.label)).toEqual(["example.com/docs", "example.com/blog"]);
  });

  it("组内条目保持输入顺序", () => {
    const entries = ["a", "b", "c", "d"];
    const checks = [ok("x.com/1"), ok("y.com/1"), ok("x.com/1"), ok("y.com/1")];

    const groups = buildLinkGroups(entries, checks);
    const x = groups.find((g) => g.label === "x.com/1")!;
    expect(x.indexes).toEqual([0, 2]);
  });

  // 关键行为：100 条里排查几条错误不该靠滚动去找
  it("有问题的组排在最前", () => {
    const entries = ["a", "b", "c"];
    const checks = [ok("ok1.com"), bad(), ok("ok2.com")];

    const groups = buildLinkGroups(entries, checks);
    expect(groups[0].label).toBe("", "未归组（出错的行）应排在最前");
    expect(groups[0].problemCount).toBe(1);
  });

  it("统计组内问题条数（格式错误与重复都算）", () => {
    const entries = ["a", "b", "c"];
    const checks = [ok("g.com"), bad(), dup(0, "g.com")];

    // 出错的行落在未归组；重复的行仍留在自己的分组里
    const groups = buildLinkGroups(entries, checks);
    const ungrouped = groups.find((g) => g.label === "")!;
    const grouped = groups.find((g) => g.label === "g.com")!;

    expect(ungrouped.problemCount).toBe(1);
    expect(grouped.problemCount).toBe(1, "重复项应计入所在组的问题数");
    expect(grouped.indexes).toEqual([0, 2], "重复项仍留在原分组");
  });

  it("尚未校验的条目也归入未归组，不会丢失", () => {
    const entries = ["a", "b"];
    const checks: UrlCheck[] = [];

    const groups = buildLinkGroups(entries, checks);
    expect(groups).toHaveLength(1);
    expect(groups[0].indexes).toEqual([0, 1]);
    expect(groups[0].problemCount).toBe(0);
  });

  it("空输入返回空数组", () => {
    expect(buildLinkGroups([], [])).toEqual([]);
  });
});

describe("problemIndexes", () => {
  it("列出格式错误与重复的条目下标", () => {
    const checks = [ok("g.com"), bad(), dup(0), ok("g.com")];
    expect(problemIndexes(checks)).toEqual([1, 2]);
  });

  it("全部正常时返回空数组", () => {
    expect(problemIndexes([ok("g.com"), ok("g.com")])).toEqual([]);
  });
});

describe("visibleIndexes", () => {
  it("关闭筛选时返回全部条目", () => {
    const entries = ["a", "b", "c"];
    const checks = [ok("g.com"), bad(), ok("g.com")];
    expect(visibleIndexes(entries, checks, false)).toEqual([0, 1, 2]);
  });

  it("开启筛选时只返回有问题的条目", () => {
    const entries = ["a", "b", "c"];
    const checks = [ok("g.com"), bad(), ok("g.com")];
    expect(visibleIndexes(entries, checks, true)).toEqual([1]);
  });
});

describe("defaultExpandedGroups", () => {
  it("分组很少时全部展开", () => {
    const groups = buildLinkGroups(["a", "b"], [ok("x.com"), ok("y.com")]);
    const expanded = defaultExpandedGroups(groups);
    expect(expanded.size).toBe(2);
  });

  it("分组很多时只展开有问题的组", () => {
    const entries = ["a", "b", "c", "d", "e"];
    const checks = [ok("g1.com"), ok("g2.com"), bad(), ok("g3.com"), ok("g4.com")];

    const groups = buildLinkGroups(entries, checks);
    expect(groups.length).toBeGreaterThan(3);

    const problemGroup = groups.find((g) => g.problemCount > 0)!;
    expect(problemGroup, "应当存在一个有问题的分组").toBeDefined();

    const expanded = defaultExpandedGroups(groups);
    expect(expanded.has(problemGroup.key)).toBe(true);
    expect(expanded.size).toBe(1, "只展开有问题的组");
  });

  it("分组很多且都正常时全部收起", () => {
    const entries = ["a", "b", "c", "d"];
    const checks = [ok("g1"), ok("g2"), ok("g3"), ok("g4")];

    const groups = buildLinkGroups(entries, checks);
    expect(defaultExpandedGroups(groups).size).toBe(0);
  });
});

describe("hostOf", () => {
  it("取出主机部分", () => {
    expect(hostOf("developer.huawei.com/consumer/cn/doc")).toBe("developer.huawei.com");
  });

  it("没有路径时就是主机本身", () => {
    expect(hostOf("example.com")).toBe("example.com");
  });
});

describe("estimateMinSeconds", () => {
  // 同站串行是真正决定耗时的因素，与总条数无关
  it("按同一主机下最多的条目数估算", () => {
    const entries = ["a", "b", "c"];
    const checks = [
      ok("example.com/docs"),
      ok("example.com/blog"),
      ok("other.com/x"),
    ];

    const groups = buildLinkGroups(entries, checks);
    // example.com 下共 2 条 → 至少 2 秒
    expect(estimateMinSeconds(groups)).toBe(2);
  });

  it("跨多个站点时取最多的那一组", () => {
    const entries = ["a", "b", "c", "d"];
    const checks = [ok("a.com/x"), ok("b.com/x"), ok("c.com/x"), ok("a.com/y")];

    const groups = buildLinkGroups(entries, checks);
    expect(estimateMinSeconds(groups)).toBe(2);
  });

  it("无条目时为 0", () => {
    expect(estimateMinSeconds([])).toBe(0);
  });

  it("可传入不同的间隔", () => {
    const entries = ["a", "b"];
    const checks = [ok("x.com/1"), ok("x.com/2")];

    const groups = buildLinkGroups(entries, checks);
    expect(estimateMinSeconds(groups, 3)).toBe(6);
  });
});
