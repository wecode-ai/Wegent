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
 * middle is replaced by `...`. The returned string's length is always
 * `startChars + endChars + 3`, independent of `maxLength`.
 *
 * @param text - The text to truncate
 * @param maxLength - Length threshold above which truncation occurs
 * @param startChars - Number of characters to keep at the start (default: 8)
 * @param endChars - Number of characters to keep at the end (default: 10)
 * @returns Original text when short enough, otherwise `{start}...{end}`
 *
 * @example
 * truncateMiddle('hello', 10)                        // 'hello'
 * truncateMiddle('abcdefghijklmnop', 10, 4, 4)      // 'abcd...mnop'
 * truncateMiddle('https://github.com/x/y', 15, 10, 5)  // 'https://gi...m/x/y'
 *
 * @remarks
 * Known limitations (not handled by this implementation):
 * - Unicode astral characters (emoji, some CJK) may be split mid-codepoint
 *   because `String.prototype.slice` operates on UTF-16 code units.
 * - Negative `startChars` / `endChars` are not validated; behavior follows
 *   native `slice` semantics (counting from the opposite end).
 * - `endChars = 0` does **not** produce an empty suffix. Because
 *   `String.prototype.slice(-0)` is equivalent to `slice(0)`, the entire
 *   string is returned as the suffix. Use `endChars >= 1` as the minimum.
 * These edge cases are intentionally out of scope; see corresponding
 * `it.todo` entries in the test file for future hardening.
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

  const start = text.slice(0, startChars)
  const end = text.slice(-endChars)
  return `${start}...${end}`
}
