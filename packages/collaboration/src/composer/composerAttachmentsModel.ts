import {
  createPreparingAttachment,
  failedPreparationFile,
} from '@wegent/chat-core/runtime-attachments'
import type { Attachment } from '@wegent/chat-core/runtime'
export interface MultiAttachmentUploadState {
  attachments: Attachment[]
  uploadingFiles: Map<string, { file: File; progress: number; previewUrl?: string }>
  errors: Map<string, string>
}
import { releaseAttachmentPreview, isWorkspaceImageFile } from './attachmentFiles'
import { readTextAttachmentMetadata } from '../issue-detail/attachmentPresentation'
import { isPastedTextFile } from './pastedTextAttachment'

export interface ComposerAttachmentsOptions {
  onAction?: (action: 'upload' | 'delete' | 'failed') => void
  uploadAttachment: (file: File, onProgress?: (progress: number) => void) => Promise<Attachment>
  deleteAttachment: (attachmentId: number) => Promise<void>
  scopeKey?: string
  initialState?: ComposerAttachmentsInitialState
}

const DEFAULT_ATTACHMENT_SCOPE_KEY = 'default'

interface PendingSelection {
  file: File
  attachment: Attachment
  submitted: boolean
  captured: boolean
  resolve: (attachment: Attachment) => void
  reject: (error: unknown) => void
}

interface AttachmentSource {
  file?: File
  filename: string
  cancelled: boolean
  attachment?: Attachment
  cleanup?: Promise<void>
  deleteAttachment?: ComposerAttachmentsOptions['deleteAttachment']
}

function emptyAttachmentState(): MultiAttachmentUploadState {
  return {
    attachments: [],
    uploadingFiles: new Map(),
    errors: new Map(),
  }
}

function createImagePreview(file: File): string | undefined {
  if (
    !isWorkspaceImageFile(file) ||
    typeof URL === 'undefined' ||
    typeof URL.createObjectURL !== 'function'
  ) {
    return undefined
  }
  return URL.createObjectURL(file)
}

function releaseImagePreview(previewUrl: string | undefined): void {
  if (!previewUrl || typeof URL === 'undefined' || typeof URL.revokeObjectURL !== 'function') {
    return
  }
  URL.revokeObjectURL(previewUrl)
}

export interface ComposerAttachmentsInitialState {
  scopeKey?: string
  attachments?: Array<{ attachment: Attachment; file?: File }>
  files?: File[]
}

export function includeDraftAttachmentGroup({
  submittedAttachments,
  draftAttachments,
  sourceAttachmentId,
}: {
  submittedAttachments: Attachment[]
  draftAttachments: Attachment[]
  sourceAttachmentId?: number
}): Attachment[] {
  if (sourceAttachmentId === undefined) return submittedAttachments
  const source = draftAttachments.find(attachment => attachment.id === sourceAttachmentId)
  if (!source?.ui_group_id) return submittedAttachments

  const submittedIds = new Set(submittedAttachments.map(attachment => attachment.id))
  const companions = draftAttachments.filter(
    attachment =>
      attachment.ui_group_id === source.ui_group_id &&
      attachment.id !== source.id &&
      !submittedIds.has(attachment.id)
  )
  const [admitted] = submittedAttachments
  if (!admitted) return submittedAttachments
  Object.assign(admitted, {
    ui_group_id: source.ui_group_id,
    ui_group_role: source.ui_group_role,
    ui_kind: source.ui_kind,
  })
  return submittedAttachments.concat(companions)
}

