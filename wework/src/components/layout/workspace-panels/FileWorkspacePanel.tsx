import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from '@/hooks/useTranslation'
import type {
  CodeCommentContext,
  WorkspaceFileApi,
  WorkspaceFileOpenRequest,
  WorkspaceFileOpenOptions,
  WorkspaceFileEntry,
  WorkspaceTarget,
  WorkspaceTextFileResponse,
} from '@/types/workspace-files'
import { WorkspaceFilePreview } from './WorkspaceFilePreview'
import { WorkspaceFileTree } from './WorkspaceFileTree'

interface FileWorkspacePanelProps {
  target: WorkspaceTarget | null
  workspaceFileApi: WorkspaceFileApi
  openFileRequest?: WorkspaceFileOpenRequest | null
  onAddCodeComment: (context: CodeCommentContext) => void
}

interface PreviewLineTarget {
  filePath: string
  lineStart: number
  lineEnd?: number
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

function createPreviewLineTarget(
  filePath: string,
  options?: WorkspaceFileOpenOptions
): PreviewLineTarget | null {
  if (typeof options?.lineStart !== 'number') return null
  return {
    filePath,
    lineStart: options.lineStart,
    lineEnd: options.lineEnd,
  }
}

export function FileWorkspacePanel({
  target,
  workspaceFileApi,
  openFileRequest,
  onAddCodeComment,
}: FileWorkspacePanelProps) {
  const { t } = useTranslation('common')
  const rootPath = target?.path ?? ''
  const [activeDirectoryPath, setActiveDirectoryPath] = useState(target?.path ?? '')
  const [entriesByPath, setEntriesByPath] = useState<Record<string, WorkspaceFileEntry[]>>({})
  const [expandedPaths, setExpandedPaths] = useState<Set<string>>(new Set())
  const [selectedFilePath, setSelectedFilePath] = useState<string | null>(null)
  const [preview, setPreview] = useState<WorkspaceTextFileResponse | null>(null)
  const [previewLineTarget, setPreviewLineTarget] = useState<PreviewLineTarget | null>(null)
  const [loadingPaths, setLoadingPaths] = useState<Set<string>>(new Set())
  const [treeError, setTreeError] = useState<string | null>(null)
  const [treeRetryPath, setTreeRetryPath] = useState<string | null>(null)
  const [previewLoading, setPreviewLoading] = useState(false)
  const [previewError, setPreviewError] = useState<string | null>(null)
  const treeRequestSequence = useRef(0)
  const latestTreeRequestByPath = useRef(new Map<string, number>())
  const fileRequestSequence = useRef(0)

  const loadTree = useCallback(
    async (path: string) => {
      if (!target) return
      const requestId = treeRequestSequence.current + 1
      treeRequestSequence.current = requestId
      latestTreeRequestByPath.current.set(path, requestId)
      setLoadingPaths(previous => {
        const next = new Set(previous)
        next.add(path)
        return next
      })
      setTreeError(null)
      setTreeRetryPath(null)
      try {
        const result = await workspaceFileApi.listWorkspaceEntries(target.deviceId, path)
        if (latestTreeRequestByPath.current.get(path) !== requestId) return
        const resolvedPath = result.path || path
        setEntriesByPath(previous => ({
          ...previous,
          [resolvedPath]: result.entries,
        }))
        setExpandedPaths(previous => {
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
            : t('workbench.workspace_file_load_failed', '加载文件失败')
        )
        setTreeRetryPath(path)
      } finally {
        if (latestTreeRequestByPath.current.get(path) === requestId) {
          setLoadingPaths(previous => {
            const next = new Set(previous)
            next.delete(path)
            return next
          })
        }
      }
    },
    [target, t, workspaceFileApi]
  )

  const openDirectory = useCallback(
    (entry: WorkspaceFileEntry) => {
      if (!entry.isDirectory) return
      setActiveDirectoryPath(entry.path)
      setTreeError(null)
      setTreeRetryPath(null)

      if (!entriesByPath[entry.path] && !loadingPaths.has(entry.path)) {
        void loadTree(entry.path)
      }
    },
    [entriesByPath, loadTree, loadingPaths]
  )

  const openFile = useCallback(
    async (entry: WorkspaceFileEntry, options?: WorkspaceFileOpenOptions) => {
      if (!target || entry.isDirectory) return
      const requestId = fileRequestSequence.current + 1
      const nextLineTarget = createPreviewLineTarget(entry.path, options)
      fileRequestSequence.current = requestId
      setSelectedFilePath(entry.path)
      setPreviewLineTarget(nextLineTarget)
      setPreviewLoading(true)
      setPreviewError(null)
      try {
        const file = await workspaceFileApi.readWorkspaceTextFile(target.deviceId, entry.path)
        if (fileRequestSequence.current !== requestId) return
        setPreview(file)
      } catch (error) {
        if (fileRequestSequence.current !== requestId) return
        setPreview(null)
        setPreviewLineTarget(null)
        setPreviewError(
          error instanceof Error
            ? error.message
            : t('workbench.workspace_file_preview_failed', '读取文件失败')
        )
      } finally {
        if (fileRequestSequence.current === requestId) {
          setPreviewLoading(false)
        }
      }
    },
    [target, t, workspaceFileApi]
  )

  const openFilePath = useCallback(
    (path: string, options?: WorkspaceFileOpenOptions) => {
      if (!target) return
      const resolvedPath = resolveWorkspaceFilePath(target, path)
      if (!resolvedPath) return

      void openFile(
        {
          name: resolvedPath.split('/').pop() ?? resolvedPath,
          path: resolvedPath,
          isDirectory: false,
          size: 0,
        },
        options
      )
    },
    [openFile, target]
  )

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
        openFilePath(openFileRequest.path, {
          lineStart: openFileRequest.lineStart,
          lineEnd: openFileRequest.lineEnd,
        })
      }
    })
    return () => {
      cancelled = true
    }
  }, [
    openFilePath,
    openFileRequest?.id,
    openFileRequest?.lineEnd,
    openFileRequest?.lineStart,
    openFileRequest?.path,
  ])

  if (!target) {
    return (
      <section className="flex min-h-0 flex-1 items-center justify-center px-6 text-center text-sm text-text-muted">
        {t('workbench.workspace_file_no_workspace', '暂无可浏览的工作区')}
      </section>
    )
  }

  const activePreviewLineTarget =
    previewLineTarget && previewLineTarget.filePath === preview?.path ? previewLineTarget : null

  return (
    <div className="flex min-h-0 flex-1 overflow-hidden">
      <WorkspaceFilePreview
        file={preview}
        loading={previewLoading}
        error={previewError}
        onRetry={() => selectedFilePath && openFilePath(selectedFilePath)}
        targetLineStart={activePreviewLineTarget?.lineStart}
        targetLineEnd={activePreviewLineTarget?.lineEnd}
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
        onRefresh={() => void loadTree(treeRetryPath ?? activeDirectoryPath)}
      />
    </div>
  )
}
