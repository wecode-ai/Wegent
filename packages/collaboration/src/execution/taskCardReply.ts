import type { ProjectChatMessage } from '@wegent/chat-core'
import type { RuntimeTaskAddress } from '@wegent/chat-core/runtime'
import type { RuntimePaneQueuedMessage } from '@wegent/chat-core/conversation-queue'
import { localRuntimeAttachments, remoteAttachmentIds } from '@wegent/chat-core/runtime-attachments'
import { createRuntimeUserMessage } from './runtimeUserMessage'
import {
  startTaskAiRun,
  type CommentExecutionTask,
  type StartTaskAiRunInput,
} from './taskAiExecution'

export interface TaskReplyCard {
  root: ProjectChatMessage
  replies: ProjectChatMessage[]
}
export interface TaskCardDispatchResult {
  ok: boolean
  persisted: boolean
  error?: string
}
export function cardSessionAddress(card: TaskReplyCard): RuntimeTaskAddress | null {
  const message = [card.root, ...card.replies]
    .filter(
      message =>
        message.sender.type === 'agent' &&
        message.runtimeAddress?.deviceId &&
        message.runtimeAddress.taskId
    )
    .at(-1)
  return message?.runtimeAddress ?? null
}
export function cardSessionActive(
  card: TaskReplyCard,
  busy: (address: RuntimeTaskAddress) => boolean | undefined
): boolean {
  return [card.root, ...card.replies].some(message => {
    if (message.sender.type !== 'agent') return false
    const running = message.runtimeAddress ? busy(message.runtimeAddress) : undefined
    return running ?? (message.status === 'pending' || message.status === 'streaming')
  })
}
export function isCustomAutomationManager(message: ProjectChatMessage): boolean {
  return (
    message.sender.type === 'agent' &&
    message.metadata.executor_type === 'automation_manager' &&
    message.metadata.manager_type === 'custom'
  )
}

export interface TaskCardReplyInput<Project, Task extends CommentExecutionTask> extends Omit<
  StartTaskAiRunInput<Project, Task>,
  'agent' | 'prompt' | 'trigger' | 'replyTo' | 'threadRootId'
> {
  card: TaskReplyCard
  reply: RuntimePaneQueuedMessage
  agent?: { id: string; name: string; systemPrompt?: string; runtime?: string }
  selfManagedExecution?: boolean
  prepareComment?(
    text: string,
    attachments: NonNullable<RuntimePaneQueuedMessage['attachments']>
  ): Promise<string>
  onPersisted?(message: ProjectChatMessage): void
  sendFailedText: string
}

/** The PC reply flow, shared by native and browser hosts. */
export async function dispatchTaskCardReply<Project, Task extends CommentExecutionTask>(
  input: TaskCardReplyInput<Project, Task>
): Promise<TaskCardDispatchResult> {
  const {
    client,
    project,
    task,
    card,
    reply,
    agent,
    runtime,
    onMessages,
    startFailedText,
    sendFailedText,
  } = input
  const rootId = card.root.messageId
  const attachments = reply.attachments ?? []
  const address = cardSessionAddress(card)
  const customManager = isCustomAutomationManager(card.root)
  let persisted = false
  let executionError: string | null = null
  const onError = (error: string) => {
    executionError = error
    input.onError(error)
  }
  if (!reply.content.trim()) return { ok: false, persisted, error: sendFailedText }
  if (customManager && (!client.continueAutomationManager || !address))
    return { ok: false, persisted, error: startFailedText }
  try {
    const text = input.prepareComment
      ? await input.prepareComment(reply.content, attachments)
      : reply.content
    const message = await client.send({
      projectId: project.id,
      taskId: task.id,
      clientMessageId: reply.id,
      text,
      ...(agent || reply.mentions?.length
        ? {
            mentions: [
              ...(agent && !customManager
                ? [{ type: 'agent' as const, id: agent.id, label: agent.name }]
                : []),
              ...(reply.mentions ?? []).filter(mention => mention.type === 'user'),
            ],
          }
        : {}),
      replyToMessageId: rootId,
      model: null,
    })
    persisted = true
    input.onPersisted?.(message)
    onMessages([message])
    if (customManager && address) {
      let pending: ProjectChatMessage | undefined
      try {
        pending = await client.continueAutomationManager!({
          projectId: project.id,
          taskId: task.id,
          triggerMessageId: message.messageId,
          managerMessageId: rootId,
        })
        onMessages([pending])
        const continued = await runtime.sendRuntimePaneMessage(
          {
            address,
            message: message.content,
            collaborationMode: 'default',
            attachmentIds: remoteAttachmentIds(attachments),
            attachments: localRuntimeAttachments(attachments),
          },
          {
            optimisticUserMessage: createRuntimeUserMessage(message.content, attachments, {
              id: pending.messageId,
            }),
            onError,
          }
        )
        if (!continued) throw new Error(executionError ?? startFailedText)
      } catch (cause) {
        const error = cause instanceof Error ? cause.message : startFailedText
        if (pending) {
          try {
            onMessages([
              await client.failAgentResponse({
                projectId: project.id,
                taskId: task.id,
                messageId: pending.messageId,
                error,
              }),
            ])
          } catch (cleanupError) {
            onError(
              `${error}; ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`
            )
            return { ok: false, persisted, error: executionError ?? error }
          }
        }
        throw cause
      }
    } else if (agent && !input.selfManagedExecution) {
      if (agent.runtime === 'wegent') {
        if (!client.continueWegentTask) throw new Error(startFailedText)
        onMessages([
          await client.continueWegentTask({
            projectId: project.id,
            taskId: task.id,
            triggerMessageId: message.messageId,
            agentId: agent.id,
            attachmentIds: remoteAttachmentIds(attachments),
          }),
        ])
      } else {
        const started = await startTaskAiRun({
          ...input,
          agent,
          prompt: reply.content,
          trigger: message,
          attachments,
          replyTo: address
            ? {
                runtimeDeviceId: address.deviceId,
                runtimeTaskId: address.taskId,
              }
            : null,
          threadRootId: rootId,
          onError,
        })
        if (!started)
          return {
            ok: false,
            persisted,
            error: executionError ?? startFailedText,
          }
      }
    }
    return { ok: true, persisted }
  } catch (cause) {
    const error = cause instanceof Error ? cause.message : sendFailedText
    onError(error)
    return { ok: false, persisted, error }
  }
}
