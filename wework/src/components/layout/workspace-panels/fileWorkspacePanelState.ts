import { flushSync } from 'react-dom'
import type { TFunction } from 'i18next'
import { resolveWorkspaceFilePath, workspaceParentPath } from './workspaceFilePaths'
import { createWorkspaceDirectoryState } from './workspaceDirectoryState'
import {
  createFilePreviewTraceId,
  filePreviewElapsedMs,
  filePreviewPathMetadata,
  logFilePreviewDiagnostic,
  scheduleFilePreviewMainThreadProbe,
} from '@/lib/file-preview-diagnostics'
import { publishSelectedTextSelection } from '@/lib/selected-text-drag'
import { track } from '@/telemetry/client'
import type {
  WorkspaceFileApi,
  WorkspaceFileEntry,
  WorkspaceFileOpenOptions,
  WorkspaceFileOpenRequest,
  WorkspaceTextFileResponse,
  WorkspaceFileChunkResponse,
  WorkspaceTarget,
} from '@/types/workspace-files'
import type { FileWorkspacePanelProps } from './FileWorkspacePanel'
import {
  isHtmlFile,
  isLikelyTextContent,
  isPreviewableTextFile,
  mimeTypeForFileName,
  workspaceFilePreviewKind,
} from './workspaceFileTypes'

// Keep the retained preview observable across slower Windows IPC control round trips.
const ELECTRON_E2E_FILE_TRANSITION_MS = 1_000
const WORKSPACE_FILE_AUTOSAVE_DELAY_MS = 3_000

