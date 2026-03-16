// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'

import { getToken } from '@/apis/user'

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
import { type RemoteWorkspaceDirectoryCache } from './RemoteWorkspaceDirectoryTree'
import {
  buildBreadcrumbSegments,
  getParentPath,
  normalizeWorkspacePathInput,
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

type LoadDirectoryOptions = {
  setAsCurrent?: boolean
  clearSelection?: boolean
  errorMessage?: string
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
  const [directoryCache, setDirectoryCache] = useState<RemoteWorkspaceDirectoryCache>({})
  const [expandedDirectoryPaths, setExpandedDirectoryPaths] = useState<Set<string>>(
    () => new Set([rootPath])
  )
  const [selectedPaths, setSelectedPaths] = useState<string[]>([])
  const [searchKeyword, setSearchKeyword] = useState('')
  const [sortOption, setSortOption] = useState<SortOption>('name_asc')
  const [isPathEditing, setIsPathEditing] = useState(false)
  const [pathInputValue, setPathInputValue] = useState(rootPath)
  const [pathInputError, setPathInputError] = useState<string | null>(null)
  const [isPreviewDialogOpen, setIsPreviewDialogOpen] = useState(false)

  const [textContent, setTextContent] = useState('')
  const [isTextLoading, setIsTextLoading] = useState(false)
  const [textError, setTextError] = useState<string | null>(null)

  // Blob URL for image/pdf preview (to support authenticated file access)
  const [previewBlobUrl, setPreviewBlobUrl] = useState<string>('')
  const [_isPreviewLoading, setIsPreviewLoading] = useState(false)
  const [_previewError, setPreviewError] = useState<string | null>(null)

  const expandPathToDirectory = useCallback(
    (path: string) => {
      const segments = buildBreadcrumbSegments(rootPath, path)
      setExpandedDirectoryPaths(previous => {
        const next = new Set(previous)
        for (const segment of segments) {
          next.add(segment.path)
        }
        return next
      })
    },
    [rootPath]
  )

  const loadDirectory = useCallback(
    async (targetPath: string, options: LoadDirectoryOptions = {}) => {
      setDirectoryCache(previous => ({
        ...previous,
        [targetPath]: {
          entries: previous[targetPath]?.entries ?? [],
          isLoading: true,
          error: null,
          loaded: previous[targetPath]?.loaded ?? false,
        },
      }))

      try {
        const response = await remoteWorkspaceApis.getTree(taskId, targetPath)
        setDirectoryCache(previous => ({
          ...previous,
          [response.path]: {
            entries: response.entries,
            isLoading: false,
            error: null,
            loaded: true,
          },
        }))

        if (options.setAsCurrent) {
          setCurrentPath(response.path)
          expandPathToDirectory(response.path)
        }
        if (options.clearSelection) {
          setSelectedPaths([])
          setIsPreviewDialogOpen(false)
        }
      } catch {
        const fallbackError = t(
          'remote_workspace.tree.load_failed',
          'Failed to load workspace tree'
        )
        setDirectoryCache(previous => ({
          ...previous,
          [targetPath]: {
            entries: previous[targetPath]?.entries ?? [],
            isLoading: false,
            error: options.errorMessage ?? fallbackError,
            loaded: previous[targetPath]?.loaded ?? false,
          },
        }))
      }
    },
    [expandPathToDirectory, t, taskId]
  )

  // Fetch file content with authentication (for images/pdfs that can't use direct URL)
  const fetchFileBlob = useCallback(
    async (path: string, disposition: 'inline' | 'attachment') => {
      setIsPreviewLoading(true)
      setPreviewError(null)

      try {
        const token = getToken()
        const url = remoteWorkspaceApis.getFileUrl(taskId, path, disposition)
        const response = await fetch(url, {
          headers: token ? { Authorization: `Bearer ${token}` } : {},
        })

        if (!response.ok) {
          throw new Error('fetch failed')
        }

        const blob = await response.blob()
        const blobUrl = URL.createObjectURL(blob)
        setPreviewBlobUrl(blobUrl)
      } catch {
        setPreviewError(t('remote_workspace.preview.load_failed', 'Failed to load preview'))
      } finally {
        setIsPreviewLoading(false)
      }
    },
    [taskId, t]
  )

  // Handle file download with authentication
  const handleDownloadFile = useCallback(
    async (entry: RemoteWorkspaceTreeEntry) => {
      try {
        const token = getToken()
        const url = remoteWorkspaceApis.getFileUrl(taskId, entry.path, 'attachment')
        const response = await fetch(url, {
          headers: token ? { Authorization: `Bearer ${token}` } : {},
        })

        if (!response.ok) {
          throw new Error('fetch failed')
        }

        const blob = await response.blob()
        const blobUrl = URL.createObjectURL(blob)

        // Create temporary link and trigger download
        const link = document.createElement('a')
        link.href = blobUrl
        link.download = entry.name
        document.body.appendChild(link)
        link.click()
        document.body.removeChild(link)

        // Clean up blob URL
        URL.revokeObjectURL(blobUrl)
      } catch {
        // Error handling - could add toast notification here
      }
    },
    [taskId]
  )

  useEffect(() => {
    if (!open) {
      return
    }

    setCurrentPath(rootPath)
    setDirectoryCache({})
    setExpandedDirectoryPaths(new Set([rootPath]))
    setSearchKeyword('')
    setSortOption('name_asc')
    setIsPathEditing(false)
    setPathInputValue(rootPath)
    setPathInputError(null)
    setSelectedPaths([])
    setIsPreviewDialogOpen(false)
    setTextContent('')
    setTextError(null)
    void loadDirectory(rootPath, {
      setAsCurrent: true,
      clearSelection: true,
      errorMessage: t('remote_workspace.tree.load_failed', 'Failed to load workspace tree'),
    })
  }, [loadDirectory, open, rootPath, t])

  const currentDirectoryState = directoryCache[currentPath]
  const entries = useMemo(() => currentDirectoryState?.entries ?? [], [currentDirectoryState])
  const isTreeLoading = Boolean(currentDirectoryState?.isLoading)
  const treeError = currentDirectoryState?.error ?? null

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
    const shouldLoadTextPreview = isMobile || isPreviewDialogOpen
    if (!open || !shouldLoadTextPreview || previewKind !== 'text' || !inlineUrl) {
      setTextContent('')
      setTextError(null)
      setIsTextLoading(false)
      return
    }

    let isCancelled = false
    setIsTextLoading(true)
    setTextError(null)

    const token = getToken()
    fetch(inlineUrl, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    })
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
  }, [inlineUrl, isMobile, isPreviewDialogOpen, open, previewKind, t])

  useEffect(() => {
    if (!previewEntry && isPreviewDialogOpen) {
      setIsPreviewDialogOpen(false)
    }
  }, [isPreviewDialogOpen, previewEntry])

  // Effect to load blob URL for image/pdf previews
  useEffect(() => {
    const shouldLoadPreview = isMobile || isPreviewDialogOpen
    if (!open || !shouldLoadPreview || !previewEntry) {
      // Clean up previous blob URL
      if (previewBlobUrl) {
        URL.revokeObjectURL(previewBlobUrl)
        setPreviewBlobUrl('')
      }
      return
    }

    // Only load blob for image and pdf previews
    if (previewKind !== 'image' && previewKind !== 'pdf') {
      return
    }

    void fetchFileBlob(previewEntry.path, 'inline')

    return () => {
      if (previewBlobUrl) {
        URL.revokeObjectURL(previewBlobUrl)
      }
    }
  }, [
    fetchFileBlob,
    inlineUrl,
    isMobile,
    isPreviewDialogOpen,
    open,
    previewEntry,
    previewKind,
    previewBlobUrl,
  ])

  const canGoParent = Boolean(getParentPath(rootPath, currentPath))
  const breadcrumbs = useMemo(
    () => buildBreadcrumbSegments(rootPath, currentPath),
    [currentPath, rootPath]
  )

  useEffect(() => {
    setPathInputValue(currentPath)
    setPathInputError(null)
  }, [currentPath])

  const navigateToDirectory = useCallback(
    (targetPath: string) => {
      expandPathToDirectory(targetPath)
      const cachedState = directoryCache[targetPath]
      if (cachedState?.loaded && !cachedState.isLoading) {
        setCurrentPath(targetPath)
        setSelectedPaths([])
        setIsPreviewDialogOpen(false)
        setIsPathEditing(false)
        setPathInputError(null)
        return
      }

      void loadDirectory(targetPath, {
        setAsCurrent: true,
        clearSelection: true,
        errorMessage: t('remote_workspace.tree.load_failed', 'Failed to load workspace tree'),
      })
    },
    [directoryCache, expandPathToDirectory, loadDirectory, t]
  )

  const handleOpenEntryMobile = useCallback(
    (entry: RemoteWorkspaceTreeEntry) => {
      if (entry.is_directory) {
        navigateToDirectory(entry.path)
        return
      }

      setSelectedPaths([entry.path])
    },
    [navigateToDirectory]
  )

  const handleSelectEntry = useCallback((entry: RemoteWorkspaceTreeEntry) => {
    setSelectedPaths([entry.path])
  }, [])

  const handleOpenEntryDesktop = useCallback(
    (entry: RemoteWorkspaceTreeEntry) => {
      if (entry.is_directory) {
        navigateToDirectory(entry.path)
        return
      }

      setSelectedPaths([entry.path])
      setIsPreviewDialogOpen(true)
    },
    [navigateToDirectory]
  )

  const handlePathSubmit = useCallback(() => {
    const normalizedPath = normalizeWorkspacePathInput(rootPath, currentPath, pathInputValue)
    if (!normalizedPath) {
      setPathInputError(t('remote_workspace.path.invalid', 'Path is outside workspace'))
      return
    }

    setPathInputError(null)
    setIsPathEditing(false)

    if (normalizedPath === currentPath) {
      return
    }

    navigateToDirectory(normalizedPath)
  }, [currentPath, navigateToDirectory, pathInputValue, rootPath, t])

  const handleStartPathEdit = useCallback(() => {
    setIsPathEditing(true)
    setPathInputValue(currentPath)
    setPathInputError(null)
  }, [currentPath])

  const handleCancelPathEdit = useCallback(() => {
    setIsPathEditing(false)
    setPathInputValue(currentPath)
    setPathInputError(null)
  }, [currentPath])

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

    navigateToDirectory(parentPath)
  }, [currentPath, navigateToDirectory, rootPath])

  const handleToggleDirectoryExpand = useCallback(
    (path: string) => {
      if (path === rootPath) {
        return
      }

      const isExpanded = expandedDirectoryPaths.has(path)
      setExpandedDirectoryPaths(previous => {
        const next = new Set(previous)
        if (next.has(path)) {
          next.delete(path)
        } else {
          next.add(path)
        }
        return next
      })

      if (isExpanded) {
        return
      }

      const pathState = directoryCache[path]
      if (!pathState || (!pathState.loaded && !pathState.isLoading)) {
        void loadDirectory(path, {
          errorMessage: t(
            'remote_workspace.tree.load_children_failed',
            'Failed to load child directories'
          ),
        })
      }
    },
    [directoryCache, expandedDirectoryPaths, loadDirectory, rootPath, t]
  )

  const handleRetryDirectoryLoad = useCallback(
    (path: string) => {
      void loadDirectory(path, {
        errorMessage: t(
          'remote_workspace.tree.load_children_failed',
          'Failed to load child directories'
        ),
      })
    },
    [loadDirectory, t]
  )

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
            inlineUrl={
              previewKind === 'image' || previewKind === 'pdf' ? previewBlobUrl : inlineUrl
            }
            textContent={textContent}
            isTextLoading={isTextLoading}
            textError={textError}
            searchKeyword={searchKeyword}
            sortOption={sortOption}
            canGoParent={canGoParent}
            canDownloadPreview={canDownloadPreview}
            onDownload={handleDownloadFile}
            onGoRoot={() => navigateToDirectory(rootPath)}
            onGoParent={handleGoParent}
            onRefresh={() =>
              void loadDirectory(currentPath, {
                setAsCurrent: true,
                clearSelection: true,
                errorMessage: t(
                  'remote_workspace.tree.load_failed',
                  'Failed to load workspace tree'
                ),
              })
            }
            onSearchChange={setSearchKeyword}
            onSortChange={setSortOption}
            onToggleEntrySelection={handleToggleEntrySelection}
            onOpenEntry={handleOpenEntryMobile}
          />
        ) : (
          <RemoteWorkspaceDialogDesktop
            t={t}
            rootPath={rootPath}
            currentPath={currentPath}
            breadcrumbs={breadcrumbs}
            directoryCache={directoryCache}
            expandedDirectoryPaths={expandedDirectoryPaths}
            isTreeLoading={isTreeLoading}
            treeError={treeError}
            visibleEntries={visibleEntries}
            selectedPaths={selectedPathSet}
            selectedEntries={selectedEntries}
            previewEntry={previewEntry}
            previewKind={previewKind}
            inlineUrl={
              previewKind === 'image' || previewKind === 'pdf' ? previewBlobUrl : inlineUrl
            }
            textContent={textContent}
            isTextLoading={isTextLoading}
            textError={textError}
            searchKeyword={searchKeyword}
            sortOption={sortOption}
            pathInputValue={pathInputValue}
            pathInputError={pathInputError}
            isPathEditing={isPathEditing}
            canGoParent={canGoParent}
            canDownloadPreview={canDownloadPreview}
            isPreviewDialogOpen={isPreviewDialogOpen}
            onDownload={handleDownloadFile}
            onGoRoot={() => navigateToDirectory(rootPath)}
            onGoParent={handleGoParent}
            onRefresh={() =>
              void loadDirectory(currentPath, {
                setAsCurrent: true,
                clearSelection: true,
                errorMessage: t(
                  'remote_workspace.tree.load_failed',
                  'Failed to load workspace tree'
                ),
              })
            }
            onToggleDirectoryExpand={handleToggleDirectoryExpand}
            onSelectDirectory={navigateToDirectory}
            onRetryDirectoryLoad={handleRetryDirectoryLoad}
            onSearchChange={setSearchKeyword}
            onSortChange={setSortOption}
            onPathEditStart={handleStartPathEdit}
            onPathInputChange={setPathInputValue}
            onPathSubmit={handlePathSubmit}
            onPathEditCancel={handleCancelPathEdit}
            onToggleAllEntries={handleToggleAllEntries}
            onToggleEntrySelection={handleToggleEntrySelection}
            onSelectEntry={handleSelectEntry}
            onOpenEntry={handleOpenEntryDesktop}
            onPreviewDialogOpenChange={setIsPreviewDialogOpen}
          />
        )}
      </DialogContent>
    </Dialog>
  )
}
