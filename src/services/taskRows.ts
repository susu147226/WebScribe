import { STATE_LABELS, type TaskRow } from "../types";

/**
 * 任务行的构造。
 *
 * 独立成模块以便单元测试 —— 这里的 `key` 取值规则曾出过一次线上问题：
 * 若误用用户输入的原始 URL 作为 key，则凡是规范化后与原文不同的 URL
 * （带末尾斜杠、默认端口、大写主机名等）都会因 key 对不上而永远停在
 * 「等待中」，因为所有进度与结果事件都以规范化 key 关联任务。
 */

/** 创建一个处于「等待中」的任务行。 */
export function createPendingRow(key: string, raw: string): TaskRow {
  return {
    key,
    url: raw,
    title: "",
    state: "Pending",
    stateLabel: STATE_LABELS.Pending,
    step: "等待中",
    progress: 0,
    errorKind: null,
    errorMessage: null,
    errorDetail: null,
    isDefense: false,
    outputFiles: [],
  };
}

/** 由去重后的 URL 条目批量创建任务行。 */
export function createPendingRows(
  entries: ReadonlyArray<{ key: string; raw: string }>,
): TaskRow[] {
  return entries.map((entry) => createPendingRow(entry.key, entry.raw));
}
