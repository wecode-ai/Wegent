// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { useEffect } from 'react'
import type { DocumentIndexStatus, KnowledgeDocument } from '@/types/knowledge'

/**
 * Index statuses representing an in-flight indexing/conversion. The document
 * list polls for updates while any document is in one of these states so the
 * UI reflects live progress (e.g. a 1–2 min multimodal Gemini re-analysis).
 */
const ACTIVE_INDEX_STATUSES = new Set<DocumentIndexStatus>([
  'pending_conversion',
  'converting',
  'queued',
  'indexing',
])

/**
 * Poll `refresh` while any document is in an active indexing state, stopping
 * once all documents reach a terminal state.
 *
 * Used by the document list to keep statuses in sync during slow background
 * work (multimodal Gemini analysis can take 1–2 min). The poll starts as soon
 * as an active status is present in `documents` — which happens naturally for
 * freshly-uploaded docs (they enter the list already active) and for
 * re-index/re-analyze (the caller `await refresh()` immediately after dispatch
 * so the new PENDING_CONVERSION status lands here and kicks off the poll).
 *
 * @param documents  Current document list (re-evaluated each render).
 * @param refresh    Refresh callback (e.g. re-fetch from the API).
 * @param intervalMs Polling interval (default 5s).
 */
export function useDocumentIndexPolling(
  documents: KnowledgeDocument[],
  refresh: () => void | Promise<void>,
  intervalMs = 5000
): void {
  const hasActiveIndexing = documents.some(d => ACTIVE_INDEX_STATUSES.has(d.index_status))
  useEffect(() => {
    if (!hasActiveIndexing) return
    const interval = setInterval(() => {
      refresh()
    }, intervalMs)
    return () => clearInterval(interval)
  }, [hasActiveIndexing, refresh, intervalMs])
}
