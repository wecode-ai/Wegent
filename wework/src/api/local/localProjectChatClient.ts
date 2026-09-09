import type {
  ProjectChatClient,
  ProjectChatMessage,
  ProjectChatSubscription,
} from '@/api/backend/projectChatSocket'
import type { User } from '@/types/api'

type LocalChatRequest = <T>(method: string, params?: Record<string, unknown>) => Promise<T>

export interface LocalCommentRecord {
  id: number
  message_id: string
  client_message_id: string | null
  project_id: string
  task_id: string
  sender_type: 'user' | 'agent' | 'system' | string
  sender_id: string
  sender_name: string
  message_type: string
  content: string
  metadata: Record<string, unknown>
  trigger_message_id: string | null
  reply_to_message_id: string | null
  thread_root_message_id: string | null
  status: string
  sequence_number: number
  created_at: string
  updated_at: string
}

const LOCAL_COMMENT_POLL_INTERVAL_MS = 3000

function commentToMessage(record: LocalCommentRecord): ProjectChatMessage {
  const senderType: ProjectChatMessage['sender']['type'] =
    record.sender_type === 'user' || record.sender_type === 'agent' ? record.sender_type : 'system'
  const status: ProjectChatMessage['status'] =
    record.status === 'streaming' ||
    record.status === 'completed' ||
    record.status === 'failed' ||
    record.status === 'cancelled'
      ? record.status
      : 'completed'
  const runtimeAddressRecord = record.metadata?.runtime_address
  const runtimeAddress =
    runtimeAddressRecord &&
    typeof runtimeAddressRecord === 'object' &&
    typeof (runtimeAddressRecord as { deviceId?: unknown }).deviceId === 'string' &&
    typeof (runtimeAddressRecord as { taskId?: unknown }).taskId === 'string'
      ? {
          deviceId: (runtimeAddressRecord as { deviceId: string }).deviceId,
          taskId: (runtimeAddressRecord as { taskId: string }).taskId,
        }
      : undefined
  return {
    sequenceNumber: record.sequence_number,
    messageId: record.message_id,
    clientMessageId: record.client_message_id ?? null,
    projectId: record.project_id,
    taskId: record.task_id,
    sender: { type: senderType, id: record.sender_id, name: record.sender_name },
    type: record.message_type === 'agent_status' ? 'agent_status' : 'text',
    content: record.content,
    metadata: record.metadata ?? {},
    replyToMessageId: record.reply_to_message_id ?? null,
    rootMessageId: record.thread_root_message_id ?? null,
    runtimeAddress,
    status,
    createdAt: record.created_at,
    updatedAt: record.updated_at,
  }
}

export function createLocalProjectChatClient(
  request: LocalChatRequest,
  options: { currentUser: Pick<User, 'id' | 'user_name'> }
): ProjectChatClient {
  const currentUserId = String(options.currentUser.id)
  const currentUserName = options.currentUser.user_name
  const activeUnsubscribers = new Set<() => void>()

  const subscribe: ProjectChatClient['subscribe'] = async (
    projectId,
    taskId,
    _afterSequence,
    onMessage
  ) => {
    let stopped = false
    let inFlight = false
    let latestSequence = 0
    const knownMessages = new Map<string, ProjectChatMessage>()

    const refresh = async () => {
      if (stopped || inFlight) return
      inFlight = true
      try {
        const records = await request<LocalCommentRecord[]>('todos.comment.list', {
          project_id: projectId,
          task_id: taskId,
          after_sequence: 0,
        })
        for (const record of records) {
          const message = commentToMessage(record)
          latestSequence = Math.max(latestSequence, message.sequenceNumber)
          const previous = knownMessages.get(message.messageId)
          knownMessages.set(message.messageId, message)
          if (
            !previous ||
            previous.status !== message.status ||
            previous.content !== message.content ||
            previous.updatedAt !== message.updatedAt
          ) {
            onMessage(message)
          }
        }
      } catch {
        // Transient IPC errors are retried on the next poll.
      } finally {
        inFlight = false
      }
    }

    await refresh()
    const snapshotMessages = [...knownMessages.values()].sort(
      (left, right) => left.sequenceNumber - right.sequenceNumber
    )
    const timer = window.setInterval(() => void refresh(), LOCAL_COMMENT_POLL_INTERVAL_MS)
    const unsubscribe = () => {
      stopped = true
      window.clearInterval(timer)
      activeUnsubscribers.delete(unsubscribe)
    }
    activeUnsubscribers.add(unsubscribe)

    const snapshot: ProjectChatSubscription = {
      messages: snapshotMessages,
      latestSequence,
      currentUserId,
    }
    return { snapshot, unsubscribe }
  }

  const send: ProjectChatClient['send'] = async input => {
    const mentions = input.mentions ?? []
    const created = await request<LocalCommentRecord>('todos.comment.create', {
      comment: {
        project_id: input.projectId,
        task_id: input.taskId ?? '',
        client_message_id: input.clientMessageId,
        sender_type: 'user',
        sender_id: currentUserId,
        sender_name: currentUserName,
        content: input.text,
        metadata: {
          mentions,
          ...(input.localProjectId != null ? { local_project_id: input.localProjectId } : {}),
        },
        reply_to_message_id: input.replyToMessageId ?? null,
      },
    })
    return commentToMessage(created)
  }

  const startAgentResponse: ProjectChatClient['startAgentResponse'] = async input => {
    const record = await request<LocalCommentRecord>('todos.comment.start', {
      comment: {
        project_id: input.projectId,
        task_id: input.taskId ?? '',
        client_message_id: `runtime:${input.runtimeDeviceId}:${input.runtimeTaskId}:${input.triggerMessageId ?? 'initial'}`,
        sender_type: 'agent',
        sender_id: input.agentId ?? input.runtimeTaskId,
        sender_name: 'AI',
        content: '',
        metadata: {
          runtime_address: { deviceId: input.runtimeDeviceId, taskId: input.runtimeTaskId },
          model: input.model ?? null,
          conversation_only: true,
        },
        reply_to_message_id: input.triggerMessageId ?? null,
      },
    })
    return commentToMessage(record)
  }

  const failAgentResponse: ProjectChatClient['failAgentResponse'] = async input => {
    const record = await request<LocalCommentRecord>('todos.comment.fail', {
      project_id: input.projectId,
      task_id: input.taskId ?? '',
      message_id: input.messageId,
      error: input.error ?? '',
    })
    return commentToMessage(record)
  }

  return {
    subscribe,
    send,
    startAgentResponse,
    failAgentResponse,
    dispose: () => {
      for (const unsubscribe of [...activeUnsubscribers]) unsubscribe()
    },
  }
}
