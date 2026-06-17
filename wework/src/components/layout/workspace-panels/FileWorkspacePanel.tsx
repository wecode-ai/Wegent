import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createDeviceApi } from '@/api/devices'
import { createHttpClient } from '@/api/http'
import { getRuntimeConfig } from '@/config/runtime'
import { useTranslation } from '@/hooks/useTranslation'
import type {
  CodeCommentContext,
  WorkspaceFileOpenRequest,
  WorkspaceFileEntry,
  WorkspaceTarget,
  WorkspaceTextFileResponse,
} from '@/types/workspace-files'
import { WorkspaceFilePreview } from './WorkspaceFilePreview'
import { WorkspaceFileTree } from './WorkspaceFileTree'

interface FileWorkspacePanelProps {
  target: WorkspaceTarget | null
  openFileRequest?: WorkspaceFileOpenRequest | null
  onAddCodeComment: (context: CodeCommentContext) => void
}

function createWorkspaceDeviceApi() {
  const { apiBaseUrl } = getRuntimeConfig()
  return createDeviceApi(createHttpClient({ baseUrl: apiBaseUrl }))
}

function resolveWorkspaceFilePath(target: WorkspaceTarget, path: string): string | null {
  const normalizedPath = path.trim().replace(/\\/g, '/')
  if (!normalizedPath) return null
  if (normalizedPath.startsWith('/')) return normalizedPath

  const segments: string[] = []
  for (const segment of normalizedPath.split('/')) {
    if (!segment || segment === '.') continue
    if (segment === '..') return null
    segments.push(segment)
  }
  if (segments.length === 0) return null

  const root = target.path.replace(/\/+$/, '') || '/'
  const child = segments.join('/')
  return root === '/' ? `/${child}` : `${root}/${child}`
}

