import { useCallback, useSyncExternalStore } from 'react'
import type { Attachment } from '@wegent/chat-core/runtime'
import type { ProjectChatMention } from '@wegent/chat-core'
import { persistAttachmentReferences } from '../composer/attachmentFiles'
import type { TaskReplyQueueStore, TaskReplyQueueSchedule } from './taskReplyQueue'

/** One scheduler for the PC and Web comment cards. */
export function useTaskReplyQueue({
  store,
  scope,
  cards,
  enabled,
  busy,
  dispatch,
  sendFailedText,
}: TaskReplyQueueSchedule & { store: TaskReplyQueueStore }) {
  const version = store.getSnapshot()
  const subscribe = useCallback(
    (listener: () => void) =>
      store.observeSchedule(
        listener,
        { scope, cards, enabled, busy, dispatch, sendFailedText },
        version
      ),
    [store, scope, cards, enabled, busy, dispatch, sendFailedText, version]
  )
  // Message/error projections follow real queue revisions; dispatch waits for committed inputs.
  useSyncExternalStore(subscribe, store.getSnapshot, store.getSnapshot)
  const cardScope = (rootId: string) => `${scope}:${rootId}`
  return {
    messages: (rootId: string) => store.get(cardScope(rootId)),
    error: (rootId: string) => store.error(cardScope(rootId)),
    setError: (rootId: string, error: string | null) => store.setError(cardScope(rootId), error),
    cancel(rootId: string, id: string) {
      store.update(cardScope(rootId), current =>
        current.filter(message => message.id !== id || message.status === 'sending')
      )
    },
    enqueue(
      rootId: string,
      content: string,
      attachments: Attachment[],
      mentions?: ProjectChatMention[],
      interactionId?: string
    ) {
      store.update(cardScope(rootId), current => [
        ...current,
        {
          id: `queued-task-card-${crypto.randomUUID()}`,
          content,
          attachments: persistAttachmentReferences(attachments),
          mentions,
          ...(interactionId ? { interactionId } : {}),
          status: 'queued',
          createdAt: new Date().toISOString(),
        },
      ])
      return { ok: true }
    },
  }
}
