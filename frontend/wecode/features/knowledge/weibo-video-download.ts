// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0
/**
 * Weibo KB video downloader — registers a KnowledgeVideoDownloader that
 * streams Weibo-backed KB video attachments through the backend proxy at
 * GET /knowledge-documents/attachments/{id}/video-download.
 *
 * Weibo videos have no local blob (the binary lives on Weibo's file platform /
 * CDN, unreachable + CORS-blocked from the browser), so the standard
 * /attachments/{id}/download path cannot serve them. The backend proxy holds
 * the TAuth2 creds, resolves fid→CDN URL, and streams the bytes back.
 *
 * Registered as a side effect of loading @wecode/features/knowledge.
 */

import { getToken } from '@/apis/user'
import { registerKnowledgeVideoDownloader } from '@/features/knowledge/document/video-download-registry'

const VIDEO_DOWNLOAD_PATH = (attachmentId: number) =>
  `/api/knowledge-documents/attachments/${attachmentId}/video-download`

function parseFilenameFromDisposition(disposition: string | null, attachmentId: number): string {
  if (disposition) {
    // RFC 5987 filename*=UTF-8''<encoded>
    const utf8Match = disposition.match(/filename\*=UTF-8''([^;]+)/i)
    if (utf8Match) {
      try {
        return decodeURIComponent(utf8Match[1])
      } catch {
        return utf8Match[1]
      }
    }
    const plainMatch = disposition.match(/filename="?([^";]+)"?/i)
    if (plainMatch) {
      return plainMatch[1]
    }
  }
  return `video-${attachmentId}.mp4`
}

async function downloadKnowledgeVideo(attachmentId: number, filename?: string): Promise<void> {
  const token = getToken()
  const response = await fetch(VIDEO_DOWNLOAD_PATH(attachmentId), {
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}) },
  })
  if (!response.ok) {
    throw new Error('Failed to download video')
  }

  const blob = await response.blob()
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download =
    filename ||
    parseFilenameFromDisposition(response.headers.get('Content-Disposition'), attachmentId)
  document.body.appendChild(link)
  link.click()
  link.remove()
  URL.revokeObjectURL(url)
}

registerKnowledgeVideoDownloader(downloadKnowledgeVideo)
