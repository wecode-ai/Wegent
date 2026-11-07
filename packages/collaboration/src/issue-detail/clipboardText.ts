// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

const LOCAL_FILE_URL_LINE = /^file:(?:\/\/|\\\\)/i;

export function stripLocalFileUrlsFromClipboardText(value: string): string {
  const lines = value.split(/\r?\n/);
  const kept = lines.filter((line) => !LOCAL_FILE_URL_LINE.test(line.trim()));
  if (kept.length === lines.length) return value;
  return kept.join("\n").replace(/^\n+|\n+$/g, "");
}
