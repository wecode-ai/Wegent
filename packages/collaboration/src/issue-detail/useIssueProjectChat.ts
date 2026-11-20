import { useCallback, useMemo, useSyncExternalStore } from 'react'
import type { ProjectChatClient, ProjectChatMention, ProjectChatMessage } from '@wegent/chat-core'
import { generateMessageId } from '@wegent/chat-core'
import { createIssueProjectChatSource } from './issueProjectChatSource'
export { mergeIssueChatMessages } from './issueProjectChatSource'

/** The caller supplies its source's structured access-invalidation policy. */
export function useIssueProjectChat(
  client: ProjectChatClient | undefined,
  projectId: string,
  issueId: string,
  revision = 0,
  invalidatesSnapshot?: (cause: unknown) => boolean
) {
  const source = useMemo(
    () => createIssueProjectChatSource(client, projectId, issueId),
    [client, projectId, issueId]
  )
  const subscribe = useCallback(
    (listener: () => void) => source.observeStatus(listener, revision, invalidatesSnapshot),
    [source, revision, invalidatesSnapshot]
  )
  const feed = useSyncExternalStore(source.subscribe, source.getSnapshot, source.getSnapshot)
  const snapshot = useSyncExternalStore(
    subscribe,
    source.getStatusSnapshot,
    source.getStatusSnapshot
  )
  const messages = useMemo(
    () => feed.messages.filter(message => message.taskId === issueId),
    [feed.messages, issueId]
  )
  return {
    ...snapshot,
    messages,
    merge: source.merge,
    async send(
      text: string,
      replyToMessageId?: string,
      mentions?: ProjectChatMention[]
    ): Promise<ProjectChatMessage> {
      if (!client) throw new Error('Project chat is unavailable')
      const receipt = source.captureSendReceipt()
      const message = await client.send({
        projectId,
        taskId: issueId,
        clientMessageId: generateMessageId('user'),
        text,
        replyToMessageId,
        ...(mentions && mentions.length ? { mentions } : {}),
      })
      source.mergeSendReceipt(receipt, [message])
      return message
    },
  }
}
