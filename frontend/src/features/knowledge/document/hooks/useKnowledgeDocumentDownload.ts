// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { useCallback } from 'react'

import { downloadAttachment, isVideoFileName } from '@/apis/attachments'
import type { KnowledgeDocument } from '@/types/knowledge'
import { getKnowledgeVideoDownloader } from '../video-download-registry'

/**
 * Unified knowledge-base document download.
 *
 * The core path uses the shared attachment download endpoint, where the
 * backend applies the knowledge-document policy only to KB attachments.
 * Internal deployments may register a video downloader for non-local video
 * storage; it is used only after the caller has allowed the action. Imported
 * external documents also use the shared endpoint when they retain an
 * attachment snapshot.
 */
export function useKnowledgeDocumentDownload() {
  return useCallback(async (document: KnowledgeDocument): Promise<void> => {
    if (!document.attachment_id) return
    // Wiki sync copies and DingTalk Office files hand back the stored snapshot;
    // the source title is not a download filename.
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
  }, [])
}
