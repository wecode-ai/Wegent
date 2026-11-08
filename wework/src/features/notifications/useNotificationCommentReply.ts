import { useEffect, useRef } from 'react'
import { useNotificationEntity } from './NotificationEntityContext'
import { useRuntimeInteractions } from './RuntimeInteractionsContext'
import { canQuickReply, canReplyToInteraction } from './runtimeInteractions'
import type { RuntimePaneQueuedMessage } from '@wegent/chat-core/conversation-queue'
import type { TaskCardDispatchResult } from '@wegent/collaboration/execution/taskCardReply'

/** Bind an original Issue reply composer to its notification's existing coordination. */
export function useNotificationCommentReply<T extends { root: { messageId: string } }>({
  projectId,
  issueId,
  store,
  cards,
  target,
  selectTarget,
}: {
  projectId: string
  issueId: string
  store?: 'local' | 'backend'
  cards: T[]
  target: T | null
  selectTarget: (card: T) => void
}) {
  const entity = useNotificationEntity()
  const interactions = useRuntimeInteractions()
  const selected = useRef<string | null>(null)
  const item = interactions?.pending.find(item => item.id === entity?.id)
  const eligible = Boolean(item && (item.cached || canQuickReply(item.payload)))
  const scope =
    entity && entity.projectId === projectId && entity.issueId === issueId && entity.store === store
      ? entity
      : null
  useEffect(() => {
    if (!scope || !eligible || selected.current === scope.id) return
    const card = cards.find(card => card.root.messageId === scope.rootCommentId)
    if (!card) return
    selected.current = scope.id
    selectTarget(card)
  }, [cards, scope, selectTarget, eligible])
  if (!scope || !eligible || !interactions) return null
  const ownsRequest = Boolean(
    item?.project &&
    item.project.projectId === scope.projectId &&
    item.project.issueId === scope.issueId &&
    item.project.store === scope.store &&
    item.project.rootCommentId === scope.rootCommentId
  )
  return {
    id: scope.id,
    rootId: scope.rootCommentId,
    composing: target?.root.messageId === scope.rootCommentId,
    draft: interactions.drafts[scope.id] ?? '',
    error: interactions.errors[scope.id],
    disabled: !item || !ownsRequest || !canReplyToInteraction(item),
    busy: interactions.busy.has(scope.id),
    setDraft: (text: string) => interactions.setDraft(scope.id, text),
  }
}

/** A queued answer keeps its exact request identity even when the visible entity changes. */
export function useNotificationCommentDispatch({
  projectId,
  issueId,
  store,
}: {
  projectId: string
  issueId: string
  store: 'local' | 'backend'
}) {
  const interactions = useRuntimeInteractions()
  return async (
    rootId: string,
    reply: RuntimePaneQueuedMessage,
    send: (humanRequestId?: string) => Promise<TaskCardDispatchResult>
  ): Promise<TaskCardDispatchResult> => {
    if (!reply.interactionId) return send()
    const item = interactions?.pending.find(item => item.id === reply.interactionId)
    const binding = item?.project
    if (
      !item ||
      !interactions ||
      !binding ||
      !canReplyToInteraction(item) ||
      binding.projectId !== projectId ||
      binding.issueId !== issueId ||
      binding.store !== store ||
      binding.rootCommentId !== rootId
    )
      return { ok: false, persisted: false }
    let result: TaskCardDispatchResult | undefined
    await interactions.respond(item, reply.content, {
      send: async () => {
        result = await send(item.sharedRequest?.id)
        return result.ok
      },
    })
    return result ?? { ok: false, persisted: false }
  }
}
