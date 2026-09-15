/**
 * URL 输入解析。
 *
 * 独立成模块便于单元测试 —— 输入解析的边界情况（空行、多余空白、一行多个
 * 链接、超出数量上限）都是容易出错又必须说清楚的地方。
 */

/** 匹配 URL 开头，用于把挤在一行的多个链接拆开。 */
const URL_START = /(?=https?:\/\/)/i;

/**
 * 把粘贴内容拆成一条条 URL。
 *
 * 同时处理两种常见情况：
 *
 * - 一行一个链接；
 * - **一行里挤了多个链接**（复制网页列表时很常见）—— 在 `http://` / `https://`
 *   之前切开，避免它们被当成一个畸形 URL。
 *
 * 无法识别的文本（如 `这不是URL`）原样保留为一条，交由后续校验给出具体原因，
 * 而不是在这里悄悄丢弃。
 */
export function splitUrls(text: string): string[] {
  const out: string[] = [];

  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;

    const parts = trimmed
      .split(URL_START)
      .map((part) => part.trim())
      .filter((part) => part.length > 0);

    out.push(...(parts.length > 0 ? parts : [trimmed]));
  }

  return out;
}

/**
 * 把新内容并入已有条目。
 *
 * @returns 合并后的条目与是否超出上限；超限时不做任何截断，
 *          由调用方提示用户，避免静默丢弃用户输入。
 */
export function mergeEntries(
  existing: readonly string[],
  incoming: string,
  max: number,
): { entries: string[]; overLimit: boolean } {
  const entries = [...existing, ...splitUrls(incoming)];
  return { entries, overLimit: entries.length > max };
}

/** 判断一行是否还空着（用于界面上提示「尚未填写」）。 */
export function isBlank(value: string): boolean {
  return value.trim().length === 0;
}
