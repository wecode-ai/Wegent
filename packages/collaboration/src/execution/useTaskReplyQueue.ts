import { useEffect, useSyncExternalStore } from 'react'
import type { Attachment } from '@wegent/chat-core/runtime'
import type { RuntimePaneQueuedMessage } from '@wegent/chat-core/conversation-queue'
import type { ProjectChatMention } from '@wegent/chat-core'
import { persistAttachmentReferences } from '../composer/attachmentFiles'
import type { TaskReplyCard, TaskCardDispatchResult } from './taskCardReply'
import type { TaskReplyQueueStore } from './taskReplyQueue'

/** One scheduler for the PC and Web comment cards. */
export function useTaskReplyQueue({
  store,
  scope,
  cards,
  enabled,
  busy,
  dispatch,
  sendFailedText,
}: {
  store: TaskReplyQueueStore
  scope: string
  cards: TaskReplyCard[]
  enabled: boolean
  busy(card: TaskReplyCard): boolean
  dispatch(card: TaskReplyCard, reply: RuntimePaneQueuedMessage): Promise<TaskCardDispatchResult>
  sendFailedText: string
}) {
  const revision = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot)
  const cardScope = (rootId: string) => `${scope}:${rootId}`
  useEffect(() => {
    if (!enabled) return
    const candidate = cards
      .flatMap(card => {
        if (busy(card)) return []
        const reply = store
          .get(`${scope}:${card.root.messageId}`)
          .find(message => message.status === 'queued')
        return reply ? [{ card, reply }] : []
      })
      .sort((a, b) => a.reply.createdAt.localeCompare(b.reply.createdAt))[0]
    if (!candidate) return
    const key = `${scope}:${candidate.card.root.messageId}`
    if (!store.claim(scope, key, candidate.reply.id)) return
    void dispatch(candidate.card, candidate.reply)
      .catch(cause => ({
        ok: false,
        persisted: false,
        error: cause instanceof Error ? cause.message : sendFailedText,
      }))
      .then(result => {
        store.update(key, current =>
          result.ok || result.persisted
            ? current.filter(message => message.id !== candidate.reply.id)
            : current.map(message =>
                message.id === candidate.reply.id
                  ? {
                      ...message,
                      status: 'failed',
                      error: result.error ?? sendFailedText,
                    }
                  : message
              )
        )
        if (!result.ok) store.setError(key, result.error ?? sendFailedText)
      })
      .finally(() => store.release(scope))
  }, [store, scope, cards, enabled, busy, dispatch, revision, sendFailedText])
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
      mentions?: ProjectChatMention[]
    ) {
      store.update(cardScope(rootId), current => [
        ...current,
        {
          id: `queued-task-card-${crypto.randomUUID()}`,
          content,
          attachments: persistAttachmentReferences(attachments),
          mentions,
          status: 'queued',
          createdAt: new Date().toISOString(),
        },
      ])
      return { ok: true }
    },
  }
}
