// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * Custom hook for managing knowledge base folder hierarchy
 */

import { useState, useCallback } from 'react'
import {
  getFolderTree,
  createFolder,
  updateFolder,
  deleteFolder,
  moveDocument,
  batchMoveDocuments,
} from '@/apis/knowledge'
import type {
  KnowledgeFolder,
  KnowledgeFolderCreate,
  KnowledgeFolderUpdate,
} from '@/types/knowledge'
import { toast } from '@/hooks/use-toast'
import { useTranslation } from '@/hooks/useTranslation'
import { mapKnowledgeDocumentErrorMessage } from '../utils/error-messages'

interface UseFoldersOptions {
  knowledgeBaseId: number | null
}

export function useFolders(options: UseFoldersOptions) {
  const { knowledgeBaseId } = options
  const { t } = useTranslation('knowledge')

  const [folders, setFolders] = useState<KnowledgeFolder[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const fetchFolders = useCallback(async () => {
    if (!knowledgeBaseId) {
      setFolders([])
      return
    }

    setLoading(true)
    setError(null)
    try {
      const data = await getFolderTree(knowledgeBaseId)
      setFolders(data)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to fetch folders')
    } finally {
      setLoading(false)
    }
  }, [knowledgeBaseId])

  const create = useCallback(
    async (data: KnowledgeFolderCreate): Promise<KnowledgeFolder | null> => {
      if (!knowledgeBaseId) return null
      try {
        const folder = await createFolder(knowledgeBaseId, data)
        await fetchFolders()
        toast({ description: t('document.folder.createdToast', { name: folder.name }) })
        return folder
      } catch (err) {
        const msg = mapKnowledgeDocumentErrorMessage(err, t, 'document.folder.createFailed')
        toast({ description: msg, variant: 'destructive' })
        return null
      }
    },
    [knowledgeBaseId, fetchFolders, t]
  )

  const update = useCallback(
    async (folderId: number, data: KnowledgeFolderUpdate): Promise<KnowledgeFolder | null> => {
      if (!knowledgeBaseId) return null
      try {
        const folder = await updateFolder(knowledgeBaseId, folderId, data)
        await fetchFolders()
        toast({ description: t('document.folder.updatedToast', { name: folder.name }) })
        return folder
      } catch (err) {
        const msg = mapKnowledgeDocumentErrorMessage(err, t, 'document.folder.updateFailed')
        toast({ description: msg, variant: 'destructive' })
        return null
      }
    },
    [knowledgeBaseId, fetchFolders, t]
  )

  const remove = useCallback(
    async (folderId: number): Promise<boolean> => {
      if (!knowledgeBaseId) return false
      try {
        const result = await deleteFolder(knowledgeBaseId, folderId)
        await fetchFolders()
        toast({
          description: t('document.folder.deletedToast', { count: result.moved_document_count }),
        })
        return true
      } catch (err) {
        const msg = mapKnowledgeDocumentErrorMessage(err, t, 'document.folder.deleteFailed')
        toast({ description: msg, variant: 'destructive' })
        return false
      }
    },
    [knowledgeBaseId, fetchFolders, t]
  )

  const move = useCallback(
    async (documentId: number, folderId: number): Promise<boolean> => {
      try {
        await moveDocument(documentId, folderId)
        return true
      } catch (err) {
        const msg = mapKnowledgeDocumentErrorMessage(err, t, 'document.folder.moveDocumentFailed')
        toast({ description: msg, variant: 'destructive' })
        return false
      }
    },
    [t]
  )

  const batchMove = useCallback(
    async (documentIds: number[], folderId: number) => {
      try {
        const result = await batchMoveDocuments(documentIds, folderId)
        if (result.success_count > 0) {
          toast({
            description: t('document.folder.batchMoveSuccess', { count: result.success_count }),
          })
        }
        if (result.failed_count > 0) {
          toast({
            description: t('document.folder.batchMovePartial', {
              success: result.success_count,
              failed: result.failed_count,
            }),
            variant: 'destructive',
          })
        }
        return result
      } catch (err) {
        const msg = mapKnowledgeDocumentErrorMessage(err, t, 'document.folder.batchMoveFailed')
        toast({ description: msg, variant: 'destructive' })
        return {
          success_count: 0,
          failed_count: documentIds.length,
          failed_ids: documentIds,
          message: msg,
        }
      }
    },
    [t]
  )

  return {
    folders,
    loading,
    error,
    fetchFolders,
    createFolder: create,
    updateFolder: update,
    deleteFolder: remove,
    moveDocument: move,
    batchMove,
  }
}
