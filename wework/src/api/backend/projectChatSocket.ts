import { createSocketClient, type AuthenticatedSocketClient } from '@wegent/chat-core'
import type { Attachment, RuntimeTaskAddress } from '@/types/api'

const NAMESPACE = '/wework-runtime'
const SUBSCRIBE_EVENT = 'wework:project_chat:subscribe'
const UNSUBSCRIBE_EVENT = 'wework:project_chat:unsubscribe'
const SEND_EVENT = 'wework:project_chat:message:send'
const CREATED_EVENT = 'wework:project_chat:message:created'
const AGENT_START_EVENT = 'wework:project_chat:agent:start'
const AGENT_FAILED_EVENT = 'wework:project_chat:agent:failed'
const AGENT_CHUNK_EVENT = 'wework:project_chat:agent:chunk'
const ACK_TIMEOUT_MS = 15_000

export interface ProjectChatMention {
  type: 'user' | 'agent' | 'squad'
  id: string
  label: string
}

export interface ProjectChatMessage {
  sequenceNumber: number
  messageId: string
  clientMessageId?: string | null
  projectId: string
  taskId?: string | null
  sender: { type: 'user' | 'agent' | 'system'; id: string; name: string }
  type: 'text' | 'agent_status' | 'agent_chunk' | 'system'
  content: string
  metadata: Record<string, unknown>
  triggerMessageId?: string | null
  replyToMessageId?: string | null
  rootMessageId?: string | null
  agentId?: string | null
  runtimeAddress?: RuntimeTaskAddress | null
  status: 'streaming' | 'completed' | 'failed' | 'cancelled'
  createdAt: string
  updatedAt: string
}

export interface ProjectChatSubscription {
  messages: ProjectChatMessage[]
  latestSequence: number
  currentUserId: string
}

export interface ProjectChatClient {
  subscribe: (
    projectId: string,
    taskId: string | undefined,
    afterSequence: number,
    onMessage: (message: ProjectChatMessage) => void,
    onChunk?: (message: ProjectChatMessage) => void
  ) => Promise<{ snapshot: ProjectChatSubscription; unsubscribe: () => void }>
  send: (input: {
    projectId: string
    taskId?: string
    clientMessageId: string
    text: string
    mentions?: ProjectChatMention[]
    replyToMessageId?: string | null
    model?: string | null
    /** Bound local code project chosen by the user for this comment's run. */
    localProjectId?: number | null
    /** The workflow runtime owns dispatch; local chat must not enqueue again. */
    workflowManaged?: boolean
    /** Backend attachment context IDs associated with this comment. */
    attachmentIds?: number[]
    /** Local attachment descriptors retained by the local workflow runtime. */
    attachments?: Attachment[]
  }) => Promise<ProjectChatMessage>
  startAgentResponse: (input: {
    projectId: string
    taskId?: string
    triggerMessageId?: string
    agentId: string
    runtimeDeviceId: string
    runtimeTaskId: string
    prompt?: string
    autoRetry?: boolean
    model?: string | null
  }) => Promise<ProjectChatMessage>
  failAgentResponse: (input: {
    projectId: string
    taskId?: string
    messageId: string
    error?: string
  }) => Promise<ProjectChatMessage>
  dispose: () => void
}

interface ProjectChatClientOptions {
  socketBaseUrl: string
  socketPath: string
  getToken: () => string | null
}

interface SocketAck<T> {
  ok?: boolean
  result?: T
  error?: { code?: string; message?: string }
}

