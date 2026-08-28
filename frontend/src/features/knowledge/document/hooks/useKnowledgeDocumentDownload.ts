// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { useCallback } from 'react'

import { downloadAttachment, isVideoFileName } from '@/apis/attachments'
import { getKnowledgeVideoDownloader } from '../video-download-registry'

/**
 * Unified knowledge-base document download.
 *
 * Routes video files through the registered `KnowledgeVideoDownloader`
 * (Weibo-backed videos are stored as a fid, not local bytes, so the generic
 * `/attachments/{id}/download` endpoint rejects them). Non-video files fall
 * through to the standard `downloadAttachment`.
 *
 * Used by `DocumentItem`, `knowledge-document-tree-grid`, and
 * `DocumentDetailDialog` so all three download entry points behave
 * consistently. Callers are responsible for their own error UI (toast).
 */
export function useKnowledgeDocumentDownload() {
  return useCallback(
    async (document: {
      attachment_id?: number | null
      name: string
      source_type: string
    }): Promise<void> => {
      if (!document.attachment_id) return
      if (document.source_type === 'external') {
        await downloadAttachment(document.attachment_id)
        return
      }
      if (document.source_type !== 'file') return

      if (isVideoFileName(document.name)) {
        let downloader = getKnowledgeVideoDownloader()
        if (!downloader) {
          // Eagerly load the KB extension bundle so the video downloader is
          // registered before first use.
          const { loadKBExtensions } = await import('../extension-loader')
          await loadKBExtensions()
          downloader = getKnowledgeVideoDownloader()
        }
        if (downloader) {
          await downloader(document.attachment_id, document.name)
          return
        }
        // No registered video downloader — fall back to generic download.
      }

      await downloadAttachment(document.attachment_id, document.name)
    },
    []
  )
}
