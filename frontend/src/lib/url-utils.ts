// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

export function parseHostname(url?: string | null): string | undefined {
  if (!url) return undefined
  try {
    return new URL(url).hostname
  } catch {
    return url
  }
}
