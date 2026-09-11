// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

function twoDigits(value: number): string {
  return String(value).padStart(2, "0");
}

export interface DueDateSourceContext {
  sourceValue: string | null;
  sourceInputValue: string;
}

export function dueDateTimeLocalFromSource(value: string | null): string {
  if (!value) return "";
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return `${value}T00:00`;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return [
    date.getFullYear(),
    "-",
    twoDigits(date.getMonth() + 1),
    "-",
    twoDigits(date.getDate()),
    "T",
    twoDigits(date.getHours()),
    ":",
    twoDigits(date.getMinutes()),
  ].join("");
}

export function dueDateTimeLocalToSource(
  value: string,
  context?: DueDateSourceContext,
): string {
  if (!value) return "";
  // A date-only source is represented as local midnight in a datetime-local
  // input. Keep its original representation until that input actually changes.
  if (context && value === context.sourceInputValue) {
    return context.sourceValue ?? "";
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toISOString();
}
