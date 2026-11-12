import type { ProjectChatClient } from '@wegent/chat-core'

export async function readThreadChatSnapshot(
  chat: ProjectChatClient,
  groupId: string,
  threadId: string,
  unavailable: string,
  isCurrent: () => boolean,
  focusMessageId?: string
) {
  const subscription = await chat.subscribe(groupId, threadId, 0, () => {}, undefined, {
    containerKind: 'chat_group',
    ...(focusMessageId ? { focusMessageId, historyWindow: true } : {}),
  })
  try {
    if (!isCurrent()) throw new Error(unavailable)
    return subscription.snapshot.messages
  } finally {
    subscription.unsubscribe()
  }
}
