import {
  dispatchTaskCommentReply,
  cardSessionAddress,
} from '@wegent/collaboration/execution/taskCardReply'
import type { WorkbenchServices } from '@/features/workbench/workbenchServices'
import type { RuntimeInteraction } from './runtimeInteractions'

/** Persist the reply on its owning Issue thread before continuing its execution. */
export async function replyToInteractionProject(
  item: RuntimeInteraction,
  text: string,
  clientMessageId: string,
  services: WorkbenchServices,
  failedText: string
): Promise<void> {
  const binding = item.project
  const client =
    binding?.store === 'local' ? services.localProjectChatClient : services.projectChatClient
  if (!binding?.rootCommentId || !client?.executeTaskComment) throw new Error(failedText)
  const subscription = await client.subscribe(
    binding.projectId,
    binding.issueId,
    0,
    () => undefined
  )
  try {
    const messages = subscription.snapshot.messages
    const root = messages.find(message => message.messageId === binding.rootCommentId)
    if (!root) throw new Error(failedText)
    const card = {
      root,
      replies: messages.filter(message => message.rootMessageId === root.messageId),
    }
    const owner = cardSessionAddress(card)
    if (
      !owner ||
      owner.deviceId !== item.task.address.deviceId ||
      owner.taskId !== item.task.address.taskId
    )
      throw new Error(failedText)
    const result = await dispatchTaskCommentReply({
      client,
      projectId: binding.projectId,
      taskId: binding.issueId,
      rootMessageId: card.root.messageId,
      reply: {
        id: clientMessageId,
        content: text,
        createdAt: new Date().toISOString(),
        status: 'queued',
      },
      onMessages: () => undefined,
      onError: () => undefined,
      sendFailedText: failedText,
    })
    if (!result.ok) throw new Error(result.error || failedText)
  } finally {
    subscription.unsubscribe()
  }
}
