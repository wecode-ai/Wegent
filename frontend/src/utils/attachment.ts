// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

export const ATTACHMENT_SCHEME = 'attachment://'

export function parseAttachmentSchemeUrl(url?: string | null): number | null {
  if (!url) {
    return null
  }

  const trimmedUrl = url.trim()
  if (!trimmedUrl.startsWith(ATTACHMENT_SCHEME)) {
    return null
  }

  const match = trimmedUrl.match(/^attachment:\/\/(\d+)/)
  if (!match) {
    return null
  }

  const attachmentId = Number(match[1])
  if (!Number.isSafeInteger(attachmentId) || attachmentId <= 0) {
    return null
  }

  return attachmentId
}
