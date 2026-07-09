// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useCallback, useMemo, useState } from 'react'

import type { KnowledgeDocument } from '@/types/knowledge'
import type { KnowledgeResourceTreeIndex } from '../utils/resource-tree'

export interface KnowledgeResourceSelectionPayload {
  documentIds: number[]
  folderIds: number[]
}

export interface KnowledgeResourceSelectionSummary {
  documentCount: number
  folderCount: number
  hasDocumentSelection: boolean
  hasFolderScopeSelection: boolean
  canMoveDocuments: boolean
  canDeleteDocuments: boolean
  canTransfer: boolean
}

interface UseKnowledgeResourceSelectionOptions {
  documents: KnowledgeDocument[]
  treeIndex: KnowledgeResourceTreeIndex
}

export function shouldDisableDocumentBatchActions(options: {
  selectedDocumentCount: number
  selectedFolderCount: number
}) {
  return options.selectedDocumentCount === 0 || options.selectedFolderCount > 0
}

export function useKnowledgeResourceSelection({
  documents,
  treeIndex,
}: UseKnowledgeResourceSelectionOptions) {
  const [selectedDocumentIds, setSelectedDocumentIds] = useState<Set<number>>(new Set())
  const [selectedFolderIds, setSelectedFolderIds] = useState<Set<number>>(new Set())

  const resetSelection = useCallback(() => {
    setSelectedDocumentIds(new Set())
    setSelectedFolderIds(new Set())
  }, [])

  const setDocumentSelection = useCallback((ids: Set<number>) => {
    setSelectedDocumentIds(new Set(ids))
  }, [])

  const setFolderSelection = useCallback((ids: Set<number>) => {
    setSelectedFolderIds(new Set(ids))
  }, [])

  const selectedFolderScopeIds = useMemo(() => {
    const scopeIds = new Set<number>()
    selectedFolderIds.forEach(folderId => {
      const descendantIds = treeIndex.folderDescendantIds.get(folderId)
      if (descendantIds) {
        descendantIds.forEach(id => scopeIds.add(id))
      }
    })
    return scopeIds
  }, [selectedFolderIds, treeIndex])

  const isDocumentIncludedInFolderScope = useCallback(
    (document: KnowledgeDocument) => {
      const folderId = document.folder_id ?? 0
      return folderId > 0 && selectedFolderScopeIds.has(folderId)
    },
    [selectedFolderScopeIds]
  )

  const selectDocument = useCallback(
    (document: KnowledgeDocument, selected: boolean) => {
      if (selected && isDocumentIncludedInFolderScope(document)) {
        return
      }

      setSelectedDocumentIds(previous => {
        const next = new Set(previous)
        if (selected) {
          next.add(document.id)
        } else {
          next.delete(document.id)
          const folderId = document.folder_id ?? 0
          if (folderId > 0) {
            const ancestorIds = treeIndex.folderAncestorIds.get(folderId) ?? new Set()
            setSelectedFolderIds(previousFolders => {
              const nextFolders = new Set(previousFolders)
              ancestorIds.forEach(id => nextFolders.delete(id))
              return nextFolders
            })
          }
        }
        return next
      })
    },
    [isDocumentIncludedInFolderScope, treeIndex]
  )

  const selectFolderScope = useCallback(
    (folderId: number, selected: boolean) => {
      const affectedFolderIds = treeIndex.folderDescendantIds.get(folderId) ?? new Set([folderId])
      setSelectedFolderIds(previous => {
        const next = new Set(previous)
        if (selected) {
          affectedFolderIds.forEach(id => next.delete(id))
          next.add(folderId)
        } else {
          affectedFolderIds.forEach(id => next.delete(id))
        }
        return next
      })

      if (selected) {
        setSelectedDocumentIds(previous => {
          const next = new Set(previous)
          documents.forEach(document => {
            const documentFolderId = document.folder_id ?? 0
            if (documentFolderId > 0 && affectedFolderIds.has(documentFolderId)) {
              next.delete(document.id)
            }
          })
          return next
        })
      }
    },
    [documents, treeIndex]
  )

  const selectVisibleDocuments = useCallback(
    (selected: boolean) => {
      if (selected) {
        setSelectedDocumentIds(new Set(documents.map(document => document.id)))
      } else {
        setSelectedDocumentIds(new Set())
      }
      setSelectedFolderIds(new Set())
    },
    [documents]
  )

  const getPayload = useCallback(
    (): KnowledgeResourceSelectionPayload => ({
      documentIds: Array.from(selectedDocumentIds),
      folderIds: Array.from(selectedFolderIds),
    }),
    [selectedDocumentIds, selectedFolderIds]
  )

  const summary = useMemo<KnowledgeResourceSelectionSummary>(() => {
    const documentCount = selectedDocumentIds.size
    const folderCount = selectedFolderIds.size
    const hasDocumentSelection = documentCount > 0
    const hasFolderScopeSelection = folderCount > 0
    return {
      documentCount,
      folderCount,
      hasDocumentSelection,
      hasFolderScopeSelection,
      canMoveDocuments: hasDocumentSelection && !hasFolderScopeSelection,
      canDeleteDocuments: hasDocumentSelection && !hasFolderScopeSelection,
      canTransfer: hasDocumentSelection || hasFolderScopeSelection,
    }
  }, [selectedDocumentIds, selectedFolderIds])

  return {
    selectedDocumentIds,
    selectedFolderIds,
    selectedFolderScopeIds,
    summary,
    resetSelection,
    setDocumentSelection,
    setFolderSelection,
    selectDocument,
    selectFolderScope,
    selectVisibleDocuments,
    isDocumentIncludedInFolderScope,
    getPayload,
  }
}
