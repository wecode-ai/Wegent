import { BrowserTaskDraftContext } from './browserTaskDraftContext'
import { runtimeContinuationRequest } from '../execution/runtimeContinuationRequest'
import { useContext, useEffect, useMemo, useState } from 'react'
import { useRuntimeConversationSession } from '../conversation/useRuntimeConversationSession'
import { useBrowserConversationActions } from './useBrowserConversationActions'
import type { Attachment, RuntimeTaskAddress } from '@wegent/chat-core/runtime'
import type { RuntimeWorkListResponse } from '@wegent/chat-core/runtime-task-api-types'
import { findRuntimeTask, findRuntimeTaskWorkspace } from '@wegent/chat-core/runtime-task-lookup'
import { splitAbsoluteWorkspaceFilePath } from '@wegent/chat-core/workspace-file-contract'
import type { SharedWorkspaceRuntimeApi } from '../ports/SharedWorkspaceApi'
import type { CollaborationTranslate } from '../i18n'
import { useDocumentTheme } from '../theme'
import { browserMarkdownServices } from '../markdown'
import type { AttachmentImageServices } from './AttachmentImageView'
import {
  loadRuntimeFileChangesDiff,
  revertRuntimeFileChanges,
} from '@wegent/chat-core/runtime-file-changes'
import { findFileChangesBySubtaskId } from '@wegent/chat-core/runtime-stream-handlers'
import type { TurnFileChangesSummary } from '@wegent/chat-core/runtime'

/** Host effects for the shared execution and side-conversation presentations. */
export function useBrowserRuntimeConversation(
  runtime: SharedWorkspaceRuntimeApi,
  address: RuntimeTaskAddress,
  translate: CollaborationTranslate,
  projectId?: string
) {
  const theme = useDocumentTheme()
  const { session, state } = useRuntimeConversationSession(runtime, address)
  const fileActions = useMemo(
    () => ({
      onLoadFileChangesDiff(subtaskId: string, override?: TurnFileChangesSummary) {
        return loadRuntimeFileChangesDiff(
          runtime,
          override ?? findFileChangesBySubtaskId(session.getSnapshot().messages, subtaskId)
        )
      },
      async onRevertFileChanges(subtaskId: string, override?: TurnFileChangesSummary) {
        const updated = await revertRuntimeFileChanges(
          {
            revertRuntimeFileChanges: runtime.work.revertRuntimeFileChanges,
            errorFileChanges: runtime.fileChangesFromError,
          },
          address,
          override ?? findFileChangesBySubtaskId(session.getSnapshot().messages, subtaskId)
        )
        session.applyFileChanges(subtaskId, updated)
        return updated
      },
    }),
    [runtime, address, session]
  )
  const [metadataRevision, setMetadataRevision] = useState(0)
  const [metadata, setMetadata] = useState<{
    owner: SharedWorkspaceRuntimeApi
    address: RuntimeTaskAddress
    work: RuntimeWorkListResponse | null
    error: string | null
  } | null>(null)
  useEffect(() => {
    const controller = new AbortController()
    void runtime.work
      .listRuntimeWork({ signal: controller.signal })
      .then(work => {
        if (!controller.signal.aborted) setMetadata({ owner: runtime, address, work, error: null })
      })
      .catch(cause => {
        if (!controller.signal.aborted)
          setMetadata({
            owner: runtime,
            address,
            work: null,
            error: cause instanceof Error ? cause.message : String(cause),
          })
      })
    return () => controller.abort()
  }, [runtime, address, metadataRevision])
  const current = metadata?.owner === runtime && metadata.address === address ? metadata : null
  const task = findRuntimeTask(current?.work, address)
  const workspace = findRuntimeTaskWorkspace(current?.work, address)
  const drafts = useContext(BrowserTaskDraftContext)
  const draft = drafts?.drafts[`${address.deviceId}:${address.taskId}`]
  const actions = useBrowserConversationActions(
    runtime,
    address,
    session,
    translate,
    task
      ? () => runtimeContinuationRequest(address, task, draft?.selection ?? null, projectId)
      : undefined
  )
  const readTaskFile = useMemo(
    () => (path: string, mimeType?: string) => {
      const { parentPath, fileName } = splitAbsoluteWorkspaceFilePath(path)
      return runtime.readWorkspaceFile(
        { device_id: address.deviceId, workspace_path: parentPath, path: fileName },
        mimeType
      )
    },
    [runtime, address.deviceId]
  )
  const images = useMemo<AttachmentImageServices<Attachment>>(
    () => ({
      identity: attachment =>
        `${attachment.id}:${attachment.local_path ?? ''}:${JSON.stringify(attachment.workspace_file ?? null)}`,
      async load(attachment) {
        if (attachment.local_preview_url)
          return { url: attachment.local_preview_url, release: null }
        const blob = attachment.workspace_file
          ? await runtime.readWorkspaceFile(attachment.workspace_file, attachment.mime_type)
          : attachment.local_path
            ? await readTaskFile(attachment.local_path, attachment.mime_type)
            : await runtime.readAttachment(attachment.id)
        if (!blob.type.startsWith('image/')) throw new Error('Attachment preview is not an image')
        const url = URL.createObjectURL(blob)
        return { url, release: () => URL.revokeObjectURL(url) }
      },
      async download(_attachment, url, filename) {
        const anchor = document.createElement('a')
        anchor.href = url
        anchor.download = filename
        anchor.rel = 'noopener'
        document.body.append(anchor)
        anchor.click()
        anchor.remove()
      },
    }),
    [runtime, readTaskFile]
  )
  const userMessageServices = useMemo(() => ({ images }), [images])
  const markdown = useMemo(
    () => ({
      ...browserMarkdownServices,
      theme,
      fetchAttachmentBlob: runtime.readAttachment,
      readLocalFile: readTaskFile,
      translate,
    }),
    [runtime, readTaskFile, theme, translate]
  )
  return {
    state,
    session,
    task,
    workspace,
    markdown,
    metadataError: current?.error,
    actionError: actions.error,
    reload() {
      setMetadataRevision(value => value + 1)
      return session.reload()
    },
    conversation: {
      ...fileActions,
      onRetryFailedMessage: actions.onRetryFailedMessage,
      messages: state.messages,
      loading: state.loading,
      isWaitingForAssistant:
        state.running && (state.messages.at(-1)?.role === 'user' || !state.messages.length),
      hasMoreBefore: state.hasMoreBefore,
      loadingMoreBefore: state.loadingMoreBefore,
      turnNavigation: state.turnNavigation,
      loadedTranscriptRanges: state.loadedTranscriptRanges,
      onLoadMoreBefore: session.loadMoreBefore,
      onLoadTurnNavigationItem: session.loadTurn,
      onLoadTranscriptGap: session.loadGap,
      conversationKey: `${address.deviceId}:${address.taskId}`,
      userMessageServices,
      onRequestUserInputSubmit: actions.onRequestUserInputSubmit,
      onRequestUserInputIgnore: actions.onRequestUserInputIgnore,
      hiddenRequestUserInputIds: actions.hiddenRequestUserInputIds,
    },
  }
}
