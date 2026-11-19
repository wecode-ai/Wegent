import { useCallback, useState, useSyncExternalStore } from 'react'
import type { Attachment } from '@wegent/chat-core/runtime'
import {
  createComposerAttachmentsModel,
  type ComposerAttachmentsModel,
  type ComposerAttachmentsOptions,
} from './composerAttachmentsModel'
export { createComposerAttachmentsModel } from './composerAttachmentsModel'
export type {
  ComposerAttachmentsModel,
  ComposerAttachmentsOptions,
  ComposerAttachmentsInitialState,
  MultiAttachmentUploadState,
} from './composerAttachmentsModel'

export function useComposerAttachments(
  options: ComposerAttachmentsOptions & { initialAttachments?: Attachment[] },
  providedModel?: ComposerAttachmentsModel
) {
  const [ownedModel] = useState(
    () =>
      providedModel ??
      createComposerAttachmentsModel(
        options,
        options.initialAttachments === undefined
          ? undefined
          : {
              ...options.initialState,
              scopeKey: options.scopeKey ?? options.initialState?.scopeKey,
              attachments: options.initialAttachments.map(attachment => ({ attachment })),
            }
      )
  )
  const model = providedModel ?? ownedModel
  const { uploadAttachment, deleteAttachment, onAction } = options
  const scopeKey = options.scopeKey ?? 'default'
  const subscribe = useCallback(
    (listener: () => void) =>
      model.subscribe(listener, { uploadAttachment, deleteAttachment, onAction }, scopeKey),
    [model, uploadAttachment, deleteAttachment, onAction, scopeKey]
  )
  const stateByScope = useSyncExternalStore(subscribe, model.getSnapshot, model.getSnapshot)
  const state = model.getScopeSnapshot(scopeKey)
  const actions = model.forScope(scopeKey)
  const isUploading = state.uploadingFiles.size > 0
  const isAttachmentReadyToSend =
    !isUploading && state.attachments.every(attachment => attachment.status === 'ready')
  return {
    ...actions,
    source: actions,
    model,
    state,
    stateByScope,
    attachments: state.attachments,
    uploadingFiles: state.uploadingFiles,
    errors: state.errors,
    isUploading,
    isAttachmentReadyToSend,
  }
}
