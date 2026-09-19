import { createContext, useContext } from 'react'
import type { ModelOptions, UnifiedModel } from '@wegent/chat-core/models'
import type { SharedWorkspaceRuntimeApi } from '../ports/SharedWorkspaceApi'
import type { useComposerAttachments } from '../composer/useComposerAttachments'
import type { TaskReplyQueueStore } from '../execution/taskReplyQueue'
import { RuntimeConversationQueue } from '../execution/runtimeConversationQueue'
import type { PluginTrialGuide } from '@wegent/chat-core/composer-plugin-trial'

export interface TaskDraft {
  busy: boolean
  error: string | null
  text: string
  pluginTrial: PluginTrialGuide | null
  selection: { model: UnifiedModel | null; options: ModelOptions } | null
}
export const emptyDraft: TaskDraft = {
  text: '',
  selection: null,
  busy: false,
  error: null,
  pluginTrial: null,
}
export const BrowserTaskDraftContext = createContext<{
  runtime: SharedWorkspaceRuntimeApi
  replyQueue: TaskReplyQueueStore
  conversationQueues: Map<string, RuntimeConversationQueue<string>>
  operations: ReturnType<typeof createDraftOperations>
  drafts: Record<string, TaskDraft>
  update(scope: string, patch: Partial<TaskDraft>): void
  attachments: ReturnType<typeof useComposerAttachments>
} | null>(null)

export function createDraftOperations() {
  const pending = new Set<string>()
  return {
    begin(scope: string) {
      if (pending.has(scope)) return false
      pending.add(scope)
      return true
    },
    end(scope: string) {
      pending.delete(scope)
    },
  }
}

export function useBrowserTaskDraft(scope: string) {
  const context = useContext(BrowserTaskDraftContext)
  if (!context) throw new Error('BrowserTaskDrafts is required')
  const draft = context.drafts[scope] ?? emptyDraft
  const attachments = context.attachments.stateByScope[scope]
  const files = attachments?.attachments ?? []
  const pending = attachments?.uploadingFiles ?? new Map()
  return {
    busy: draft.busy,
    error: draft.error,
    setError: (error: string | null) => context.update(scope, { error }),
    beginOperation() {
      if (!context.operations.begin(scope)) return false
      context.update(scope, { busy: true, error: null })
      return true
    },
    endOperation() {
      context.operations.end(scope)
      context.update(scope, { busy: false })
    },
    draft: draft.text,
    setDraft: (text: string) =>
      context.update(scope, { text, ...(!text.trim() ? { pluginTrial: null } : {}) }),
    pluginTrial: draft.pluginTrial,
    setPluginTrial: (pluginTrial: PluginTrialGuide | null) =>
      context.update(scope, { pluginTrial }),
    selection: draft.selection,
    setSelection: (selection: TaskDraft['selection']) => context.update(scope, { selection }),
    attachments: {
      attachments: files,
      uploadingFiles: pending,
      errors: attachments?.errors ?? new Map(),
      isAttachmentReadyToSend: pending.size === 0 && files.every(file => file.status === 'ready'),
      handleFileSelect: (files: File | File[]) =>
        context.attachments.handleFileSelectForScope(scope, files),
      removeAttachment: (id: number) => context.attachments.removeAttachmentForScope(scope, id),
      resetAttachments: () => context.attachments.resetAttachmentsForScope(scope),
      addExistingAttachment: (
        attachment: Parameters<typeof context.attachments.addExistingAttachment>[0]
      ) => context.attachments.addExistingAttachmentForScope(scope, attachment),
    },
  }
}

export function useBrowserConversationQueue(scope: string) {
  const context = useContext(BrowserTaskDraftContext)
  if (!context) throw new Error('BrowserTaskDrafts is required')
  let queue = context.conversationQueues.get(scope)
  if (!queue) {
    queue = new RuntimeConversationQueue<string>()
    context.conversationQueues.set(scope, queue)
  }
  return queue
}

export function useBrowserReplyQueueStore() {
  const context = useContext(BrowserTaskDraftContext)
  if (!context) throw new Error('BrowserTaskDrafts is required')
  return context.replyQueue
}
