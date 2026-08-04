// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { useEffect } from 'react'
import { getDocument } from '@/apis/knowledge'
import type { KnowledgeDocument } from '@/types/knowledge'
import { isDocumentIndexActive } from '@/features/knowledge/multimodal/hooks/useDocumentIndexPolling'

interface UseOffPageDocumentPollingOptions {
  document: KnowledgeDocument | null
  visibleDocuments: KnowledgeDocument[]
  onUpdate: (document: KnowledgeDocument) => void
  intervalMs?: number
  fetchDocument?: (documentId: number, signal?: AbortSignal) => Promise<KnowledgeDocument>
}

/** Poll an active detail document that is outside the current paginated list. */
export function useOffPageDocumentPolling({
  document,
  visibleDocuments,
  onUpdate,
  intervalMs = 5000,
  fetchDocument = getDocument,
}: UseOffPageDocumentPollingOptions): void {
  const documentId = document?.id
  const shouldPoll =
    document !== null &&
    isDocumentIndexActive(document) &&
    !visibleDocuments.some(item => item.id === document.id)

  useEffect(() => {
    if (!documentId || !shouldPoll) return

    let stopped = false
    let inFlight = false
    let controller: AbortController | null = null

    const poll = async () => {
      if (inFlight || stopped) return
      inFlight = true
      controller = new AbortController()
      try {
        const updated = await fetchDocument(documentId, controller.signal)
        if (!stopped) onUpdate(updated)
      } catch (error) {
        if (!stopped && !(error instanceof DOMException && error.name === 'AbortError')) {
          // A later interval may recover from a transient request failure.
        }
      } finally {
        inFlight = false
      }
    }

    void poll()
    const interval = window.setInterval(() => void poll(), intervalMs)
    return () => {
      stopped = true
      controller?.abort()
      window.clearInterval(interval)
    }
  }, [documentId, fetchDocument, intervalMs, onUpdate, shouldPoll])
}
