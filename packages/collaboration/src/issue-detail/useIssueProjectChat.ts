import { useEffect, useMemo, useState } from 'react'
import type { ProjectChatClient, ProjectChatMention, ProjectChatMessage } from '@wegent/chat-core'
import { generateMessageId } from '@wegent/chat-core'

export function mergeIssueChatMessages(
  current: ProjectChatMessage[],
  incoming: ProjectChatMessage[]
) {
  const byId = new Map(current.map(message => [message.messageId, message]))
  for (const message of incoming) {
    const previous = byId.get(message.messageId)
    // A subscription snapshot can arrive after a newer live event.
    if (!previous || previous.updatedAt <= message.updatedAt) byId.set(message.messageId, message)
  }
  return [...byId.values()].sort((a, b) => a.sequenceNumber - b.sequenceNumber)
}

export function useIssueProjectChat(
  client: ProjectChatClient | undefined,
  projectId: string,
  issueId: string,
  revision = 0
) {
  const owner = useMemo(
    () => ({ client, projectId, issueId, revision }),
    [client, projectId, issueId, revision]
  )
  const empty = useMemo(
    () => ({
      owner,
      messages: [] as ProjectChatMessage[],
      loading: Boolean(client),
      currentUserId: undefined as string | undefined,
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
    const receive = (message: ProjectChatMessage) => {
      if (!active) return
      setSnapshot(previous => {
        const state = previous.owner === owner ? previous : empty
        return {
          ...state,
          messages: mergeIssueChatMessages(state.messages, [message]),
        }
      })
    }
    void client
      .subscribe(projectId, issueId, 0, receive, chunk => {
        if (!active) return
        setSnapshot(previous => {
          const state = previous.owner === owner ? previous : empty
          const message = state.messages.find(message => message.messageId === chunk.messageId)
          if (message && message.updatedAt > chunk.updatedAt) return previous
          return {
            ...state,
            messages: mergeIssueChatMessages(state.messages, [
              {
                ...chunk,
                content:
                  chunk.metadata.contentMode === 'snapshot'
                    ? chunk.content
                    : `${message?.content ?? ''}${chunk.content}`,
              },
            ]),
          }
        })
      })
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
            currentUserId: subscription.snapshot.currentUserId,
            messages: mergeIssueChatMessages(state.messages, subscription.snapshot.messages),
          }
        })
      })
      .catch(cause => {
        if (active)
          setSnapshot(previous => ({
            ...(previous.owner === owner ? previous : empty),
            loading: false,
            error: cause instanceof Error ? cause.message : String(cause),
          }))
      })
    return () => {
      active = false
      unsubscribe?.()
    }
  }, [client, projectId, issueId, owner, empty])
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
    () => current.messages.filter(message => message.taskId === issueId),
    [current.messages, issueId]
  )
  return {
    ...current,
    messages,
    merge,
    async send(
      text: string,
      replyToMessageId?: string,
      mentions?: ProjectChatMention[]
    ): Promise<ProjectChatMessage> {
      if (!client) throw new Error('Project chat is unavailable')
      const message = await client.send({
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
