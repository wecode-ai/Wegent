// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * Truncate text to a maximum length, keeping a prefix and suffix joined
 * by an ellipsis (`...`) in the middle. Useful for displaying long
 * identifiers (repo URLs, branch names) within tight UI widths.
 *
 * If `text.length <= maxLength`, the original text is returned unchanged.
 * Otherwise the first `startChars` and last `endChars` are kept and the
 * middle is replaced by `...`. The returned string's length is
 * `min(text.length, startChars) + min(text.length, endChars) + 3`,
 * independent of `maxLength`. When `startChars` and `endChars` are
 * within the text bounds, this simplifies to `startChars + endChars + 3`.
 *
 * Negative or zero values for `startChars` / `endChars` are clamped to `0`,
 * so `truncateMiddle(text, 5, 0, 0)` returns `'...'`.
 *
 * @param text - The text to truncate
 * @param maxLength - Length threshold above which truncation occurs
 * @param startChars - Number of characters to keep at the start (default: 8).
 *   Clamped to `>= 0` if a negative value is provided.
 * @param endChars - Number of characters to keep at the end (default: 10).
 *   Clamped to `>= 0` if a negative value is provided.
 * @returns Original text when short enough, otherwise `{start}...{end}`
 *
 * @example
 * truncateMiddle('hello', 10)                           // 'hello'
 * truncateMiddle('abcdefghijklmnop', 10, 4, 4)         // 'abcd...mnop'
 * truncateMiddle('https://github.com/x/y', 15, 10, 5)  // 'https://gi...m/x/y'
 * truncateMiddle('abcdefghijklmnop', 10, 0, 0)         // '...'
 *
 * @remarks
 * Known limitation: Unicode astral characters (emoji, some CJK) may be
 * split mid-codepoint because `String.prototype.slice` operates on UTF-16
 * code units, not Unicode code points.
 */
export function truncateMiddle(
  text: string,
  maxLength: number,
  startChars = 8,
  endChars = 10
): string {
  if (text.length <= maxLength) {
    return text
  }

  const clampedStart = Math.max(0, startChars)
  const clampedEnd = Math.max(0, endChars)
  const start = text.slice(0, clampedStart)
  const end = clampedEnd > 0 ? text.slice(-clampedEnd) : ''
  return `${start}...${end}`
}
