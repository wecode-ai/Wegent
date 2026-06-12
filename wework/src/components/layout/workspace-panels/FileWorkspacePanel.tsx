import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createDeviceApi } from '@/api/devices'
import { createHttpClient } from '@/api/http'
import { getRuntimeConfig } from '@/config/runtime'
import { useTranslation } from '@/hooks/useTranslation'
import type {
  CodeCommentContext,
  WorkspaceFileEntry,
  WorkspaceTarget,
  WorkspaceTextFileResponse,
} from '@/types/workspace-files'
import { WorkspaceFilePreview } from './WorkspaceFilePreview'
import { WorkspaceFileTree } from './WorkspaceFileTree'

interface FileWorkspacePanelProps {
  target: WorkspaceTarget | null
  onAddCodeComment: (context: CodeCommentContext) => void
}

function createWorkspaceDeviceApi() {
  const { apiBaseUrl } = getRuntimeConfig()
  return createDeviceApi(createHttpClient({ baseUrl: apiBaseUrl }))
}

export function FileWorkspacePanel({
  target,
  onAddCodeComment,
}: FileWorkspacePanelProps) {
  const { t } = useTranslation('common')
  const api = useMemo(() => createWorkspaceDeviceApi(), [])
  const [currentPath, setCurrentPath] = useState(target?.path ?? '')
  const [entries, setEntries] = useState<WorkspaceFileEntry[]>([])
  const [selectedFilePath, setSelectedFilePath] = useState<string | null>(null)
  const [preview, setPreview] = useState<WorkspaceTextFileResponse | null>(null)
  const [treeLoading, setTreeLoading] = useState(Boolean(target))
  const [treeError, setTreeError] = useState<string | null>(null)
  const [treeRetryPath, setTreeRetryPath] = useState<string | null>(null)
  const [previewLoading, setPreviewLoading] = useState(false)
  const [previewError, setPreviewError] = useState<string | null>(null)
  const treeRequestSequence = useRef(0)
  const fileRequestSequence = useRef(0)

  const loadTree = useCallback(async (path: string) => {
    if (!target) return
    const requestId = treeRequestSequence.current + 1
    treeRequestSequence.current = requestId
    setTreeLoading(true)
    setTreeError(null)
    setTreeRetryPath(null)
    try {
      const result = await api.listWorkspaceEntries(target.deviceId, path)
      if (treeRequestSequence.current !== requestId) return
      setCurrentPath(result.path || path)
      setEntries(result.entries)
      setTreeRetryPath(null)
    } catch (error) {
      if (treeRequestSequence.current !== requestId) return
      setTreeError(
        error instanceof Error
          ? error.message
          : t('workbench.workspace_file_load_failed', '加载文件失败'),
      )
      setTreeRetryPath(path)
    } finally {
      if (treeRequestSequence.current === requestId) {
        setTreeLoading(false)
      }
    }
  }, [api, target, t])

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
        onRetry={() => selectedFilePath && void openFile({
          name: selectedFilePath.split('/').pop() ?? selectedFilePath,
          path: selectedFilePath,
          isDirectory: false,
          size: 0,
        })}
        onAddCodeComment={onAddCodeComment}
      />
      <WorkspaceFileTree
        rootPath={target.path}
        currentPath={currentPath}
        entries={entries}
        selectedPath={selectedFilePath}
        loading={treeLoading}
        error={treeError}
        onOpenDirectory={path => void loadTree(path)}
        onOpenFile={entry => void openFile(entry)}
        onRefresh={() => void loadTree(treeRetryPath ?? currentPath)}
      />
    </div>
  )
}
