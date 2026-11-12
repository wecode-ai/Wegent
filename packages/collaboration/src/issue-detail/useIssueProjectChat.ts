import { useEffect, useMemo, useState } from 'react'
import type {
  ProjectChatClient,
  ProjectChatMention,
  ProjectChatMessage,
  ProjectChatSubscription,
} from '@wegent/chat-core'
import { generateMessageId } from '@wegent/chat-core'

function runtimeSequence(message: ProjectChatMessage): bigint {
  const sequence = message.metadata.runtime_event_sequence
  return typeof sequence === 'string' && /^[1-9]\d{0,19}$/.test(sequence)
    ? BigInt(sequence)
    : BigInt(0)
}

function acceptsMessage(
  previous: ProjectChatMessage,
  incoming: ProjectChatMessage,
  isDelta = false
): boolean {
  const previousSequence = runtimeSequence(previous)
  const incomingSequence = runtimeSequence(incoming)
  if (previousSequence !== incomingSequence) return previousSequence < incomingSequence
  return (!isDelta || incomingSequence === BigInt(0)) && previous.updatedAt <= incoming.updatedAt
}

export function mergeIssueChatMessages(
  current: ProjectChatMessage[],
  incoming: ProjectChatMessage[]
) {
  const byId = new Map(current.map(message => [message.messageId, message]))
  for (const message of incoming) {
    const previous = byId.get(message.messageId)
    // Runtime sequence distinguishes updates within the same SQL timestamp.
    if (!previous || acceptsMessage(previous, message)) byId.set(message.messageId, message)
  }
  return [...byId.values()].sort((a, b) => a.sequenceNumber - b.sequenceNumber)
}