export function FileWorkspacePanel({
  target,
  openFileRequest,
  onAddCodeComment,
}: FileWorkspacePanelProps) {
  const { t } = useTranslation('common')
  const api = useMemo(() => createWorkspaceDeviceApi(), [])
  const rootPath = target?.path ?? ''
  const [activeDirectoryPath, setActiveDirectoryPath] = useState(target?.path ?? '')
  const [entriesByPath, setEntriesByPath] = useState<Record<string, WorkspaceFileEntry[]>>({})
  const [expandedPaths, setExpandedPaths] = useState<Set<string>>(new Set())
  const [selectedFilePath, setSelectedFilePath] = useState<string | null>(null)
  const [preview, setPreview] = useState<WorkspaceTextFileResponse | null>(null)
  const [loadingPaths, setLoadingPaths] = useState<Set<string>>(new Set())
  const [treeError, setTreeError] = useState<string | null>(null)
  const [treeRetryPath, setTreeRetryPath] = useState<string | null>(null)
  const [previewLoading, setPreviewLoading] = useState(false)
  const [previewError, setPreviewError] = useState<string | null>(null)
  const treeRequestSequence = useRef(0)
  const latestTreeRequestByPath = useRef(new Map<string, number>())
  const fileRequestSequence = useRef(0)

  const loadTree = useCallback(async (path: string) => {
    if (!target) return
    const requestId = treeRequestSequence.current + 1
    treeRequestSequence.current = requestId
    latestTreeRequestByPath.current.set(path, requestId)
    setLoadingPaths((previous) => {
      const next = new Set(previous)
      next.add(path)
      return next
    })
    setTreeError(null)
    setTreeRetryPath(null)
    try {
      const result = await api.listWorkspaceEntries(target.deviceId, path)
      if (latestTreeRequestByPath.current.get(path) !== requestId) return
      const resolvedPath = result.path || path
      setEntriesByPath(previous => ({
        ...previous,
        [resolvedPath]: result.entries,
      }))
      setExpandedPaths((previous) => {
        const next = new Set(previous)
        next.add(resolvedPath)
        return next
      })
      setTreeRetryPath(null)
    } catch (error) {
      if (latestTreeRequestByPath.current.get(path) !== requestId) return
      setTreeError(
        error instanceof Error
          ? error.message
          : t('workbench.workspace_file_load_failed', '加载文件失败'),
      )
      setTreeRetryPath(path)
    } finally {
      if (latestTreeRequestByPath.current.get(path) === requestId) {
        setLoadingPaths((previous) => {
          const next = new Set(previous)
          next.delete(path)
          return next
        })
      }
    }
  }, [api, target, t])

  const openDirectory = useCallback((entry: WorkspaceFileEntry) => {
    if (!entry.isDirectory) return
    setActiveDirectoryPath(entry.path)
    setTreeError(null)
    setTreeRetryPath(null)

    if (!entriesByPath[entry.path] && !loadingPaths.has(entry.path)) {
      void loadTree(entry.path)
    }
  }, [entriesByPath, loadTree, loadingPaths])

  const openFile = useCallback(async (entry: WorkspaceFileEntry) => {
    if (!target || entry.isDirectory) return
    const requestId = fileRequestSequence.current + 1
    fileRequestSequence.current = requestId
    setSelectedFilePath(entry.path)
    setPreviewLoading(true)
    setPreviewError(null)
    try {
      const file = await api.readWorkspaceTextFile(target.deviceId, entry.path)
      if (fileRequestSequence.current !== requestId) return
      setPreview(file)
    } catch (error) {
      if (fileRequestSequence.current !== requestId) return
      setPreview(null)
      setPreviewError(
        error instanceof Error
          ? error.message
          : t('workbench.workspace_file_preview_failed', '读取文件失败'),
      )
    } finally {
      if (fileRequestSequence.current === requestId) {
        setPreviewLoading(false)
      }
    }
  }, [api, target, t])

  const openFilePath = useCallback((path: string) => {
    if (!target) return
    const resolvedPath = resolveWorkspaceFilePath(target, path)
    if (!resolvedPath) return

    void openFile({
      name: resolvedPath.split('/').pop() ?? resolvedPath,
      path: resolvedPath,
      isDirectory: false,
      size: 0,
    })
  }, [openFile, target])

  useEffect(() => {
    if (!target) return
    let cancelled = false
    void Promise.resolve().then(() => {
      if (!cancelled) {
        void loadTree(target.path)
      }
    })
    return () => {
      cancelled = true
    }
  }, [loadTree, target])

  useEffect(() => {
    if (!openFileRequest?.path) return
    let cancelled = false
    void Promise.resolve().then(() => {
      if (!cancelled) {
        openFilePath(openFileRequest.path)
      }
    })
    return () => {
      cancelled = true
    }
  }, [openFilePath, openFileRequest?.id, openFileRequest?.path])

  if (!target) {
    return (
      <section className="flex min-h-0 flex-1 items-center justify-center px-6 text-center text-sm text-text-muted">
        {t('workbench.workspace_file_no_workspace', '暂无可浏览的工作区')}
      </section>
    )
  }

  return (
    <div className="flex min-h-0 flex-1 overflow-hidden">
      <WorkspaceFilePreview
        file={preview}
        loading={previewLoading}
        error={previewError}
        onRetry={() => selectedFilePath && openFilePath(selectedFilePath)}
        onAddCodeComment={onAddCodeComment}
      />
      <WorkspaceFileTree
        rootPath={rootPath}
        activeDirectoryPath={activeDirectoryPath}
        entriesByPath={entriesByPath}
        expandedPaths={expandedPaths}
        selectedPath={selectedFilePath}
        loadingPaths={loadingPaths}
        error={treeError}
        onOpenDirectory={openDirectory}
        onOpenFile={entry => void openFile(entry)}
        onExpandedPathsChange={updaterOrValue => {
          setExpandedPaths((previous) => {
            const previousPaths = Array.from(previous)
            const nextPaths = typeof updaterOrValue === 'function'
              ? updaterOrValue(previousPaths)
              : updaterOrValue
            return new Set(nextPaths)
          })
        }}
        onRefresh={() => void loadTree(treeRetryPath ?? activeDirectoryPath)}
      />
    </div>
  )
}
