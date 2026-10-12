// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useCallback, useSyncExternalStore } from 'react'

import { synchronizeExternalDocument } from '@/apis/knowledge'
import { toast } from '@/hooks/use-toast'
import { useTranslation } from '@/hooks/useTranslation'
import type { KnowledgeDocument } from '@/types/knowledge'

import { mapKnowledgeDocumentErrorMessage } from '../utils/error-messages'

/**
 * Copies with a synchronization request in flight, shared by every surface.
 *
 * The list and the document preview each hold their own hook instance, so the
 * guard lives outside React: without it both surfaces could queue the same
 * refresh, and the backend rejects the second one as still processing.
 */
const inFlightDocumentIds = new Set<number>()
const listeners = new Set<() => void>()
let snapshot: number[] = []

function emitChange() {
  listeners.forEach(listener => listener())
}

function subscribe(listener: () => void) {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

function getSnapshot() {
  return snapshot
}

function markSyncing(documentId: number, syncing: boolean): void {
  if (inFlightDocumentIds.has(documentId) === syncing) return
  if (syncing) inFlightDocumentIds.add(documentId)
  else inFlightDocumentIds.delete(documentId)
  snapshot = Array.from(inFlightDocumentIds)
  emitChange()
}

/**
 * Queue a manual refresh of one imported external document.
 *
 * The knowledge base list and the document detail preview share this entry so
 * both surfaces queue the same request, share one in-flight state per copy, and
 * report the same failure reason.
 */
export function useExternalDocumentSync() {
  const { t } = useTranslation('knowledge')
  const syncingDocumentIds = useSyncExternalStore(subscribe, getSnapshot, getSnapshot)

  const isSyncing = useCallback(
    (documentId: number) => syncingDocumentIds.includes(documentId),
    [syncingDocumentIds]
  )

  const syncDocument = useCallback(
    async (document: KnowledgeDocument): Promise<boolean> => {
      // A copy another surface is already synchronizing queues no second
      // request; the caller only skips the reload that request would trigger.
      if (inFlightDocumentIds.has(document.id)) return false
      markSyncing(document.id, true)
      try {
        await synchronizeExternalDocument(document.id)
        toast({ description: t('document.document.syncSuccess') })
        return true
      } catch (err) {
        toast({
          variant: 'destructive',
          description: mapKnowledgeDocumentErrorMessage(err, t, 'document.document.syncFailed'),
        })
        return false
      } finally {
        markSyncing(document.id, false)
      }
    },
    [t]
  )

  return { isSyncing, syncDocument }
}