async function preserveElectronE2EFileTransition(): Promise<void> {
  if (import.meta.env.VITE_WEWORK_E2E !== 'true') return
  await new Promise(resolve => window.setTimeout(resolve, ELECTRON_E2E_FILE_TRANSITION_MS))
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

export type FileWorkspaceCallbacks = Pick<
  FileWorkspacePanelProps,
  'onDirtyChange' | 'onSelectionChange' | 'onOpenFileTab' | 'initialSelection' | 'openFileRequest'
> & { t: TFunction<'common'> }

interface FileWorkspaceState {
  selectedFilePath: string | null
  selectedPathIsDirectory: boolean
  attachmentPreview: WorkspaceFileOpenRequest['attachment']
  preview: WorkspaceTextFileResponse | null
  editedContent: string
  loadVersion: number | undefined
  binaryPreview: WorkspaceBinaryPreview | null
  previewLineTarget: PreviewLineTarget | null
  previewLoading: boolean
  previewTransitionVisible: boolean
  previewLoadingProgress: FilePreviewLoadingProgress | null
  previewError: string | null
  editing: boolean
  previewMode: 'preview' | 'source'
  saving: boolean
  saveError: string | null
  directoryTreeVisible: boolean
  dirty: boolean
  directory: ReturnType<ReturnType<typeof createWorkspaceDirectoryState>['getSnapshot']>
}
const dirtyOwners = new WeakMap<NonNullable<FileWorkspaceCallbacks['onDirtyChange']>, object>()

/** One target and API scope owns file reads, edits, pending navigation and directory state. */
export function createFileWorkspacePanelState(
  stableTarget: WorkspaceTarget | null,
  api: WorkspaceFileApi
) {
  const {
    listWorkspaceEntries,
    readWorkspaceTextFile,
    readWorkspaceFileChunk,
    writeWorkspaceTextFile,
  } = api
  const directories = createWorkspaceDirectoryState(
    stableTarget?.path ?? '',
    stableTarget
      ? path => listWorkspaceEntries(stableTarget.deviceId, path, stableTarget.path)
      : null,
    Boolean(stableTarget)
  )
  const listeners = new Set<() => void>()
  let snapshot: FileWorkspaceState = {
    selectedFilePath: null,
    selectedPathIsDirectory: false,
    attachmentPreview: undefined,
    preview: null,
    editedContent: '',
    loadVersion: undefined,
    binaryPreview: null,
    previewLineTarget: null,
    previewLoading: false,
    previewTransitionVisible: false,
    previewLoadingProgress: null,
    previewError: null,
    editing: false,
    previewMode: 'preview',
    saving: false,
    saveError: null,
    directoryTreeVisible: true,
    dirty: false,
    directory: directories.getSnapshot(),
  }
  let callbacks: FileWorkspaceCallbacks | undefined
  let stopDirectories: (() => void) | undefined
  let fileRequestSequence = 0
  let editVersion = 0
  let lifetime = 0
  let saving = false
  let pendingNavigation: (() => void) | null = null
  let autosaveTimer: ReturnType<typeof setTimeout> | undefined
  let autosaveKey = ''
  let lastDirty: { callback: FileWorkspaceCallbacks['onDirtyChange']; dirty: boolean } | undefined
  let dirtyLease: object = {}
  let handledRequest: { key: string; attachment: WorkspaceFileOpenRequest['attachment'] } | null =
    null
  let handledInitial = ''
  let inputVersion = 0
  const isDirty = () =>
    Boolean(
      snapshot.preview?.editable &&
      writeWorkspaceTextFile &&
      snapshot.editedContent !== snapshot.preview.content
    )
  const reportDirty = () => {
    if (!callbacks || !listeners.size) return
    if (
      lastDirty &&
      lastDirty.callback === callbacks.onDirtyChange &&
      lastDirty.dirty === snapshot.dirty
    )
      return
    lastDirty = { callback: callbacks.onDirtyChange, dirty: snapshot.dirty }
    callbacks.onDirtyChange?.(snapshot.dirty)
  }
  const synchronize = () => {
    directories.updateReveal({
      selectedPath: snapshot.selectedFilePath,
      visible: snapshot.directoryTreeVisible && !snapshot.selectedPathIsDirectory,
      refreshVersion: 0,
      errorMessage: callbacks?.t('workbench.workspace_file_load_failed', '加载文件失败'),
    })
    reportDirty()
    const key = JSON.stringify([
      snapshot.preview?.path,
      snapshot.preview?.revision,
      snapshot.loadVersion,
      editVersion,
      snapshot.dirty,
      snapshot.saving,
      snapshot.saveError,
    ])
    if (key !== autosaveKey) {
      autosaveKey = key
      clearTimeout(autosaveTimer)
      if (snapshot.dirty && !snapshot.saving && !snapshot.saveError)
        autosaveTimer = setTimeout(() => void saveFile(), WORKSPACE_FILE_AUTOSAVE_DELAY_MS)
    }
  }
  const publish = (patch: Partial<FileWorkspaceState>) => {
    if (!listeners.size) return
    snapshot = { ...snapshot, ...patch }
    snapshot = { ...snapshot, dirty: isDirty() }
    synchronize()
    listeners.forEach(listener => listener())
  }
  const setAttachmentPreview = (attachmentPreview: FileWorkspaceState['attachmentPreview']) =>
    publish({ attachmentPreview })
  const setBinaryPreview = (binaryPreview: FileWorkspaceState['binaryPreview']) =>
    publish({ binaryPreview })
  const setPreviewLineTarget = (previewLineTarget: FileWorkspaceState['previewLineTarget']) =>
    publish({ previewLineTarget })
  const setPreviewLoading = (previewLoading: FileWorkspaceState['previewLoading']) =>
    publish({ previewLoading })
  const setPreviewTransitionVisible = (
    previewTransitionVisible: FileWorkspaceState['previewTransitionVisible']
  ) => publish({ previewTransitionVisible })
  const setPreviewLoadingProgress = (
    previewLoadingProgress: FileWorkspaceState['previewLoadingProgress']
  ) => publish({ previewLoadingProgress })
  const setPreviewError = (previewError: FileWorkspaceState['previewError']) =>
    publish({ previewError })
  const setEditing = (editing: FileWorkspaceState['editing']) => publish({ editing })
  const setPreviewMode = (previewMode: FileWorkspaceState['previewMode']) =>
    publish({ previewMode })
  const setSaving = (saving: FileWorkspaceState['saving']) => publish({ saving })
  const setSaveError = (saveError: FileWorkspaceState['saveError']) => publish({ saveError })
  const setDirectoryTreeVisible = (
    directoryTreeVisible: FileWorkspaceState['directoryTreeVisible']
  ) => publish({ directoryTreeVisible })
  const clearDocument = () => publish({ preview: null, editedContent: '', loadVersion: undefined })
  const acceptRead = (file: WorkspaceTextFileResponse, loadVersion: number) =>
    publish({ preview: file, editedContent: file.content, loadVersion })
  const acceptSave = (
    path: string,
    version: number | undefined,
    file: WorkspaceTextFileResponse,
    content: string
  ) => {
    if (snapshot.preview?.path !== path || snapshot.loadVersion !== version) return
    publish({
      preview: file,
      editedContent: snapshot.editedContent === content ? file.content : snapshot.editedContent,
    })
  }
  const openTreeDirectory = directories.openDirectory
  function navigate(action: () => void) {
    if (!listeners.size) return
    if (isDirty() || saving) {
      pendingNavigation = action
      if (isDirty() && !saving) void saveFile()
    } else action()
  }
  async function openFile(
    entry: WorkspaceFileEntry,
    options?: WorkspaceFileOpenOptions
  ): Promise<void> {
    if (!stableTarget || entry.isDirectory || !listeners.size || !callbacks) return
    const t = callbacks.t
    const traceId = options?.traceId ?? createFilePreviewTraceId()
    const pathMetadata = filePreviewPathMetadata(entry.path)
    const requestId = fileRequestSequence + 1
    const readEditVersion = editVersion
    const deferIfEdited = () => {
      if (editVersion === readEditVersion) return false
      navigate(() => void openFile(entry, options))
      return true
    }
    const nextLineTarget = createPreviewLineTarget(entry.path, options)
    fileRequestSequence = requestId
    logFilePreviewDiagnostic(traceId, 'open_file_start', {
      ...pathMetadata,
      requestId,
      workspaceSource: stableTarget.workspaceSource ?? null,
    })
    const previousPreviewPath = snapshot.preview?.path ?? null
    if (previousPreviewPath && previousPreviewPath !== entry.path) {
      publishSelectedTextSelection(`workspace-editor:${previousPreviewPath}`, null)
      publishSelectedTextSelection(`workspace-preview:${previousPreviewPath}`, null)
    }
    flushSync(() => setPreviewTransitionVisible(true))
    publish({
      selectedFilePath: entry.path,
      previewMode: 'preview',
      selectedPathIsDirectory: false,
      previewLineTarget: nextLineTarget,
      previewLoading: true,
      previewLoadingProgress: null,
      previewError: null,
      saveError: null,
    })
    callbacks.onSelectionChange?.({ path: entry.path, isDirectory: false })
    logFilePreviewDiagnostic(traceId, 'preview_loading_set', { requestId })
    scheduleFilePreviewMainThreadProbe(traceId, 'preview_loading_set')
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
        if (fileRequestSequence !== requestId || !listeners.size) return
        firstChunkBytes = decodeBase64(firstChunk.contentBase64)
        readAsText = isLikelyTextContent(firstChunkBytes)
      }
      if (readAsText) {
        const file = await readWorkspaceTextFile(
          stableTarget.deviceId,
          entry.path,
          stableTarget.path
        )
        if (fileRequestSequence !== requestId || !listeners.size) return
        await preserveElectronE2EFileTransition()
        if (fileRequestSequence !== requestId || !listeners.size) return
        if (deferIfEdited()) return
        pendingNavigation = null
        setBinaryPreview(null)
        acceptRead(file, requestId)
        const nextPreviewMode =
          isHtmlFile(file.name) && options?.lineStart !== undefined ? 'source' : 'preview'
        setPreviewMode(nextPreviewMode)
        setEditing(
          Boolean(file.editable && writeWorkspaceTextFile) &&
            (!isPreviewableTextFile(file.name) || nextPreviewMode === 'source')
        )
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
        if (fileRequestSequence !== requestId || !listeners.size) return
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
      if (fileRequestSequence !== requestId || !listeners.size) return
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
      if (deferIfEdited()) return
      pendingNavigation = null
      clearDocument()
      setEditing(false)
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
      if (fileRequestSequence !== requestId || !listeners.size || deferIfEdited()) return
      logFilePreviewDiagnostic(traceId, 'open_file_failed', {
        requestId,
        errorName: error instanceof Error ? error.name : 'UnknownError',
      })
      clearDocument()
      setEditing(false)
      setSaveError(null)
      setBinaryPreview(null)
      setPreviewLineTarget(null)
      setPreviewError(
        error instanceof Error
          ? error.message
          : t('workbench.workspace_file_preview_failed', '读取文件失败')
      )
    } finally {
      if (fileRequestSequence === requestId && listeners.size) {
        setPreviewLoading(false)
        setPreviewTransitionVisible(false)
        setPreviewLoadingProgress(null)
        logFilePreviewDiagnostic(traceId, 'preview_loading_clear_queued', { requestId })
        scheduleFilePreviewMainThreadProbe(traceId, 'preview_loading_clear_queued')
      } else {
        logFilePreviewDiagnostic(traceId, 'preview_loading_clear_skipped', {
          requestId,
          currentRequestId: fileRequestSequence,
        })
      }
    }
  }
  function openFilePath(path: string, options?: WorkspaceFileOpenOptions) {
    if (!stableTarget || !listeners.size) return
    const resolvedPath = resolveWorkspaceFilePath(stableTarget, path)
    if (!resolvedPath) return
    const traceId = options?.traceId ?? createFilePreviewTraceId()
    const tracedOptions = { ...options, traceId }
    const pathMetadata = filePreviewPathMetadata(resolvedPath)
    logFilePreviewDiagnostic(traceId, 'open_file_path_start', pathMetadata)
    scheduleFilePreviewMainThreadProbe(traceId, 'open_file_path_start')

    const openDirectoryPath = () => {
      fileRequestSequence += 1
      publish({
        selectedFilePath: resolvedPath,
        previewMode: 'preview',
        selectedPathIsDirectory: true,
        directoryTreeVisible: true,
        preview: null,
        editedContent: '',
        loadVersion: undefined,
        binaryPreview: null,
        previewLineTarget: null,
        previewError: null,
        previewLoading: false,
        editing: false,
        saveError: null,
      })
      callbacks?.onSelectionChange?.({ path: resolvedPath, isDirectory: true })
      openTreeDirectory(resolvedPath)
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

    const listingRequestId = ++fileRequestSequence
    const parentListStartedAt = performance.now()
    logFilePreviewDiagnostic(traceId, 'parent_tree_start', pathMetadata)
    void listWorkspaceEntries(
      stableTarget.deviceId,
      workspaceParentPath(resolvedPath),
      stableTarget.path
    ).then(
      result => {
        if (fileRequestSequence !== listingRequestId || !listeners.size) return
        logFilePreviewDiagnostic(traceId, 'parent_tree_end', {
          ...pathMetadata,
          durationMs: filePreviewElapsedMs(parentListStartedAt),
          entryCount: result.entries.length,
        })
        scheduleFilePreviewMainThreadProbe(traceId, 'parent_tree_end')
        const entry = result.entries.find(candidate => candidate.path === resolvedPath)
        navigate(() => {
          if (entry?.isDirectory) openDirectoryPath()
          else openAsFile()
        })
      },
      error => {
        if (fileRequestSequence !== listingRequestId || !listeners.size) return
        logFilePreviewDiagnostic(traceId, 'parent_tree_failed', {
          ...pathMetadata,
          durationMs: filePreviewElapsedMs(parentListStartedAt),
          errorName: error instanceof Error ? error.name : 'UnknownError',
        })
        navigate(openAsFile)
      }
    )
  }
  async function saveFile(): Promise<boolean> {
    const { preview, editedContent, loadVersion } = snapshot
    const dirty = isDirty()
    if (!callbacks || !listeners.size) return false
    const t = callbacks.t
    if (!stableTarget || !preview || !writeWorkspaceTextFile || !dirty) return !dirty
    if (saving) return false
    const owner = lifetime
    const filePath = preview.path
    const contentToSave = editedContent
    const expectedRevision = preview.revision
    saving = true
    setSaving(true)
    setSaveError(null)
    try {
      const saved = await writeWorkspaceTextFile(
        stableTarget.deviceId,
        filePath,
        contentToSave,
        expectedRevision
      )
      if (!listeners.size || owner !== lifetime) return false
      const unchanged = snapshot.editedContent === contentToSave
      acceptSave(filePath, loadVersion, saved, contentToSave)
      if (unchanged && pendingNavigation !== null) {
        const action = pendingNavigation
        pendingNavigation = null
        action()
      }
      track('feature_action_completed', { domain: 'workspace_file', action: 'update' })
      return true
    } catch (error) {
      if (!listeners.size || owner !== lifetime) return false
      track('operation_failed', { operation: 'workspace_file_action' })
      setSaveError(
        error instanceof Error ? error.message : t('workbench.workspace_file_save_failed')
      )
      return false
    } finally {
      if (owner === lifetime) {
        saving = false
        setSaving(false)
      }
    }
  }
  function selectFile(entry: WorkspaceFileEntry) {
    navigate(() => {
      if (
        !entry.isDirectory &&
        snapshot.selectedFilePath &&
        snapshot.selectedFilePath !== entry.path &&
        callbacks?.onOpenFileTab &&
        stableTarget
      )
        callbacks.onOpenFileTab(stableTarget, entry.path)
      else if (!entry.isDirectory) void openFile(entry)
      else openFilePath(entry.path, { isDirectory: true })
    })
  }
  const processInputs = () => {
    const request = callbacks?.openFileRequest
    const key = request?.path
      ? JSON.stringify([
          request.id,
          request.path,
          request.lineStart,
          request.lineEnd,
          request.isDirectory,
          request.traceId,
        ])
      : ''
    if (key) {
      if (handledRequest?.key === key && handledRequest.attachment === request?.attachment) return
      handledRequest = { key, attachment: request?.attachment }
      const version = ++inputVersion
      queueMicrotask(() => {
        if (!listeners.size || version !== inputVersion || !request) return
        const traceId = request.traceId ?? createFilePreviewTraceId()
        logFilePreviewDiagnostic(traceId, 'open_file_request_effect', {
          ...filePreviewPathMetadata(request.path),
          requestVersion: request.id,
        })
        scheduleFilePreviewMainThreadProbe(traceId, 'open_file_request_effect')
        navigate(() => {
          setAttachmentPreview(request.attachment)
          if (request.attachment) return
          setDirectoryTreeVisible(false)
          openFilePath(request.path, {
            lineStart: request.lineStart,
            lineEnd: request.lineEnd,
            isDirectory: request.isDirectory,
            traceId,
          })
        })
      })
    } else {
      if (handledRequest) {
        handledRequest = null
        inputVersion += 1
      }
      const initial = callbacks?.initialSelection
      const initialKey = JSON.stringify([initial?.path, initial?.isDirectory])
      if (handledInitial === initialKey) return
      handledInitial = initialKey
      const version = ++inputVersion
      queueMicrotask(() => {
        if (
          !listeners.size ||
          version !== inputVersion ||
          !initial?.path ||
          !stableTarget ||
          snapshot.selectedFilePath === initial.path ||
          (initial.isDirectory && snapshot.directory.activeDirectoryPath === initial.path)
        )
          return
        navigate(() => openFilePath(initial.path, { isDirectory: initial.isDirectory }))
      })
    }
  }
  return {
    getSnapshot: () => snapshot,
    subscribe(listener: () => void, next: FileWorkspaceCallbacks) {
      listeners.add(listener)
      callbacks = next
      dirtyLease = {}
      if (next.onDirtyChange) dirtyOwners.set(next.onDirtyChange, dirtyLease)
      if (!stopDirectories) {
        lifetime += 1
        stopDirectories = directories.subscribe(
          () => {
            snapshot = { ...snapshot, directory: directories.getSnapshot() }
            listeners.forEach(active => active())
          },
          {
            selectedPath: snapshot.selectedFilePath,
            visible: snapshot.directoryTreeVisible && !snapshot.selectedPathIsDirectory,
            refreshVersion: 0,
            errorMessage: next.t('workbench.workspace_file_load_failed', '加载文件失败'),
          }
        )
      }
      synchronize()
      processInputs()
      return () => {
        listeners.delete(listener)
        const callback = next.onDirtyChange,
          lease = dirtyLease
        queueMicrotask(() => {
          if (listeners.size) return
          lifetime += 1
          fileRequestSequence += 1
          inputVersion += 1
          clearTimeout(autosaveTimer)
          pendingNavigation = null
          stopDirectories?.()
          stopDirectories = undefined
          if (callback && dirtyOwners.get(callback) === lease) {
            dirtyOwners.delete(callback)
            callback(false)
          }
        })
      }
    },
    navigate,
    selectFile,
    openFilePath,
    saveFile,
    openDirectory(entry: WorkspaceFileEntry) {
      if (!entry.isDirectory || !listeners.size) return
      if (!snapshot.selectedFilePath)
        callbacks?.onSelectionChange?.({ path: entry.path, isDirectory: true })
      openTreeDirectory(entry.path)
    },
    refreshTree: () => navigate(() => void directories.refresh()),
    edit(content: string) {
      editVersion += 1
      publish({ editedContent: content })
    },
    toggleTree: () => setDirectoryTreeVisible(!snapshot.directoryTreeVisible),
    setPreviewMode,
    setEditing,
    setSaveError,
    reload() {
      if (!snapshot.selectedFilePath) return
      pendingNavigation = null
      setEditing(false)
      setSaveError(null)
      openFilePath(snapshot.selectedFilePath)
    },
  }
}
