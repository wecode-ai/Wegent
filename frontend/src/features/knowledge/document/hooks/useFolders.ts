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
} from '@/apis/knowledge'
import type {
  KnowledgeFolder,
  KnowledgeFolderCreate,
  KnowledgeFolderUpdate,
} from '@/types/knowledge'
import { toast } from '@/hooks/use-toast'

interface UseFoldersOptions {
  knowledgeBaseId: number | null
}

export function useFolders(options: UseFoldersOptions) {
  const { knowledgeBaseId } = options

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
        toast({ description: `Folder "${folder.name}" created` })
        return folder
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Failed to create folder'
        toast({ description: msg, variant: 'destructive' })
        return null
      }
    },
    [knowledgeBaseId, fetchFolders]
  )

  const update = useCallback(
    async (folderId: number, data: KnowledgeFolderUpdate): Promise<KnowledgeFolder | null> => {
      if (!knowledgeBaseId) return null
      try {
        const folder = await updateFolder(knowledgeBaseId, folderId, data)
        await fetchFolders()
        toast({ description: `Folder "${folder.name}" updated` })
        return folder
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Failed to update folder'
        toast({ description: msg, variant: 'destructive' })
        return null
      }
    },
    [knowledgeBaseId, fetchFolders]
  )

  const remove = useCallback(
    async (folderId: number): Promise<boolean> => {
      if (!knowledgeBaseId) return false
      try {
        const result = await deleteFolder(knowledgeBaseId, folderId)
        await fetchFolders()
        toast({
          description: `Folder deleted, ${result.moved_document_count} document(s) moved to root`,
        })
        return true
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Failed to delete folder'
        toast({ description: msg, variant: 'destructive' })
        return false
      }
    },
    [knowledgeBaseId, fetchFolders]
  )

  const move = useCallback(
    async (documentId: number, folderId: number): Promise<boolean> => {
      try {
        await moveDocument(documentId, folderId)
        return true
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Failed to move document'
        toast({ description: msg, variant: 'destructive' })
        return false
      }
    },
    []
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
  }
}