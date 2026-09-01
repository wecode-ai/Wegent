// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { useCallback } from 'react'

import { isVideoFileName } from '@/apis/attachments'
import { downloadKnowledgeDocument } from '@/apis/knowledge'
import { getKnowledgeVideoDownloader } from '../video-download-registry'

/**
 * Unified knowledge-base document download.
 *
 * The core path always asks the document-scoped knowledge endpoint for a
 * download token. Internal deployments may register a video downloader for
 * non-local video storage; it is used only after the caller has allowed the
 * document download action.
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

      await downloadKnowledgeDocument(document.id, document.name)
    },
    []
  )
}