export function useIssueProjectChat(
  client: ProjectChatClient | undefined,
  projectId: string,
  issueId: string,
  revision: number | string = 0,
  focusMessageId?: string,
  historyPage?: { beforeSequence?: number; afterSequence?: number },
  containerKind?: 'project' | 'chat_group'
) {
  const beforeSequence = focusMessageId ? undefined : historyPage?.beforeSequence
  const afterSequence = focusMessageId ? undefined : historyPage?.afterSequence
  const historyView = Boolean(focusMessageId || beforeSequence || afterSequence)
  const historyKey =
    (focusMessageId ? `focus:${focusMessageId}:${revision}` : undefined) ??
    (beforeSequence
      ? `before:${beforeSequence}`
      : afterSequence
        ? `after:${afterSequence}`
        : undefined)
  // A revision refreshes the stream without changing its owner or mounted drafts.
  const owner = useMemo(
    () => ({ client, projectId, issueId, containerKind }),
    [client, projectId, issueId, containerKind]
  )
  const empty = useMemo(
    () => ({
      owner,
      messages: [] as ProjectChatMessage[],
      loading: Boolean(client),
      currentUserId: undefined as string | undefined,
      loadedHistoryKey: undefined as string | undefined,
      history: undefined as ProjectChatSubscription['history'],
      error: null as string | null,
    }),
    [owner, client]
  )
  const [snapshot, setSnapshot] = useState(empty)
  const current = snapshot.owner === owner ? snapshot : empty
  useEffect(() => {
    if (!client) return
    let active = true
    let unsubscribe: (() => void) | undefined
    let subscribing = false
    let reconnectDuringAttempt = false
    let pendingMessages: ProjectChatMessage[] = []
    const pendingChunkIds = new Set<string>()
    let observedSequence = 0
    const receive = (message: ProjectChatMessage) => {
      if (!active) return
      observedSequence = Math.max(observedSequence, message.sequenceNumber)
      if (subscribing) pendingMessages = mergeIssueChatMessages(pendingMessages, [message])
      setSnapshot(previous => {
        const state = previous.owner === owner ? previous : empty
        if (historyView)
          return {
            ...state,
            history:
              state.history && message.sequenceNumber > state.history.lastSequence
                ? { ...state.history, hasNewer: true }
                : state.history,
          }
        return {
          ...state,
          messages: mergeIssueChatMessages(state.messages, [message]),
        }
      })
    }
    const subscribe = () => {
      if (!active || subscribing || unsubscribe) return
      subscribing = true
      reconnectDuringAttempt = false
      void client
        .subscribe(
          projectId,
          issueId,
          afterSequence ?? 0,
          receive,
          chunk => {
            if (!active) return
            observedSequence = Math.max(observedSequence, chunk.sequenceNumber)
            if (subscribing) pendingChunkIds.add(chunk.messageId)
            setSnapshot(previous => {
              const state = previous.owner === owner ? previous : empty
              if (historyView) return state
              const message = state.messages.find(message => message.messageId === chunk.messageId)
              if (
                message &&
                !acceptsMessage(message, chunk, chunk.metadata.contentMode !== 'snapshot')
              )
                return previous
              const incoming = {
                ...chunk,
                content:
                  chunk.metadata.contentMode === 'snapshot'
                    ? chunk.content
                    : `${message?.content ?? ''}${chunk.content}`,
              }
              return {
                ...state,
                messages: mergeIssueChatMessages(state.messages, [incoming]),
              }
            })
          },
          ...(historyView || containerKind
            ? ([
                {
                  ...(focusMessageId ? { focusMessageId } : {}),
                  ...(beforeSequence ? { beforeSequence } : {}),
                  ...(historyView ? { historyWindow: true } : {}),
                  ...(containerKind ? { containerKind } : {}),
                },
              ] as const)
            : ([] as const))
        )
        .then(subscription => {
          if (!active) {
            subscription.unsubscribe()
            return
          }
          unsubscribe = subscription.unsubscribe
          setSnapshot(previous => {
            const state = previous.owner === owner ? previous : empty
            return {
              ...state,
              loading: false,
              error: null,
              currentUserId: subscription.snapshot.currentUserId,
              loadedHistoryKey: historyKey,
              history: subscription.snapshot.history
                ? {
                    ...subscription.snapshot.history,
                    hasNewer:
                      subscription.snapshot.history.hasNewer ||
                      observedSequence > subscription.snapshot.history.lastSequence,
                  }
                : undefined,
              messages: historyView
                ? subscription.snapshot.messages
                : mergeIssueChatMessages(
                    state.loadedHistoryKey === historyKey ? state.messages : [],
                    mergeIssueChatMessages(
                      subscription.snapshot.messages,
                      mergeIssueChatMessages(
                        pendingMessages,
                        state.messages.filter(message => pendingChunkIds.has(message.messageId))
                      )
                    )
                  ),
            }
          })
        })
        .catch(cause => {
          if (active)
            setSnapshot(previous => ({
              ...(previous.owner === owner ? previous : empty),
              loading: false,
              loadedHistoryKey: historyKey,
              error: cause instanceof Error ? cause.message : String(cause),
            }))
        })
        .finally(() => {
          subscribing = false
          if (reconnectDuringAttempt && !unsubscribe) subscribe()
        })
    }
    const stopReconnect = client.onReconnect?.(() => {
      if (subscribing) reconnectDuringAttempt = true
      else subscribe()
    })
    subscribe()
    return () => {
      active = false
      stopReconnect?.()
      unsubscribe?.()
    }
  }, [
    client,
    projectId,
    issueId,
    revision,
    owner,
    empty,
    focusMessageId,
    beforeSequence,
    afterSequence,
    historyView,
    historyKey,
    containerKind,
  ])
  const merge = (incoming: ProjectChatMessage[]) =>
    setSnapshot(previous =>
      previous.owner === owner
        ? {
            ...previous,
            messages: mergeIssueChatMessages(previous.messages, incoming),
          }
        : previous
    )
  const messages = useMemo(
    () => current.messages.filter(message => (message.taskId ?? '') === issueId),
    [current.messages, issueId]
  )
  return {
    ...current,
    loading: current.loading || current.loadedHistoryKey !== historyKey,
    historyView,
    messages,
    merge,
    async send(
      text: string,
      replyToMessageId?: string,
      mentions?: ProjectChatMention[]
    ): Promise<ProjectChatMessage> {
      if (!client) throw new Error('Project chat is unavailable')
      const message = await client.send({
        ...(containerKind ? { containerKind } : {}),
        projectId,
        taskId: issueId,
        clientMessageId: generateMessageId('user'),
        text,
        replyToMessageId,
        ...(mentions && mentions.length ? { mentions } : {}),
      })
      merge([message])
      return message
    },
  }
}
