/**
 * URL 输入解析。
 *
 * 独立成模块便于单元测试——输入解析的边界情况（空行、多余空白、超限）
 * 是文档第 16、17 条明确约束过的行为。
 */

/** 把输入框内容拆成非空 URL 行。 */
export function parseUrls(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

/**
 * 把新粘贴的文本并入已有输入。
 *
 * @returns 合并后的行数组与是否超出上限；超限时不做任何截断，
 *          由调用方提示用户（文档第 16 条：不得静默截断）。
 */
export function mergeUrls(
  existing: string,
  incoming: string,
  max: number,
): { urls: string[]; overLimit: boolean } {
  const merged = [...parseUrls(existing), ...parseUrls(incoming)];
  return { urls: merged, overLimit: merged.length > max };
}
