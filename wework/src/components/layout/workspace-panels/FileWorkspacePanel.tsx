import { WorkspaceAttachmentPreview } from './WorkspaceAttachmentPreview'
import { Code2, Eye, Folders, Loader2 } from 'lucide-react'
import {
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type Ref,
} from 'react'
import { flushSync } from 'react-dom'
import { decodeMarkdownFilePath } from '@/components/chat/assistantMarkdownLinks'
import { useTranslation } from '@/hooks/useTranslation'
import { isWorkspaceDirectoryCacheFresh } from '@/features/workbench/workspaceFileDirectoryCache'
import {
  isAbsoluteWorkspacePath,
  normalizeAbsoluteWorkspacePath,
} from '@/lib/workspace-file-contract'
import {
  createFilePreviewTraceId,
  filePreviewElapsedMs,
  filePreviewPathMetadata,
  logFilePreviewDiagnostic,
  scheduleFilePreviewMainThreadProbe,
} from '@/lib/file-preview-diagnostics'
import { publishSelectedTextSelection } from '@/lib/selected-text-drag'
import { cn } from '@/lib/utils'
import { track } from '@/telemetry/client'
import type {
  CodeCommentContext,
  WorkspaceFileApi,
  WorkspaceFileOpenRequest,
  WorkspaceFileOpenOptions,
  WorkspaceFileEntry,
  WorkspaceFileChunkResponse,
  WorkspaceTarget,
  WorkspaceTextFileResponse,
} from '@/types/workspace-files'
import { WorkspaceFilePreview } from './WorkspaceFilePreview'
import { WorkspaceFileToolbar, WorkspaceFileRootSelector } from './WorkspaceFileToolbar'
import { WorkspaceFileTree } from './WorkspaceFileTree'
import { useWorkspaceFileReveal } from './useWorkspaceFileReveal'
import { isLikelyTextContent, isMarkdownFile, workspaceFilePreviewKind } from './workspaceFileTypes'

// Keep the retained preview observable across slower Windows IPC control round trips.
const ELECTRON_E2E_FILE_TRANSITION_MS = 1_000
const WORKSPACE_FILE_AUTOSAVE_DELAY_MS = 3_000

async function preserveElectronE2EFileTransition(): Promise<void> {
  if (import.meta.env.VITE_WEWORK_E2E !== 'true') return
  await new Promise(resolve => window.setTimeout(resolve, ELECTRON_E2E_FILE_TRANSITION_MS))
}

export interface FileWorkspacePanelSelection {
  path: string
  isDirectory: boolean
}

interface FileWorkspacePanelProps {
  ref?: Ref<FileWorkspacePanelHandle>
  target: WorkspaceTarget | null
  workspaceTargets?: WorkspaceTarget[]
  workspaceFileApi: WorkspaceFileApi
  openFileRequest?: WorkspaceFileOpenRequest | null
  initialSelection?: FileWorkspacePanelSelection | null
  onAddCodeComment: (context: CodeCommentContext) => void
  onDirtyChange?: (dirty: boolean) => void
  onSelectionChange?: (selection: FileWorkspacePanelSelection) => void
  onSelectWorkspaceTarget?: (target: WorkspaceTarget) => void
  onOpenFileTab?: (target: WorkspaceTarget, path: string) => void
}

export interface FileWorkspacePanelHandle {
  navigate: (action: () => void) => void
}

interface PreviewLineTarget {
  filePath: string
  lineStart: number
  lineEnd?: number
}

interface WorkspaceBinaryPreview {
  path: string
  name: string
  size: number
  modifiedAt?: string | null
  file: File
  traceId: string
}

interface FilePreviewLoadingProgress {
  loadedBytes: number
  totalBytes: number | null
}

function decodeBase64(value: string): Uint8Array {
  const decoded = atob(value)
  return Uint8Array.from(decoded, character => character.charCodeAt(0))
}

function mimeTypeForFileName(name: string): string {
  const extension = name.split('.').pop()?.toLowerCase()
  const types: Record<string, string> = {
    csv: 'text/csv',
    doc: 'application/msword',
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    gif: 'image/gif',
    htm: 'text/html',
    html: 'text/html',
    jpeg: 'image/jpeg',
    jpg: 'image/jpeg',
    mp4: 'video/mp4',
    ogv: 'video/ogg',
    pdf: 'application/pdf',
    png: 'image/png',
    ppt: 'application/vnd.ms-powerpoint',
    pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    webp: 'image/webp',
    webm: 'video/webm',
    xls: 'application/vnd.ms-excel',
    xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  }
  return types[extension ?? ''] ?? 'application/octet-stream'
}

