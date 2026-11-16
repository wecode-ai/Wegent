// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

const HTTP_PROTOCOLS = new Set(['http:', 'https:'])

export function safeAppPreviewUrl(url: string | null | undefined): string | null {
  if (!url?.trim()) return null

  try {
    const parsedUrl = new URL(url.trim())
    return HTTP_PROTOCOLS.has(parsedUrl.protocol) ? parsedUrl.toString() : null
  } catch {
    return null
  }
}
