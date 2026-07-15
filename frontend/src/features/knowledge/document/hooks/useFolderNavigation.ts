// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { useState, useMemo, useCallback, useEffect } from 'react'
import type { KnowledgeFolder } from '@/types/knowledge'
import { buildKnowledgeResourceTree } from '../utils/resource-tree'

export interface BreadcrumbItem {
  id: number | null
  name: string
}

interface UseFolderNavigationResult {
  navFolderId: number | null
  breadcrumbs: BreadcrumbItem[]
  directChildFolders: KnowledgeFolder[]
  navigateTo: (folderId: number | null) => void
}

export function useFolderNavigation(
  allFolders: KnowledgeFolder[],
  knowledgeBaseId: number
): UseFolderNavigationResult {
  const [navFolderId, setNavFolderId] = useState<number | null>(null)

  // Reset to root when switching knowledge bases
  useEffect(() => {
    setNavFolderId(null)
  }, [knowledgeBaseId])

  const navigateTo = useCallback((folderId: number | null) => {
    setNavFolderId(folderId)
  }, [])

  const treeData = useMemo(() => buildKnowledgeResourceTree(allFolders, []), [allFolders])

  const directChildFolders = useMemo(() => {
    if (navFolderId === null) return allFolders
    return treeData.index.folderById.get(navFolderId)?.children ?? []
  }, [navFolderId, allFolders, treeData])

  // Root item name is intentionally left empty — KnowledgeFolderBreadcrumb
  // handles the translation directly to avoid timing issues with i18n in hooks.
  const breadcrumbs = useMemo<BreadcrumbItem[]>(() => {
    const root: BreadcrumbItem = { id: null, name: '' }
    if (navFolderId === null) return [root]
    const pathIds = treeData.index.folderPathIds.get(navFolderId) ?? []
    return [
      root,
      ...pathIds.map(id => ({
        id,
        name: treeData.index.folderById.get(id)?.name ?? String(id),
      })),
    ]
  }, [navFolderId, treeData])

  return { navFolderId, breadcrumbs, directChildFolders, navigateTo }
}