function resolveWorkspaceFilePath(target: WorkspaceTarget, path: string): string | null {
  const normalizedPath = decodeMarkdownFilePath(path.trim()).replace(/\\/g, '/')
  if (!normalizedPath) return null
  if (isAbsoluteWorkspacePath(normalizedPath)) {
    try {
      return normalizeAbsoluteWorkspacePath(normalizedPath, 'Workspace file path must be absolute')
    } catch {
      return null
    }
  }

  const segments: string[] = []
  for (const segment of normalizedPath.split('/')) {
    if (!segment || segment === '.') continue
    if (segment === '..') return null
    segments.push(segment)
  }
  if (segments.length === 0) return null

  const root = target.path.replace(/\\/g, '/').replace(/\/+$/, '') || '/'
  const child = segments.join('/')
  return root === '/' ? `/${child}` : `${root}/${child}`
}

function workspaceParentPath(path: string): string {
  const normalized = path.replace(/\/+$/, '')
  const separatorIndex = normalized.lastIndexOf('/')
  const parentPath = separatorIndex > 0 ? normalized.slice(0, separatorIndex) : '/'
  return /^[a-zA-Z]:$/.test(parentPath) ? `${parentPath}/` : parentPath
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
  ref,
  target,
  workspaceTargets = [],
  workspaceFileApi,
  openFileRequest,
  initialSelection,
  onAddCodeComment,
  onDirtyChange,
  onSelectionChange,
  onSelectWorkspaceTarget,
  onOpenFileTab,
}: FileWorkspacePanelProps) {
  const { t } = useTranslation('common')
  const targetDeviceId = target?.deviceId
  const targetPath = target?.path
  const targetSource = target?.source
  const targetTaskId = target?.taskId
  const targetWorkspaceSource = target?.workspaceSource
  const stableTarget = useMemo<WorkspaceTarget | null>(() => {
    if (!targetDeviceId || !targetPath || !targetSource) return null
    return {
      deviceId: targetDeviceId,
      path: targetPath,
      source: targetSource,
      taskId: targetTaskId,
      workspaceSource: targetWorkspaceSource,
    }
  }, [targetDeviceId, targetPath, targetSource, targetTaskId, targetWorkspaceSource])
  const rootPath = stableTarget?.path ?? ''
  const listWorkspaceEntries = workspaceFileApi.listWorkspaceEntries
  const readWorkspaceTextFile = workspaceFileApi.readWorkspaceTextFile
  const readWorkspaceFileChunk = workspaceFileApi.readWorkspaceFileChunk
  const writeWorkspaceTextFile = workspaceFileApi.writeWorkspaceTextFile
  const [activeDirectoryPath, setActiveDirectoryPath] = useState(target?.path ?? '')
  const [entriesByPath, setEntriesByPath] = useState<Record<string, WorkspaceFileEntry[]>>({})
  const [expandedPaths, setExpandedPaths] = useState<Set<string>>(new Set())
  const [selectedFilePath, setSelectedFilePath] = useState<string | null>(null)
  const [selectedPathIsDirectory, setSelectedPathIsDirectory] = useState(false)
  const [attachmentPreview, setAttachmentPreview] =
    useState<WorkspaceFileOpenRequest['attachment']>()
  const [preview, setPreview] = useState<WorkspaceTextFileResponse | null>(null)
  const [binaryPreview, setBinaryPreview] = useState<WorkspaceBinaryPreview | null>(null)
  const [previewLineTarget, setPreviewLineTarget] = useState<PreviewLineTarget | null>(null)
  const [loadingPaths, setLoadingPaths] = useState<Set<string>>(new Set())
  const [treeError, setTreeError] = useState<string | null>(null)
  const [treeRetryPath, setTreeRetryPath] = useState<string | null>(null)
  const [treeRefreshVersion, setTreeRefreshVersion] = useState(0)
  const [previewLoading, setPreviewLoading] = useState(false)
  const [previewTransitionVisible, setPreviewTransitionVisible] = useState(false)
  const [previewLoadingProgress, setPreviewLoadingProgress] =
    useState<FilePreviewLoadingProgress | null>(null)
  const [previewError, setPreviewError] = useState<string | null>(null)
  const [editing, setEditing] = useState(false)
  const [markdownMode, setMarkdownMode] = useState<'preview' | 'source'>('preview')
  const [editedContent, setEditedContent] = useState('')
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [directoryTreeVisible, setDirectoryTreeVisible] = useState(true)
  const initialSelectionRef = useRef(initialSelection)
  const treeRequestSequence = useRef(0)
  const latestTreeRequestByPath = useRef(new Map<string, number>())
  const directoryLoadedAtByPath = useRef(new Map<string, number>())
  const fileRequestSequence = useRef(0)
  const previewPathRef = useRef<string | null>(null)
  const editedContentRef = useRef('')
  const savingRef = useRef(false)
  const pendingNavigationRef = useRef<(() => void) | null>(null)
  const saveFileRef = useRef<() => Promise<boolean>>(async () => false)

  useEffect(() => {
    previewPathRef.current = preview?.path ?? null
  }, [preview?.path])

  const loadTree = useCallback(
    async (path: string, forceRefresh = false) => {
      if (!stableTarget) return
      const cachedAt = directoryLoadedAtByPath.current.get(path)
      if (!forceRefresh && isWorkspaceDirectoryCacheFresh(cachedAt)) {
        setExpandedPaths(previous => new Set(previous).add(path))
        return true
      }
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
        const result = await listWorkspaceEntries(stableTarget.deviceId, path, stableTarget.path)
        if (latestTreeRequestByPath.current.get(path) !== requestId) return
        const resolvedPath = result.path || path
        setEntriesByPath(previous => ({
          ...previous,
          [resolvedPath]: result.entries,
        }))
        directoryLoadedAtByPath.current.set(resolvedPath, Date.now())
        setExpandedPaths(previous => {
          const next = new Set(previous)
          next.add(resolvedPath)
          return next
        })
        setTreeRetryPath(null)
        return true
      } catch (error) {
        if (latestTreeRequestByPath.current.get(path) !== requestId) return
        setTreeError(
          error instanceof Error
            ? error.message
            : t('workbench.workspace_file_load_failed', '加载文件失败')
        )
        setTreeRetryPath(path)
        return false
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
    [listWorkspaceEntries, stableTarget, t]
  )

  const openDirectory = useCallback(
    (entry: WorkspaceFileEntry) => {
      if (!entry.isDirectory) return
      setActiveDirectoryPath(entry.path)
      if (!selectedFilePath) onSelectionChange?.({ path: entry.path, isDirectory: true })
      setTreeError(null)
      setTreeRetryPath(null)

      if (!loadingPaths.has(entry.path)) {
        void loadTree(entry.path)
      }
    },
    [loadTree, loadingPaths, onSelectionChange, selectedFilePath]
  )

  const openFile = useCallback(
    async (entry: WorkspaceFileEntry, options?: WorkspaceFileOpenOptions) => {
      if (!stableTarget || entry.isDirectory) return
      const traceId = options?.traceId ?? createFilePreviewTraceId()
      const pathMetadata = filePreviewPathMetadata(entry.path)
      const requestId = fileRequestSequence.current + 1
      const nextLineTarget = createPreviewLineTarget(entry.path, options)
      fileRequestSequence.current = requestId
      logFilePreviewDiagnostic(traceId, 'open_file_start', {
        ...pathMetadata,
        requestId,
        workspaceSource: stableTarget.workspaceSource ?? null,
      })
      const previousPreviewPath = previewPathRef.current
      if (previousPreviewPath && previousPreviewPath !== entry.path) {
        publishSelectedTextSelection(`workspace-editor:${previousPreviewPath}`, null)
        publishSelectedTextSelection(`workspace-preview:${previousPreviewPath}`, null)
      }
      flushSync(() => setPreviewTransitionVisible(true))
      setSelectedFilePath(entry.path)
      onSelectionChange?.({ path: entry.path, isDirectory: false })
      setMarkdownMode('preview')
      setSelectedPathIsDirectory(false)
      setPreviewLineTarget(nextLineTarget)
      setPreviewLoading(true)
      logFilePreviewDiagnostic(traceId, 'preview_loading_set', { requestId })
      scheduleFilePreviewMainThreadProbe(traceId, 'preview_loading_set')
      setPreviewLoadingProgress(null)
      setPreviewError(null)
      setSaveError(null)
      try {
        const previewKind = workspaceFilePreviewKind(entry.path)
        let firstChunk: WorkspaceFileChunkResponse | null = null
        let firstChunkBytes: Uint8Array | null = null
        let readAsText = previewKind === 'text'
        if (previewKind === 'unknown') {
          if (!readWorkspaceFileChunk) {
            throw new Error('File content detection is unavailable')
          }
          firstChunk = await readWorkspaceFileChunk(
            stableTarget.deviceId,
            entry.path,
            0,
            stableTarget.path
          )
          if (fileRequestSequence.current !== requestId) return
          firstChunkBytes = decodeBase64(firstChunk.contentBase64)
          readAsText = isLikelyTextContent(firstChunkBytes)
        }
        if (readAsText) {
          const file = await readWorkspaceTextFile(
            stableTarget.deviceId,
            entry.path,
            stableTarget.path
          )
          if (fileRequestSequence.current !== requestId) return
          await preserveElectronE2EFileTransition()
          if (fileRequestSequence.current !== requestId) return
          setBinaryPreview(null)
          setPreview(file)
          setEditedContent(file.content)
          const editable = Boolean(file.editable && writeWorkspaceTextFile)
          setEditing(editable)
          setMarkdownMode(editable && isMarkdownFile(file.name) ? 'source' : 'preview')
          return
        }
        if (!readWorkspaceFileChunk) {
          throw new Error('Binary file preview is unavailable')
        }
        const chunks: Uint8Array[] = firstChunkBytes ? [firstChunkBytes] : []
        let offset = firstChunkBytes?.byteLength ?? 0
        let chunk = firstChunk
        if (chunk) {
          setPreviewLoadingProgress({
            loadedBytes: Math.min(offset, chunk.size),
            totalBytes: chunk.size > 0 ? chunk.size : null,
          })
        }
        while (!chunk?.eof) {
          const chunkStartedAt = performance.now()
          logFilePreviewDiagnostic(traceId, 'file_chunk_start', {
            requestId,
            offset,
          })
          const nextChunk = await readWorkspaceFileChunk(
            stableTarget.deviceId,
            entry.path,
            offset,
            stableTarget.path
          )
          logFilePreviewDiagnostic(traceId, 'file_chunk_end', {
            requestId,
            offset,
            durationMs: filePreviewElapsedMs(chunkStartedAt),
            responseBytes: nextChunk.contentBase64.length,
            fileSize: nextChunk.size,
            eof: nextChunk.eof,
          })
          scheduleFilePreviewMainThreadProbe(traceId, 'file_chunk_end')
          if (fileRequestSequence.current !== requestId) return
          chunk = nextChunk
          const decodeStartedAt = performance.now()
          chunks.push(decodeBase64(chunk.contentBase64))
          logFilePreviewDiagnostic(traceId, 'base64_decode_end', {
            requestId,
            offset,
            durationMs: filePreviewElapsedMs(decodeStartedAt),
            decodedBytes: chunks[chunks.length - 1].byteLength,
          })
          offset += chunks[chunks.length - 1].byteLength
          setPreviewLoadingProgress({
            loadedBytes: Math.min(offset, chunk.size),
            totalBytes: chunk.size > 0 ? chunk.size : null,
          })
        }
        if (fileRequestSequence.current !== requestId) return
        if (!chunk) throw new Error('Failed to read workspace file')
        const fileConstructionStartedAt = performance.now()
        const binaryFile = new File(
          chunks.map(part => {
            const copy = new Uint8Array(part.byteLength)
            copy.set(part)
            return copy.buffer
          }),
          chunk.name,
          { type: mimeTypeForFileName(chunk.name) }
        )
        logFilePreviewDiagnostic(traceId, 'file_constructed', {
          requestId,
          durationMs: filePreviewElapsedMs(fileConstructionStartedAt),
          fileSize: chunk.size,
          chunkCount: chunks.length,
        })
        setPreview(null)
        setEditing(false)
        setEditedContent('')
        setBinaryPreview({
          path: chunk.path,
          name: chunk.name,
          size: chunk.size,
          modifiedAt: chunk.modifiedAt,
          file: binaryFile,
          traceId,
        })
        logFilePreviewDiagnostic(traceId, 'binary_preview_state_queued', { requestId })
        scheduleFilePreviewMainThreadProbe(traceId, 'binary_preview_state_queued')
      } catch (error) {
        if (fileRequestSequence.current !== requestId) return
        logFilePreviewDiagnostic(traceId, 'open_file_failed', {
          requestId,
          errorName: error instanceof Error ? error.name : 'UnknownError',
        })
        setPreview(null)
        setEditing(false)
        setEditedContent('')
        setSaveError(null)
        setBinaryPreview(null)
        setPreviewLineTarget(null)
        setPreviewError(
          error instanceof Error
            ? error.message
            : t('workbench.workspace_file_preview_failed', '读取文件失败')
        )
      } finally {
        if (fileRequestSequence.current === requestId) {
          setPreviewLoading(false)
          setPreviewTransitionVisible(false)
          setPreviewLoadingProgress(null)
          logFilePreviewDiagnostic(traceId, 'preview_loading_clear_queued', { requestId })
          scheduleFilePreviewMainThreadProbe(traceId, 'preview_loading_clear_queued')
        } else {
          logFilePreviewDiagnostic(traceId, 'preview_loading_clear_skipped', {
            requestId,
            currentRequestId: fileRequestSequence.current,
          })
        }
      }
    },
    [
      onSelectionChange,
      readWorkspaceFileChunk,
      readWorkspaceTextFile,
      stableTarget,
      t,
      writeWorkspaceTextFile,
    ]
  )

  const openFilePath = useCallback(
    (path: string, options?: WorkspaceFileOpenOptions) => {
      if (!stableTarget) return
      const resolvedPath = resolveWorkspaceFilePath(stableTarget, path)
      if (!resolvedPath) return
      const traceId = options?.traceId ?? createFilePreviewTraceId()
      const tracedOptions = { ...options, traceId }
      const pathMetadata = filePreviewPathMetadata(resolvedPath)
      logFilePreviewDiagnostic(traceId, 'open_file_path_start', pathMetadata)
      scheduleFilePreviewMainThreadProbe(traceId, 'open_file_path_start')

      const openDirectoryPath = (entries?: WorkspaceFileEntry[]) => {
        fileRequestSequence.current += 1
        setSelectedFilePath(resolvedPath)
        onSelectionChange?.({ path: resolvedPath, isDirectory: true })
        setMarkdownMode('preview')
        setSelectedPathIsDirectory(true)
        setActiveDirectoryPath(resolvedPath)
        setDirectoryTreeVisible(true)
        setPreview(null)
        setBinaryPreview(null)
        setPreviewLineTarget(null)
        setPreviewError(null)
        setPreviewLoading(false)
        setEditing(false)
        setEditedContent('')
        setSaveError(null)
        if (entries) {
          setEntriesByPath(previous => ({
            ...previous,
            [resolvedPath]: entries,
          }))
          directoryLoadedAtByPath.current.set(resolvedPath, Date.now())
          setExpandedPaths(previous => new Set(previous).add(resolvedPath))
        } else {
          void loadTree(resolvedPath)
        }
      }

      if (options?.isDirectory) {
        openDirectoryPath()
        return
      }

      const openAsFile = () =>
        void openFile(
          {
            name: resolvedPath.split('/').pop() ?? resolvedPath,
            path: resolvedPath,
            isDirectory: false,
            size: 0,
          },
          tracedOptions
        )

      if (options?.lineStart !== undefined) {
        openAsFile()
        return
      }

      const parentListStartedAt = performance.now()
      logFilePreviewDiagnostic(traceId, 'parent_tree_start', pathMetadata)
      void listWorkspaceEntries(
        stableTarget.deviceId,
        workspaceParentPath(resolvedPath),
        stableTarget.path
      ).then(
        result => {
          logFilePreviewDiagnostic(traceId, 'parent_tree_end', {
            ...pathMetadata,
            durationMs: filePreviewElapsedMs(parentListStartedAt),
            entryCount: result.entries.length,
          })
          scheduleFilePreviewMainThreadProbe(traceId, 'parent_tree_end')
          const entry = result.entries.find(candidate => candidate.path === resolvedPath)
          if (entry?.isDirectory) {
            openDirectoryPath()
            return
          }
          openAsFile()
        },
        error => {
          logFilePreviewDiagnostic(traceId, 'parent_tree_failed', {
            ...pathMetadata,
            durationMs: filePreviewElapsedMs(parentListStartedAt),
            errorName: error instanceof Error ? error.name : 'UnknownError',
          })
          openAsFile()
        }
      )
    },
    [listWorkspaceEntries, loadTree, onSelectionChange, openFile, stableTarget]
  )

  const canEditPreview = Boolean(preview?.editable && writeWorkspaceTextFile)
  const dirty = canEditPreview && preview !== null && editedContent !== preview.content

  useEffect(() => {
    onDirtyChange?.(dirty)
  }, [dirty, onDirtyChange])

  useEffect(
    () => () => {
      onDirtyChange?.(false)
    },
    [onDirtyChange]
  )

  const saveFile = useCallback(async () => {
    if (!stableTarget || !preview || !writeWorkspaceTextFile || !dirty) return !dirty
    if (savingRef.current) return false
    const filePath = preview.path
    const contentToSave = editedContent
    const expectedRevision = preview.revision
    editedContentRef.current = contentToSave
    savingRef.current = true
    setSaving(true)
    setSaveError(null)
    try {
      const saved = await writeWorkspaceTextFile(
        stableTarget.deviceId,
        filePath,
        contentToSave,
        expectedRevision
      )
      setPreview(current => (current?.path === filePath ? saved : current))
      setEditedContent(current => (current === contentToSave ? saved.content : current))
      if (editedContentRef.current === contentToSave && pendingNavigationRef.current !== null) {
        const action = pendingNavigationRef.current
        pendingNavigationRef.current = null
        action()
      }
      track('feature_action_completed', { domain: 'workspace_file', action: 'update' })
      return true
    } catch (error) {
      track('operation_failed', { operation: 'workspace_file_action' })
      setSaveError(
        error instanceof Error ? error.message : t('workbench.workspace_file_save_failed')
      )
      return false
    } finally {
      savingRef.current = false
      setSaving(false)
    }
  }, [dirty, editedContent, preview, stableTarget, t, writeWorkspaceTextFile])

  useEffect(() => {
    saveFileRef.current = saveFile
  }, [saveFile])

  const handleEditedContentChange = useCallback((content: string) => {
    editedContentRef.current = content
    setEditedContent(content)
  }, [])

  useEffect(() => {
    if (!dirty || saving || saveError) return
    const timeoutId = window.setTimeout(() => {
      void saveFile()
    }, WORKSPACE_FILE_AUTOSAVE_DELAY_MS)
    return () => window.clearTimeout(timeoutId)
  }, [dirty, saveError, saveFile, saving])

  const navigateWithDirtyGuard = useCallback(
    (action: () => void) => {
      if (dirty || savingRef.current) {
        pendingNavigationRef.current = action
        if (dirty && !savingRef.current) void saveFileRef.current()
        return
      }
      action()
    },
    [dirty]
  )

  useImperativeHandle(ref, () => ({ navigate: navigateWithDirtyGuard }), [navigateWithDirtyGuard])

  const selectFile = (entry: WorkspaceFileEntry) => {
    navigateWithDirtyGuard(() => {
      if (!entry.isDirectory && selectedFilePath && onOpenFileTab && stableTarget) {
        onOpenFileTab(stableTarget, entry.path)
      } else if (!entry.isDirectory) {
        void openFile(entry)
      } else {
        void openFilePath(entry.path, { isDirectory: true })
      }
    })
  }

  useEffect(() => {
    if (!stableTarget) return
    directoryLoadedAtByPath.current.clear()
    latestTreeRequestByPath.current.clear()
    let cancelled = false
    void Promise.resolve().then(() => {
      if (!cancelled) {
        setEntriesByPath({})
        setExpandedPaths(new Set())
        setActiveDirectoryPath(stableTarget.path)
        setSelectedFilePath(null)
        setMarkdownMode('preview')
        setSelectedPathIsDirectory(false)
        setPreview(null)
        setEditing(false)
        setEditedContent('')
        setSaveError(null)
        setBinaryPreview(null)
        setPreviewLineTarget(null)
        setTreeError(null)
        setTreeRetryPath(null)
        void loadTree(stableTarget.path)
      }
    })
    return () => {
      cancelled = true
    }
  }, [loadTree, stableTarget])

  useWorkspaceFileReveal({
    rootPath,
    selectedPath: selectedFilePath,
    visible: directoryTreeVisible && !selectedPathIsDirectory,
    refreshVersion: treeRefreshVersion,
    loadDirectory: loadTree,
  })

  useEffect(() => {
    if (!stableTarget || openFileRequest?.path) return
    const selection = initialSelectionRef.current
    if (!selection?.path) return

    let cancelled = false
    void Promise.resolve().then(() => {
      if (!cancelled) {
        initialSelectionRef.current = null
        openFilePath(selection.path, { isDirectory: selection.isDirectory })
      }
    })
    return () => {
      cancelled = true
    }
  }, [openFilePath, openFileRequest?.path, stableTarget])

  useEffect(() => {
    if (!openFileRequest?.path) return
    const traceId = openFileRequest.traceId ?? createFilePreviewTraceId()
    logFilePreviewDiagnostic(traceId, 'open_file_request_effect', {
      ...filePreviewPathMetadata(openFileRequest.path),
      requestVersion: openFileRequest.id,
    })
    scheduleFilePreviewMainThreadProbe(traceId, 'open_file_request_effect')
    let cancelled = false
    void Promise.resolve().then(() => {
      if (!cancelled) {
        navigateWithDirtyGuard(() => {
          setAttachmentPreview(openFileRequest.attachment)
          if (openFileRequest.attachment) return
          setDirectoryTreeVisible(false)
          openFilePath(openFileRequest.path, {
            lineStart: openFileRequest.lineStart,
            lineEnd: openFileRequest.lineEnd,
            isDirectory: openFileRequest.isDirectory,
            traceId,
          })
        })
      }
    })
    return () => {
      cancelled = true
    }
  }, [
    navigateWithDirtyGuard,
    openFilePath,
    openFileRequest?.id,
    openFileRequest?.attachment,
    openFileRequest?.lineEnd,
    openFileRequest?.lineStart,
    openFileRequest?.isDirectory,
    openFileRequest?.path,
    openFileRequest?.traceId,
  ])

  useEffect(() => {
    if (!dirty) return

    const preventUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault()
      event.returnValue = ''
    }

    window.addEventListener('beforeunload', preventUnload)
    return () => window.removeEventListener('beforeunload', preventUnload)
  }, [dirty])

  if (attachmentPreview && openFileRequest?.attachment === attachmentPreview)
    return <WorkspaceAttachmentPreview key={openFileRequest?.id} source={attachmentPreview} />

  if (!stableTarget) {
    return (
      <section className="flex min-h-0 flex-1 items-center justify-center px-6 text-center text-sm text-text-muted">
        {t('workbench.workspace_file_no_workspace', '暂无可浏览的工作区')}
      </section>
    )
  }

  const activePreviewLineTarget =
    previewLineTarget && previewLineTarget.filePath === preview?.path ? previewLineTarget : null
  const displayPath = selectedFilePath ?? stableTarget.path
  const directoryTreeToggleLabel = directoryTreeVisible
    ? t('workbench.workspace_file_hide_tree')
    : t('workbench.workspace_file_show_tree')
  const retainedPreview = preview ?? binaryPreview
  const previewTransitioning =
    retainedPreview !== null &&
    selectedFilePath !== null &&
    retainedPreview.path !== selectedFilePath
  const displayedPreview =
    preview && canEditPreview && !editing ? { ...preview, content: editedContent } : preview

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <WorkspaceFileToolbar
        key={`${stableTarget.deviceId}:${displayPath}`}
        path={displayPath}
        isDirectory={selectedPathIsDirectory || !selectedFilePath}
        target={stableTarget}
        api={workspaceFileApi}
        textContent={
          preview?.path === displayPath && !preview.truncated
            ? canEditPreview
              ? editedContent
              : preview.content
            : undefined
        }
        canCopyContents={preview?.path === displayPath}
        onSelect={selectFile}
      >
        {previewTransitionVisible || (previewLoading && retainedPreview) || previewTransitioning ? (
          <span
            data-testid="workspace-file-preview-loading-indicator"
            className="flex h-4 w-4 items-center justify-center text-text-secondary"
          >
            <Loader2
              className="h-4 w-4 animate-spin"
              aria-label={t('workbench.workspace_file_preview_loading')}
            />
          </span>
        ) : null}
        {onSelectWorkspaceTarget && (
          <WorkspaceFileRootSelector
            targets={workspaceTargets}
            target={stableTarget}
            onSelect={target => navigateWithDirtyGuard(() => onSelectWorkspaceTarget(target))}
          />
        )}
        {preview && isMarkdownFile(preview.name) && (
          <button
            type="button"
            data-testid="workspace-file-markdown-mode-button"
            onClick={() => {
              if (canEditPreview) {
                setEditing(current => !current)
                setMarkdownMode(mode => (mode === 'preview' ? 'source' : 'preview'))
                return
              }
              setMarkdownMode(mode => (mode === 'preview' ? 'source' : 'preview'))
            }}
            className="flex h-11 min-w-11 items-center gap-1.5 rounded-md px-2 text-sm text-text-secondary hover:bg-muted hover:text-text-primary md:h-8 md:min-w-0"
            aria-label={
              editing || markdownMode === 'source'
                ? t('workbench.workspace_file_show_preview')
                : t('workbench.workspace_file_show_source')
            }
          >
            {editing || markdownMode === 'source' ? (
              <Eye className="h-4 w-4" />
            ) : (
              <Code2 className="h-4 w-4" />
            )}
            {editing || markdownMode === 'source'
              ? t('workbench.workspace_file_preview')
              : t('workbench.workspace_file_source')}
          </button>
        )}
        {canEditPreview && saving && (
          <span
            data-testid="workspace-file-saving-status"
            className="flex h-8 items-center gap-1.5 px-2 text-xs text-text-secondary"
          >
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            {t('workbench.workspace_file_saving')}
          </span>
        )}
        <button
          type="button"
          data-testid="workspace-file-toggle-tree-button"
          onClick={() => setDirectoryTreeVisible(visible => !visible)}
          className="flex h-8 w-8 items-center justify-center rounded-md text-text-secondary hover:bg-muted hover:text-text-primary"
          aria-label={directoryTreeToggleLabel}
          title={directoryTreeToggleLabel}
        >
          <Folders className="h-4 w-4" />
        </button>
      </WorkspaceFileToolbar>
      <div className="flex min-h-0 flex-1 overflow-hidden">
        <WorkspaceFilePreview
          file={displayedPreview}
          binaryFile={binaryPreview}
          loading={previewLoading}
          loadingProgress={previewLoadingProgress}
          error={previewError}
          onRetry={() => selectedFilePath && openFilePath(selectedFilePath)}
          targetLineStart={activePreviewLineTarget?.lineStart}
          targetLineEnd={activePreviewLineTarget?.lineEnd}
          onAddCodeComment={onAddCodeComment}
          editing={editing}
          editedContent={editedContent}
          onEditedContentChange={handleEditedContentChange}
          onSave={() => void saveFile()}
          markdownMode={markdownMode}
        />
        <div
          data-testid="workspace-file-tree-container"
          className={cn(
            'min-h-0 shrink-0 overflow-hidden transition-[width,opacity] duration-200 ease-out',
            directoryTreeVisible ? 'w-[240px] opacity-100' : 'pointer-events-none w-0 opacity-0'
          )}
        >
          <WorkspaceFileTree
            visible={directoryTreeVisible}
            rootPath={rootPath}
            activeDirectoryPath={activeDirectoryPath}
            entriesByPath={entriesByPath}
            expandedPaths={expandedPaths}
            selectedPath={selectedFilePath}
            loadingPaths={loadingPaths}
            error={treeError}
            onOpenDirectory={openDirectory}
            onOpenFile={selectFile}
            onRefresh={() =>
              navigateWithDirtyGuard(() => {
                void loadTree(treeRetryPath ?? activeDirectoryPath, true).then(loaded => {
                  if (loaded) setTreeRefreshVersion(version => version + 1)
                })
              })
            }
          />
        </div>
      </div>
      {saveError && (
        <div
          data-testid="workspace-file-save-error"
          className="flex items-center justify-between gap-3 border-t border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700"
        >
          <span>{saveError}</span>
          {saveError.toLowerCase().includes('changed on disk') && selectedFilePath && (
            <button
              type="button"
              data-testid="workspace-file-conflict-reload-button"
              className="shrink-0 underline"
              onClick={() => {
                setEditing(false)
                setEditedContent('')
                setSaveError(null)
                openFilePath(selectedFilePath)
              }}
            >
              {t('workbench.workspace_file_reload')}
            </button>
          )}
          {!saveError.toLowerCase().includes('changed on disk') && (
            <button
              type="button"
              data-testid="workspace-file-save-retry-button"
              className="shrink-0 underline"
              onClick={() => {
                setSaveError(null)
                void saveFile()
              }}
            >
              {t('workbench.workspace_file_retry')}
            </button>
          )}
        </div>
      )}
    </div>
  )
}
