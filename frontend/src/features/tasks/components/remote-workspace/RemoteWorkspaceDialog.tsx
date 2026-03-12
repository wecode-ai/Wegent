// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'

import { type RemoteWorkspaceTreeEntry, remoteWorkspaceApis } from '@/apis/remoteWorkspace'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { useIsMobile } from '@/features/layout/hooks/useMediaQuery'
import { useTranslation } from '@/hooks/useTranslation'

import { RemoteWorkspaceDialogDesktop } from './RemoteWorkspaceDialogDesktop'
import { RemoteWorkspaceDialogMobile } from './RemoteWorkspaceDialogMobile'
import {
  buildBreadcrumbSegments,
  getParentPath,
  resolvePreviewKind,
  sortTreeEntries,
  type SortOption,
} from './remote-workspace-utils'

type RemoteWorkspaceDialogProps = {
  open: boolean
  taskId: number
  onOpenChange: (open: boolean) => void
  rootPath?: string
}

export function RemoteWorkspaceDialog({
  open,
  taskId,
  onOpenChange,
  rootPath = '/workspace',
}: RemoteWorkspaceDialogProps) {
  const { t } = useTranslation('tasks')
  const isMobile = useIsMobile()
  const [currentPath, setCurrentPath] = useState(rootPath)
  const [entries, setEntries] = useState<RemoteWorkspaceTreeEntry[]>([])
  const [isTreeLoading, setIsTreeLoading] = useState(false)
  const [treeError, setTreeError] = useState<string | null>(null)
  const [selectedPaths, setSelectedPaths] = useState<string[]>([])
  const [searchKeyword, setSearchKeyword] = useState('')
  const [sortOption, setSortOption] = useState<SortOption>('name_asc')

  const [textContent, setTextContent] = useState('')
  const [isTextLoading, setIsTextLoading] = useState(false)
  const [textError, setTextError] = useState<string | null>(null)

  const loadTree = useCallback(
    async (targetPath: string) => {
      setIsTreeLoading(true)
      setTreeError(null)

      try {
        const response = await remoteWorkspaceApis.getTree(taskId, targetPath)
        setCurrentPath(response.path)
        setEntries(response.entries)
        setSelectedPaths([])
      } catch {
        setTreeError(t('remote_workspace.tree.load_failed', 'Failed to load workspace tree'))
      } finally {
        setIsTreeLoading(false)
      }
    },
    [taskId, t]
  )

  useEffect(() => {
    if (!open) {
      return
    }

    setCurrentPath(rootPath)
    setEntries([])
    setTreeError(null)
    setSearchKeyword('')
    setSortOption('name_asc')
    setSelectedPaths([])
    setTextContent('')
    setTextError(null)
    void loadTree(rootPath)
  }, [open, rootPath, loadTree])

  const entryMap = useMemo(() => {
    const map = new Map<string, RemoteWorkspaceTreeEntry>()
    for (const entry of entries) {
      map.set(entry.path, entry)
    }
    return map
  }, [entries])

  const visibleEntries = useMemo(() => {
    const lowerKeyword = searchKeyword.trim().toLowerCase()
    const filteredEntries = lowerKeyword
      ? entries.filter(entry => entry.name.toLowerCase().includes(lowerKeyword))
      : entries

    return sortTreeEntries(filteredEntries, sortOption)
  }, [entries, searchKeyword, sortOption])

  const selectedPathSet = useMemo(() => new Set(selectedPaths), [selectedPaths])

  const selectedEntries = useMemo(
    () =>
      selectedPaths
        .map(path => entryMap.get(path))
        .filter((entry): entry is RemoteWorkspaceTreeEntry => Boolean(entry)),
    [entryMap, selectedPaths]
  )

  const previewEntry = useMemo(() => {
    if (selectedEntries.length !== 1) {
      return null
    }
    const entry = selectedEntries[0]
    return entry.is_directory ? null : entry
  }, [selectedEntries])

  const previewKind = useMemo(() => {
    if (!previewEntry) {
      return 'none'
    }

    return resolvePreviewKind(previewEntry.name)
  }, [previewEntry])

  const inlineUrl = useMemo(() => {
    if (!previewEntry) {
      return ''
    }

    return remoteWorkspaceApis.getFileUrl(taskId, previewEntry.path, 'inline')
  }, [previewEntry, taskId])

  const downloadUrl = useMemo(() => {
    if (!previewEntry) {
      return ''
    }

    return remoteWorkspaceApis.getFileUrl(taskId, previewEntry.path, 'attachment')
  }, [previewEntry, taskId])

  useEffect(() => {
    if (!open || previewKind !== 'text' || !inlineUrl) {
      setTextContent('')
      setTextError(null)
      setIsTextLoading(false)
      return
    }

    let isCancelled = false
    setIsTextLoading(true)
    setTextError(null)

    fetch(inlineUrl)
      .then(response => {
        if (!response.ok) {
          throw new Error('fetch failed')
        }
        return response.text()
      })
      .then(content => {
        if (!isCancelled) {
          setTextContent(content)
        }
      })
      .catch(() => {
        if (!isCancelled) {
          setTextError(t('remote_workspace.preview.load_failed', 'Failed to load preview'))
        }
      })
      .finally(() => {
        if (!isCancelled) {
          setIsTextLoading(false)
        }
      })

    return () => {
      isCancelled = true
    }
  }, [inlineUrl, open, previewKind, t])

  const canGoParent = Boolean(getParentPath(rootPath, currentPath))
  const breadcrumbs = useMemo(
    () => buildBreadcrumbSegments(rootPath, currentPath),
    [currentPath, rootPath]
  )

  const handleOpenEntry = useCallback(
    (entry: RemoteWorkspaceTreeEntry) => {
      if (entry.is_directory) {
        void loadTree(entry.path)
        return
      }

      setSelectedPaths([entry.path])
    },
    [loadTree]
  )

  const handleToggleEntrySelection = useCallback(
    (entry: RemoteWorkspaceTreeEntry, checked: boolean) => {
      setSelectedPaths(previous => {
        if (checked) {
          if (previous.includes(entry.path)) {
            return previous
          }
          return [...previous, entry.path]
        }

        return previous.filter(path => path !== entry.path)
      })
    },
    []
  )

  const handleToggleAllEntries = useCallback(
    (checked: boolean) => {
      if (!checked) {
        setSelectedPaths([])
        return
      }

      setSelectedPaths(visibleEntries.map(entry => entry.path))
    },
    [visibleEntries]
  )

  const handleGoParent = useCallback(() => {
    const parentPath = getParentPath(rootPath, currentPath)
    if (!parentPath) {
      return
    }

    void loadTree(parentPath)
  }, [currentPath, loadTree, rootPath])

  const canDownloadPreview = Boolean(previewEntry && downloadUrl)

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="!flex !h-[85vh] !w-[96vw] !max-w-[1680px] !flex-col p-0 gap-0 overflow-hidden">
        <DialogHeader className="shrink-0 px-6 py-4 border-b border-border">
          <DialogTitle>{t('remote_workspace.title')}</DialogTitle>
          <DialogDescription className="sr-only">{t('remote_workspace.title')}</DialogDescription>
        </DialogHeader>

        {isMobile ? (
          <RemoteWorkspaceDialogMobile
            t={t}
            currentPath={currentPath}
            isTreeLoading={isTreeLoading}
            treeError={treeError}
            visibleEntries={visibleEntries}
            selectedPaths={selectedPathSet}
            selectedEntries={selectedEntries}
            previewKind={previewKind}
            inlineUrl={inlineUrl}
            downloadUrl={downloadUrl}
            textContent={textContent}
            isTextLoading={isTextLoading}
            textError={textError}
            searchKeyword={searchKeyword}
            sortOption={sortOption}
            canGoParent={canGoParent}
            canDownloadPreview={canDownloadPreview}
            onGoRoot={() => void loadTree(rootPath)}
            onGoParent={handleGoParent}
            onRefresh={() => void loadTree(currentPath)}
            onSearchChange={setSearchKeyword}
            onSortChange={setSortOption}
            onToggleEntrySelection={handleToggleEntrySelection}
            onOpenEntry={handleOpenEntry}
          />
        ) : (
          <RemoteWorkspaceDialogDesktop
            t={t}
            currentPath={currentPath}
            breadcrumbs={breadcrumbs}
            isTreeLoading={isTreeLoading}
            treeError={treeError}
            visibleEntries={visibleEntries}
            selectedPaths={selectedPathSet}
            selectedEntries={selectedEntries}
            previewEntry={previewEntry}
            previewKind={previewKind}
            inlineUrl={inlineUrl}
            downloadUrl={downloadUrl}
            textContent={textContent}
            isTextLoading={isTextLoading}
            textError={textError}
            searchKeyword={searchKeyword}
            sortOption={sortOption}
            canGoParent={canGoParent}
            canDownloadPreview={canDownloadPreview}
            onGoRoot={() => void loadTree(rootPath)}
            onGoParent={handleGoParent}
            onRefresh={() => void loadTree(currentPath)}
            onBreadcrumbClick={path => void loadTree(path)}
            onSearchChange={setSearchKeyword}
            onSortChange={setSortOption}
            onToggleAllEntries={handleToggleAllEntries}
            onToggleEntrySelection={handleToggleEntrySelection}
            onOpenEntry={handleOpenEntry}
          />
        )}
      </DialogContent>
    </Dialog>
  )
}
