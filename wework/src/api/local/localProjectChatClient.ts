import type {
  ProjectChatClient,
  ProjectChatMessage,
  ProjectChatSubscription,
} from '@/api/backend/projectChatSocket'
import type { User } from '@/types/api'

type LocalChatRequest = <T>(method: string, params?: Record<string, unknown>) => Promise<T>

export interface LocalCommentRecord {
  actor_user_id?: string | null
  actor_display_name?: string | null
  generation_source?: ProjectChatMessage['generationSource']
  publication_source?: ProjectChatMessage['publicationSource']
  confirmation_state?: ProjectChatMessage['confirmationState']
  trace_ref?: string | null
  trace_state?: ProjectChatMessage['traceState']
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
const SHARED_METADATA_KEYS = new Set([
  'mentions',
  'stand_in_reply_to',
  'execution_dispatch',
  'activity_type',
  'dispatch_role',
  'manager_display_name',
  'run_status',
  'summary',
  'evidence_refs',
  'next_action',
  'publish_policy',
  'imported_from',
  'history_import',
])

function commentToMessage(record: LocalCommentRecord, currentUserId: string): ProjectChatMessage {
  const senderType: ProjectChatMessage['sender']['type'] =
    record.sender_type === 'user' || record.sender_type === 'agent' ? record.sender_type : 'system'
  const status: ProjectChatMessage['status'] =
    record.status === 'pending' ||
    record.status === 'streaming' ||
    record.status === 'completed' ||
    record.status === 'failed' ||
    record.status === 'cancelled'
      ? record.status
      : 'completed'
  const owner =
    record.actor_user_id != null
      ? record.actor_user_id === currentUserId
      : record.sender_type === 'user'
        ? record.sender_id === currentUserId
        : false
  const metadata = owner
    ? (record.metadata ?? {})
    : Object.fromEntries(
        Object.entries(record.metadata ?? {}).filter(([key]) => SHARED_METADATA_KEYS.has(key))
      )
  const runtimeAddressRecord = owner ? metadata.runtime_address : undefined
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
    actorUserId: record.actor_user_id,
    actorDisplayName: record.actor_display_name,
    generationSource: record.generation_source,
    publicationSource: record.publication_source,
    confirmationState: record.confirmation_state,
    traceRef: record.trace_ref,
    sequenceNumber: record.sequence_number,
    messageId: record.message_id,
    clientMessageId: record.client_message_id ?? null,
    projectId: record.project_id,
    taskId: record.task_id,
    sender: { type: senderType, id: record.sender_id, name: record.sender_name },
    type: record.message_type === 'agent_status' ? 'agent_status' : 'text',
    content:
      !owner && (record.message_type === 'agent_status' || record.message_type === 'agent_chunk')
        ? ''
        : record.content,
    metadata,
    replyToMessageId: record.reply_to_message_id ?? null,
    rootMessageId: record.thread_root_message_id ?? null,
    runtimeAddress,
    status,
    traceState:
      record.trace_state ?? (runtimeAddress ? (owner ? 'available' : 'restricted') : undefined),
    createdAt: record.created_at,
    updatedAt: record.updated_at,
  }
}

export function createLocalProjectChatClient(
  request: LocalChatRequest,
  options: {
    currentUser: Pick<User, 'id' | 'user_name'>
    prepareExecution?: (input: {
      projectId: string
      taskId: string
      agentId: string
      text: string
      runnerSelection?: unknown
    }) => Promise<Record<string, unknown>>
  }
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
          const message = commentToMessage(record, currentUserId)
          latestSequence = Math.max(latestSequence, message.sequenceNumber)
          const previous = knownMessages.get(message.messageId)
          knownMessages.set(message.messageId, message)
          if (
            !previous ||
            previous.status !== message.status ||
            previous.content !== message.content ||
            JSON.stringify(previous.metadata) !== JSON.stringify(message.metadata) ||
            previous.updatedAt !== message.updatedAt
          ) {
            onMessage(message)
          }
        }
      } finally {
        inFlight = false
      }
    }

    await refresh()
    const snapshotMessages = [...knownMessages.values()].sort(
      (left, right) => left.sequenceNumber - right.sequenceNumber
    )
    const timer = window.setInterval(() => {
      void refresh().catch(error =>
        console.error('[local-project-chat] refresh failed', {
          projectId,
          taskId,
          error,
        })
      )
    }, LOCAL_COMMENT_POLL_INTERVAL_MS)
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
    return commentToMessage(created, currentUserId)
  }

  const executeTaskComment: ProjectChatClient['executeTaskComment'] = async input => {
    const records = await request<LocalCommentRecord[]>('todos.comment.list', {
      project_id: input.projectId,
      task_id: input.taskId,
      after_sequence: 0,
    })
    const trigger = records.find(item => item.message_id === input.triggerMessageId)
    if (!trigger) throw new Error('Comment is unavailable')
    const rootId = trigger.thread_root_message_id || trigger.reply_to_message_id
    const target = trigger.reply_to_message_id
      ? records
          .filter(
            item =>
              item.sender_type === 'agent' &&
              (item.thread_root_message_id === rootId || item.message_id === rootId)
          )
          .at(-1)
      : undefined
    const mentions = (trigger.metadata.mentions ?? []) as Array<{ type: string; id: string }>
    const agentIds = target
      ? [target.sender_id]
      : [...new Set(mentions.filter(item => item.type === 'agent').map(item => item.id))]
    for (const agentId of agentIds) {
      if (!options.prepareExecution) throw new Error('Execution configuration is unavailable')
      const payload =
        target?.metadata.execution_id != null
          ? { message: trigger.content }
          : await options.prepareExecution({
              projectId: input.projectId,
              taskId: input.taskId,
              agentId,
              text: trigger.content,
              runnerSelection: input.runnerSelection,
            })
      await request('executions.enqueue', {
        project_id: input.projectId,
        task_id: input.taskId,
        agent_id: agentId,
        trigger_message_id: trigger.message_id,
        payload: {
          ...payload,
          ...(input.humanRequestId ? { human_request_id: input.humanRequestId } : {}),
        },
      })
    }
    const updated = await request<LocalCommentRecord[]>('todos.comment.list', {
      project_id: input.projectId,
      task_id: input.taskId,
      after_sequence: trigger.sequence_number,
    })
    return updated.map(record => commentToMessage(record, currentUserId))
  }

  const startAgentResponse: ProjectChatClient['startAgentResponse'] = async input => {
    const created = await request<LocalCommentRecord>('todos.comment.agent.start', {
      project_id: input.projectId,
      task_id: input.taskId ?? '',
      agent_id: input.agentId,
      trigger_message_id: input.triggerMessageId ?? '',
      runtime_device_id: input.runtimeDeviceId,
      runtime_task_id: input.runtimeTaskId,
      prompt: input.prompt ?? null,
      model: input.model ?? null,
    })
    return commentToMessage(created, currentUserId)
  }

  const failAgentResponse: ProjectChatClient['failAgentResponse'] = async input => {
    const failed = await request<LocalCommentRecord>('todos.comment.agent.fail', {
      project_id: input.projectId,
      task_id: input.taskId ?? '',
      message_id: input.messageId,
      error: input.error ?? '执行失败',
    })
    return commentToMessage(failed, currentUserId)
  }

  return {
    subscribe,
    send,
    ...(options.prepareExecution ? { executeTaskComment } : {}),
    startAgentResponse,
    failAgentResponse,
    dispose: () => {
      for (const unsubscribe of [...activeUnsubscribers]) unsubscribe()
    },
  }
}