export function createComposerAttachmentsModel(
  options: ComposerAttachmentsOptions,
  initial?: ComposerAttachmentsInitialState
) {
  initial ??= options.initialState
  let config = options
  const listeners = new Set<() => void>()
  const scopeObservers = new Map<string, number>()
  const pendingReleases = new Set<string>()
  const emptyScopes = new Map<string, MultiAttachmentUploadState>()
  let stateByScope: Record<string, MultiAttachmentUploadState> = {}
  let started = false
  let queuedFiles = initial?.files ?? []
  const initialScope = initial?.scopeKey ?? options.scopeKey ?? DEFAULT_ATTACHMENT_SCOPE_KEY
  const getScopeSnapshot = (scope: string) => {
    if (stateByScope[scope]) return stateByScope[scope]
    let empty = emptyScopes.get(scope)
    if (!empty) {
      empty = emptyAttachmentState()
      emptyScopes.set(scope, empty)
    }
    return empty
  }
  const deleteAttachment: ComposerAttachmentsOptions['deleteAttachment'] = (...args) =>
    config.deleteAttachment(...args)
  const pendingByScope = new Map<string, Set<PendingSelection>>()
  const captureAttachmentsForScope = (scope: string) => {
    const pending = [...(pendingByScope.get(scope) ?? [])].filter(item => !item.submitted)
    pending.forEach(item => {
      item.captured = true
    })
    return [...getScopeSnapshot(scope).attachments, ...pending.map(item => item.attachment)]
  }
  let uploadSequence = 0
  const scopeEpochs = new Map<string, number>()
  const latestAttemptsByScope = new Map<string, Map<string, string>>()
  const sourcesByScope = new Map<string, Map<string, AttachmentSource>>()
  const attachmentSourcesByScope = new Map<string, Map<number, AttachmentSource>>()
  const updateScopeState = (
    targetScopeKey: string,
    updater: (current: MultiAttachmentUploadState) => MultiAttachmentUploadState
  ) => {
    const current = getScopeSnapshot(targetScopeKey)
    const next = updater(current)
    if (next === current) return
    stateByScope = { ...stateByScope, [targetScopeKey]: next }
    listeners.forEach(listener => listener())
  }

  const addExistingAttachmentForScope = (
    targetScopeKey: string,
    attachment: Attachment,
    file?: File
  ) => {
    const retryFile = failedPreparationFile(attachment)
    if (retryFile) {
      void handleFileSelectForScope(targetScopeKey, retryFile)
      return
    }
    if (file) {
      const id = `${file.name}:${++uploadSequence}`
      const source: AttachmentSource = {
        file,
        filename: file.name,
        cancelled: false,
        attachment,
        deleteAttachment: config.deleteAttachment,
      }
      const sources = sourcesByScope.get(targetScopeKey) ?? new Map()
      sources.set(id, source)
      sourcesByScope.set(targetScopeKey, sources)
      const attachments = attachmentSourcesByScope.get(targetScopeKey) ?? new Map()
      attachments.set(attachment.id, source)
      attachmentSourcesByScope.set(targetScopeKey, attachments)
    }
    updateScopeState(targetScopeKey, current => {
      if (current.attachments.some(item => item.id === attachment.id)) return current
      return {
        ...current,
        attachments: [...current.attachments, attachment],
      }
    })
  }

  const discardSourceAttachment = (source: AttachmentSource) => {
    const attachment = source.attachment
    if (!attachment) return Promise.resolve()
    if (!source.cleanup) {
      releaseAttachmentPreview(attachment)
      source.cleanup = (
        attachment.id > 0
          ? (source.deleteAttachment ?? deleteAttachment)(attachment.id)
          : Promise.resolve()
      ).finally(() => {
        source.attachment = undefined
      })
    }
    return source.cleanup
  }

  const handleFileSelectForScope = async (
    targetScopeKey: string,
    files: File | File[],
    trackSource = false
  ) => {
    const { uploadAttachment, deleteAttachment, onAction } = config
    const epoch = scopeEpochs.get(targetScopeKey) ?? 0
    const fileList = Array.isArray(files) ? files : [files]
    const selections = fileList.map(file => {
      let resolve!: PendingSelection['resolve']
      let reject!: PendingSelection['reject']
      const ready = new Promise<Attachment>((yes, no) => {
        resolve = yes
        reject = no
      })
      const pending: PendingSelection = {
        file,
        attachment: createPreparingAttachment(file, ready),
        submitted: false,
        captured: false,
        resolve,
        reject,
      }
      const pendingFiles = pendingByScope.get(targetScopeKey) ?? new Set()
      pendingFiles.add(pending)
      pendingByScope.set(targetScopeKey, pendingFiles)
      if (!trackSource) return { file, fileId: undefined, source: undefined, pending }
      const fileId = `${file.name}:${++uploadSequence}`
      const source: AttachmentSource = {
        file,
        filename: file.name,
        cancelled: false,
        deleteAttachment,
      }
      const sources = sourcesByScope.get(targetScopeKey) ?? new Map()
      sources.set(fileId, source)
      sourcesByScope.set(targetScopeKey, sources)
      return { file, fileId, source, pending }
    })
    if (trackSource) {
      updateScopeState(targetScopeKey, current => {
        const uploadingFiles = new Map(current.uploadingFiles)
        for (const { file, fileId } of selections) {
          if (fileId) uploadingFiles.set(fileId, { file, progress: 0 })
        }
        return { ...current, uploadingFiles }
      })
    }
    for (const { file, fileId: queuedFileId, source, pending } of selections) {
      if (
        !pending.submitted &&
        (source?.cancelled || (scopeEpochs.get(targetScopeKey) ?? 0) !== epoch)
      ) {
        pending.reject(new Error('Attachment selection was cancelled'))
        pendingByScope.get(targetScopeKey)?.delete(pending)
        continue
      }
      const fileId = queuedFileId ?? `${file.name}:${++uploadSequence}`
      const latestAttempts = latestAttemptsByScope.get(targetScopeKey) ?? new Map<string, string>()
      latestAttempts.set(file.name, fileId)
      latestAttemptsByScope.set(targetScopeKey, latestAttempts)

      const previewUrl = createImagePreview(file)
      updateScopeState(targetScopeKey, current => {
        if (pending.submitted) return current
        const uploadingFiles = new Map(current.uploadingFiles)
        const errors = new Map(current.errors)
        errors.delete(file.name)
        uploadingFiles.set(fileId, { file, progress: 0, previewUrl })
        return { ...current, uploadingFiles, errors }
      })

      let previewTransferred = false
      let retainFailedAttempt = false
      try {
        const textMetadataPromise = readTextAttachmentMetadata(file)
        const attachment = await uploadAttachment(file, progress => {
          updateScopeState(targetScopeKey, current => {
            if (pending.submitted) return current
            const uploadingFiles = new Map(current.uploadingFiles)
            const existing = uploadingFiles.get(fileId)
            if (existing) {
              uploadingFiles.set(fileId, { ...existing, progress })
            }
            return { ...current, uploadingFiles }
          })
        })
        if (source) {
          source.attachment = attachment
          const sources = attachmentSourcesByScope.get(targetScopeKey) ?? new Map()
          sources.set(attachment.id, source)
          attachmentSourcesByScope.set(targetScopeKey, sources)
        }
        const textMetadata = await textMetadataPromise
        if (!pending.submitted && !source && (scopeEpochs.get(targetScopeKey) ?? 0) !== epoch) {
          pending.reject(new Error('Attachment selection was cancelled'))
          releaseAttachmentPreview(attachment)
          if (attachment.id > 0) await deleteAttachment(attachment.id)
          continue
        }
        if (!pending.submitted && source?.cancelled) {
          pending.reject(new Error('Attachment selection was cancelled'))
          await discardSourceAttachment(source)
          continue
        }
        let enrichedAttachment = textMetadata
          ? {
              ...attachment,
              text_preview: attachment.text_preview ?? textMetadata.text_preview,
              text_content: attachment.text_content ?? textMetadata.text_content,
              text_length: attachment.text_length ?? textMetadata.text_length,
            }
          : attachment
        if (isPastedTextFile(file))
          enrichedAttachment = {
            ...enrichedAttachment,
            ui_kind: 'pasted-text',
          }
        if (previewUrl && !pending.submitted && enrichedAttachment.mime_type === file.type) {
          if (enrichedAttachment.local_preview_url !== previewUrl) {
            releaseAttachmentPreview(enrichedAttachment)
          }
          enrichedAttachment = {
            ...enrichedAttachment,
            local_preview_url: previewUrl,
          }
          previewTransferred = true
        }
        if (pending.submitted) {
          releaseAttachmentPreview(enrichedAttachment)
          enrichedAttachment = {
            ...enrichedAttachment,
            local_preview_url: enrichedAttachment.local_path,
          }
        }
        if (source) source.attachment = enrichedAttachment
        pending.resolve(enrichedAttachment)

        updateScopeState(targetScopeKey, current => {
          if (pending.submitted) return current
          const uploadingFiles = new Map(current.uploadingFiles)
          uploadingFiles.delete(fileId)
          return {
            ...current,
            attachments: source?.cancelled
              ? current.attachments
              : [...current.attachments, enrichedAttachment],
            uploadingFiles,
          }
        })
        onAction?.('upload')
      } catch (error) {
        pending.reject(error)
        onAction?.('failed')
        const isLatestAttempt = latestAttemptsByScope.get(targetScopeKey)?.get(file.name) === fileId
        retainFailedAttempt = Boolean(source && !source.cancelled && isLatestAttempt)
        updateScopeState(targetScopeKey, current => {
          if (pending.submitted) return current
          const uploadingFiles = new Map(current.uploadingFiles)
          const errors = new Map(current.errors)
          uploadingFiles.delete(fileId)
          if (isLatestAttempt && !source?.cancelled) {
            errors.set(file.name, error instanceof Error ? error.message : 'Upload failed')
          }
          return { ...current, uploadingFiles, errors }
        })
      } finally {
        pendingByScope.get(targetScopeKey)?.delete(pending)
        const latestAttempts = latestAttemptsByScope.get(targetScopeKey)
        if (!retainFailedAttempt && latestAttempts?.get(file.name) === fileId) {
          latestAttempts.delete(file.name)
          if (latestAttempts.size === 0) latestAttemptsByScope.delete(targetScopeKey)
        }
        if (!previewTransferred) {
          releaseImagePreview(previewUrl)
        }
      }
    }
  }

  const removeSourceFileForScope = async (targetScopeKey: string, file: File) => {
    const pendingFiles = pendingByScope.get(targetScopeKey)
    for (const pending of pendingFiles ?? []) {
      if (pending.file !== file || pending.submitted) continue
      pending.reject(new Error('Attachment selection was cancelled'))
      pendingFiles?.delete(pending)
    }
    const sources = sourcesByScope.get(targetScopeKey)
    const removed = [...(sources?.entries() ?? [])].filter(([, source]) => source.file === file)
    if (!removed.length) return
    const uploads = new Set(removed.map(([id]) => id))
    const attachments = new Set<number>()
    const errorNames = new Set<string>()
    const attempts = latestAttemptsByScope.get(targetScopeKey)
    for (const [id, source] of removed) {
      source.cancelled = true
      source.file = undefined
      if (source.attachment) attachments.add(source.attachment.id)
      if (attempts?.get(source.filename) === id) {
        errorNames.add(source.filename)
        attempts.delete(source.filename)
      }
    }
    updateScopeState(targetScopeKey, current => ({
      ...current,
      attachments: current.attachments.filter(item => !attachments.has(item.id)),
      uploadingFiles: new Map([...current.uploadingFiles].filter(([id]) => !uploads.has(id))),
      errors: new Map([...current.errors].filter(([filename]) => !errorNames.has(filename))),
    }))
    try {
      await Promise.all(removed.map(([, source]) => discardSourceAttachment(source)))
      config.onAction?.('delete')
    } catch (cause) {
      config.onAction?.('failed')
      throw cause
    }
  }

  const dismissAttachmentErrorForScope = (targetScopeKey: string, filename: string) => {
    updateScopeState(targetScopeKey, current => {
      if (!current.errors.has(filename)) return current
      const errors = new Map(current.errors)
      errors.delete(filename)
      return { ...current, errors }
    })
  }

  const replaceImageAttachmentForScope = async (
    scopeKey: string,
    attachmentId: number,
    file: File,
    comments: NonNullable<Attachment['image_markup_comments']>,
    signal: AbortSignal
  ) => {
    const original = getScopeSnapshot(scopeKey).attachments.find(item => item.id === attachmentId)
    if (!original || signal.aborted) return null

    const upload = config.uploadAttachment
    const remove = config.deleteAttachment
    const uploaded = await upload(file)
    if (
      signal.aborted ||
      uploaded.status === 'failed' ||
      !getScopeSnapshot(scopeKey).attachments.some(item => item === original)
    ) {
      releaseAttachmentPreview(uploaded)
      if (uploaded.id > 0) await remove(uploaded.id)
      return null
    }

    const replacement = {
      ...uploaded,
      ui_group_id: original.ui_group_id,
      ui_group_role: original.ui_group_role,
      ui_kind: original.ui_kind,
      image_markup_comments: comments,
    }
    updateScopeState(scopeKey, current => ({
      ...current,
      attachments: current.attachments.map(item => (item === original ? replacement : item)),
    }))
    releaseAttachmentPreview(original)
    const sources = attachmentSourcesByScope.get(scopeKey)
    const source = sources?.get(original.id)
    if (source) {
      source.attachment = replacement
      sources?.delete(original.id)
      sources?.set(replacement.id, source)
    }
    if (original.id > 0 && original.id !== uploaded.id) {
      void remove(original.id).catch(() => config.onAction?.('failed'))
    }
    return replacement
  }

  const removeAttachmentForScope = async (targetScopeKey: string, attachmentId: number) => {
    const scopedState = stateByScope[targetScopeKey] ?? emptyAttachmentState()
    const attachment = scopedState.attachments.find(item => item.id === attachmentId)
    const attachmentsToRemove = attachment?.ui_group_id
      ? scopedState.attachments.filter(item => item.ui_group_id === attachment.ui_group_id)
      : attachment
        ? [attachment]
        : []
    attachmentsToRemove.forEach(releaseAttachmentPreview)
    const idsToRemove = new Set(attachmentsToRemove.map(item => item.id))
    updateScopeState(targetScopeKey, current => ({
      ...current,
      attachments: current.attachments.filter(attachment => !idsToRemove.has(attachment.id)),
    }))
    try {
      await Promise.all(
        attachmentsToRemove.filter(item => item.id > 0).map(item => deleteAttachment(item.id))
      )
      config.onAction?.('delete')
    } catch (error) {
      config.onAction?.('failed')
      throw error
    }
  }

  const resetAttachmentsForScope = (targetScopeKey: string) => {
    for (const pending of pendingByScope.get(targetScopeKey) ?? []) {
      if (pending.captured) pending.submitted = true
    }
    pendingByScope.delete(targetScopeKey)
    scopeEpochs.set(targetScopeKey, (scopeEpochs.get(targetScopeKey) ?? 0) + 1)
    latestAttemptsByScope.delete(targetScopeKey)
    for (const source of sourcesByScope.get(targetScopeKey)?.values() ?? []) {
      source.cancelled = true
      source.file = undefined
    }
    sourcesByScope.delete(targetScopeKey)
    attachmentSourcesByScope.delete(targetScopeKey)
    const scopedState = stateByScope[targetScopeKey] ?? emptyAttachmentState()
    scopedState.attachments.forEach(releaseAttachmentPreview)
    updateScopeState(targetScopeKey, current => ({
      ...current,
      attachments: [],
      uploadingFiles: new Map(),
      errors: new Map(),
    }))
  }

  function createScopeActions(scopeKey: string) {
    const addExistingAttachment = (attachment: Attachment) =>
      addExistingAttachmentForScope(scopeKey, attachment)
    const addExistingSourceAttachment = (attachment: Attachment, file: File) =>
      addExistingAttachmentForScope(scopeKey, attachment, file)
    const handleFileSelect = (files: File | File[]) => handleFileSelectForScope(scopeKey, files)
    const handleTrackedFileSelect = (files: File | File[]) =>
      handleFileSelectForScope(scopeKey, files, true)
    const removeSourceFile = (file: File) => removeSourceFileForScope(scopeKey, file)
    const getSelectedAttachments = (files: readonly File[]) => {
      const selected = new Set(files)
      const sources = attachmentSourcesByScope.get(scopeKey)
      return getScopeSnapshot(scopeKey).attachments.filter(attachment => {
        const source = sources?.get(attachment.id)
        return (
          !source || (!source.cancelled && source.file !== undefined && selected.has(source.file))
        )
      })
    }
    const getSourceFile = (attachmentId: number) =>
      attachmentSourcesByScope.get(scopeKey)?.get(attachmentId)?.file
    const removeAttachment = (attachmentId: number) =>
      removeAttachmentForScope(scopeKey, attachmentId)
    const resetAttachments = () => resetAttachmentsForScope(scopeKey)
    const dismissAttachmentError = (filename: string) =>
      dismissAttachmentErrorForScope(scopeKey, filename)

    return {
      captureAttachmentsForScope,
      captureAttachments: () => captureAttachmentsForScope(scopeKey),
      getSnapshot: () => getScopeSnapshot(scopeKey),
      subscribe: (listener: () => void, releaseOnDetach = false) =>
        subscribeScope(scopeKey, listener, releaseOnDetach),
      release: () => releaseScope(scopeKey),
      dismissAttachmentError,
      dismissAttachmentErrorForScope,
      handleFileSelect,
      handleTrackedFileSelect,
      removeSourceFile,
      getSelectedAttachments,
      getSourceFile,
      handleFileSelectForScope,
      addExistingAttachment,
      addExistingSourceAttachment,
      addExistingAttachmentForScope,
      replaceImageAttachmentForScope,
      removeAttachment,
      removeAttachmentForScope,
      resetAttachments,
      resetAttachmentsForScope,
    }
  }
  const scopedActions = new Map<string, ReturnType<typeof createScopeActions>>()
  function forScope(scopeKey: string) {
    let actions = scopedActions.get(scopeKey)
    if (!actions) {
      actions = createScopeActions(scopeKey)
      scopedActions.set(scopeKey, actions)
    }
    return actions
  }
  for (const { attachment, file } of initial?.attachments ?? []) {
    addExistingAttachmentForScope(initialScope, attachment, file)
  }
  const start = () => {
    if (started) return
    started = true
    const files = queuedFiles
    queuedFiles = []
    if (files.length) void handleFileSelectForScope(initialScope, files, true)
  }
  const releaseScope = (scope: string) => {
    if (scope === initialScope) queuedFiles = []
    resetAttachmentsForScope(scope)
  }
  function subscribeScope(scope: string, listener: () => void, releaseOnDetach = false) {
    scopeObservers.set(scope, (scopeObservers.get(scope) ?? 0) + 1)
    listeners.add(listener)
    return () => {
      listeners.delete(listener)
      scopeObservers.set(scope, (scopeObservers.get(scope) ?? 1) - 1)
      if (releaseOnDetach) pendingReleases.add(scope)
      // Let a same-commit subscription replay reacquire its actual attachment scope.
      queueMicrotask(() => {
        if ((scopeObservers.get(scope) ?? 0) > 0 || !pendingReleases.delete(scope)) return
        scopeObservers.delete(scope)
        releaseScope(scope)
      })
    }
  }
  return {
    captureAttachmentsForScope,
    getSnapshot: () => stateByScope,
    getScopeSnapshot,
    forScope,
    start,
    releaseScope,
    subscribe(listener: () => void, nextOptions?: ComposerAttachmentsOptions, scope?: string) {
      if (nextOptions) config = nextOptions
      if (scope !== undefined) return subscribeScope(scope, listener)
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
  }
}
export type ComposerAttachmentsModel = ReturnType<typeof createComposerAttachmentsModel>