export function createProjectChatClient(options: ProjectChatClientOptions): ProjectChatClient {
  const client = createSocketClient({
    socketBaseUrl: () => options.socketBaseUrl,
    path: options.socketPath,
    namespace: NAMESPACE,
    getToken: options.getToken,
    auth: { client_origin: 'wework' },
    logger: console,
  })
  const subscriptionLeases = new Map<string, number>()

  const acquireSubscriptionLease = (projectId: string, taskId?: string) => {
    const key = JSON.stringify([projectId, taskId ?? null])
    subscriptionLeases.set(key, (subscriptionLeases.get(key) ?? 0) + 1)
    let released = false
    return () => {
      if (released) return
      released = true
      const remaining = (subscriptionLeases.get(key) ?? 1) - 1
      if (remaining > 0) {
        subscriptionLeases.set(key, remaining)
        return
      }
      subscriptionLeases.delete(key)
      client.socket.emit(UNSUBSCRIBE_EVENT, { projectId, taskId })
    }
  }

  return {
    async subscribe(projectId, taskId, afterSequence, onMessage, onChunk) {
      await client.ensureConnected()
      const releaseSubscriptionLease = acquireSubscriptionLease(projectId, taskId)
      let subscribed = false
      const handler = (message: ProjectChatMessage) => {
        if (message.projectId !== projectId) return
        if (taskId && message.taskId !== taskId) return
        if (!taskId && message.taskId) return
        onMessage(message)
      }
      const chunkHandler = (message: ProjectChatMessage) => {
        if (message.projectId !== projectId) return
        if (taskId && message.taskId !== taskId) return
        if (!taskId && message.taskId) return
        onChunk?.(message)
      }
      const reconnectHandler = () => {
        if (!subscribed) return
        void emitWithAck<ProjectChatSubscription>(client, SUBSCRIBE_EVENT, {
          projectId,
          taskId,
          afterSequence: 0,
        })
          .then(snapshot => snapshot.messages.forEach(message => onMessage(message)))
          .catch(error => {
            console.warn('[Wework] Failed to refresh project chat after reconnect', error)
          })
      }
      client.socket.on(CREATED_EVENT, handler)
      client.socket.on(AGENT_CHUNK_EVENT, chunkHandler)
      client.socket.on('connect', reconnectHandler)
      try {
        const snapshot = await emitWithAck<ProjectChatSubscription>(client, SUBSCRIBE_EVENT, {
          projectId,
          taskId,
          afterSequence,
        })
        subscribed = true
        return {
          snapshot,
          unsubscribe: () => {
            client.socket.off(CREATED_EVENT, handler)
            client.socket.off(AGENT_CHUNK_EVENT, chunkHandler)
            client.socket.off('connect', reconnectHandler)
            releaseSubscriptionLease()
          },
        }
      } catch (error) {
        client.socket.off(CREATED_EVENT, handler)
        client.socket.off(AGENT_CHUNK_EVENT, chunkHandler)
        client.socket.off('connect', reconnectHandler)
        releaseSubscriptionLease()
        throw error
      }
    },
    send(input) {
      return emitWithAck<ProjectChatMessage>(client, SEND_EVENT, {
        projectId: input.projectId,
        taskId: input.taskId,
        clientMessageId: input.clientMessageId,
        content: input.text,
        mentions: input.mentions ?? [],
        attachmentIds: input.attachmentIds ?? [],
        replyToMessageId: input.replyToMessageId ?? null,
        model: input.model ?? null,
      })
    },
    startAgentResponse(input) {
      return emitWithAck<ProjectChatMessage>(client, AGENT_START_EVENT, {
        projectId: input.projectId,
        taskId: input.taskId,
        triggerMessageId: input.triggerMessageId,
        agentId: input.agentId,
        runtimeDeviceId: input.runtimeDeviceId,
        runtimeTaskId: input.runtimeTaskId,
        prompt: input.prompt,
        autoRetry: input.autoRetry ?? false,
        model: input.model ?? null,
      })
    },
    failAgentResponse(input) {
      return emitWithAck<ProjectChatMessage>(client, AGENT_FAILED_EVENT, input)
    },
    dispose() {
      client.dispose()
    },
  }
}

async function emitWithAck<T>(
  client: AuthenticatedSocketClient,
  event: string,
  payload: Record<string, unknown>
): Promise<T> {
  await client.ensureConnected()
  return new Promise<T>((resolve, reject) => {
    const timeout = window.setTimeout(() => reject(new Error(`${event} timed out`)), ACK_TIMEOUT_MS)
    client.socket.emit(event, payload, (ack: SocketAck<T> | undefined) => {
      window.clearTimeout(timeout)
      if (!ack || ack.ok === false || ack.error) {
        reject(new Error(ack?.error?.message || 'Project chat request failed'))
        return
      }
      resolve(ack.result as T)
    })
  })
}
