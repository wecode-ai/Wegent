// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { useCallback } from 'react'

import { downloadAttachment, isVideoFileName } from '@/apis/attachments'
import { getKnowledgeVideoDownloader } from '../video-download-registry'

/**
 * Unified knowledge-base document download.
 *
 * The core path uses the shared attachment download endpoint, where the
 * backend applies the knowledge-document policy only to KB attachments.
 * Internal deployments may register a video downloader for non-local video
 * storage; it is used only after the caller has allowed the action.
 */
export function useKnowledgeDocumentDownload() {
  return useCallback(
    async (document: {
      id: number
      attachment_id?: number | null
      name: string
      source_type: string
    }): Promise<void> => {
      if (!document.attachment_id || document.source_type !== 'file') return

      if (isVideoFileName(document.name)) {
        let downloader = getKnowledgeVideoDownloader()
        if (!downloader) {
          const { loadKBExtensions } = await import('../extension-loader')
          await loadKBExtensions()
          downloader = getKnowledgeVideoDownloader()
        }
        if (downloader) {
          await downloader(document.attachment_id, document.name)
          return
        }
      }

      await downloadAttachment(document.attachment_id, document.name)
    },
    []
  )
}
