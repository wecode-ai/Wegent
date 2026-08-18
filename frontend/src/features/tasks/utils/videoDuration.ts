// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

export function formatVideoDuration(
  duration: number | null | undefined,
  autoLabel: string
): string | undefined {
  if (duration == null) return undefined
  return duration === -1 ? autoLabel : `${duration}S`
}
