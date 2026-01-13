// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * Truncate text to a maximum length, keeping start and end with ellipsis in the middle
 * @param text - The text to truncate
 * @param maxLength - Maximum length of the text
 * @param startChars - Number of characters to keep at the start (default: 8)
 * @param endChars - Number of characters to keep at the end (default: 10)
 * @returns Truncated text with ellipsis in the middle if needed
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
