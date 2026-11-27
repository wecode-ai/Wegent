import { createSocketClient, type AuthenticatedSocketClient } from './socket'
import type { RuntimeTaskAddress } from './runtime'

const NAMESPACE = '/wework-runtime'
const SUBSCRIBE_EVENT = 'wework:project_chat:subscribe'
const UNSUBSCRIBE_EVENT = 'wework:project_chat:unsubscribe'
const SEND_EVENT = 'wework:project_chat:message:send'
const CREATED_EVENT = 'wework:project_chat:message:created'
const AGENT_START_EVENT = 'wework:project_chat:agent:start'
const AGENT_FAILED_EVENT = 'wework:project_chat:agent:failed'
const AGENT_CHUNK_EVENT = 'wework:project_chat:agent:chunk'
const LOOP_ITEM_CHANGED_EVENT = 'wework:loop_item:changed'
const ACK_TIMEOUT_MS = 15_000

export interface ProjectChatMention {
  type: 'user' | 'agent'
  id: string
  label: string
}

export interface ProjectChatMessage {
  actorUserId?: string | null
  actorDisplayName?: string | null
  generationSource?: 'human' | 'ai' | 'system'
  publicationSource?: 'human' | 'ai' | 'system'
  confirmationState?: 'pending' | 'not_required' | 'authorized' | 'unknown'
  traceRef?: string | null
  traceState?: 'available' | 'restricted' | 'history-unavailable'
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
  status: 'pending' | 'streaming' | 'completed' | 'failed' | 'cancelled'
  createdAt: string
  updatedAt: string
}

function runtimeSequence(message: ProjectChatMessage): bigint {
  const sequence = message.metadata.runtime_event_sequence
  return typeof sequence === 'string' && /^[1-9]\d{0,19}$/.test(sequence)
    ? BigInt(sequence)
    : BigInt(0)
}

export function acceptsProjectChatMessage(
  previous: ProjectChatMessage,
  incoming: ProjectChatMessage,
  isDelta = false,
): boolean {
  const previousSequence = runtimeSequence(previous)
  const incomingSequence = runtimeSequence(incoming)
  if (previousSequence !== incomingSequence)
    return previousSequence < incomingSequence
  return (
    (!isDelta || incomingSequence === BigInt(0)) &&
    previous.updatedAt <= incoming.updatedAt
  )
}

export interface ProjectChatSubscription {
  messages: ProjectChatMessage[]
  latestSequence: number
  currentUserId: string
}

export interface LoopItemChangedEvent {
  projectId: string
  itemId: string
  version: number
  reason: 'runtime_status' | 'delivery_finalized' | 'workflow_decision' | string
}

export interface ProjectChatClient {
  publishAssistantMessage?: (input: {
    projectId: string
    taskId: string
    clientMessageId: string
    text: string
    source: { deviceId: string; taskId: string }
  }) => Promise<ProjectChatMessage>
  reconcileExecutionSnapshot?: (
    snapshot: RuntimeExecutionSnapshot,
  ) => Promise<ProjectChatMessage[]>
  subscribe: (
    projectId: string,
    taskId: string | undefined,
    afterSequence: number,
    onMessage: (message: ProjectChatMessage) => void,
    onChunk?: (message: ProjectChatMessage) => void,
  ) => Promise<{ snapshot: ProjectChatSubscription; unsubscribe: () => void }>
  send: (input: {
    projectId: string
    taskId?: string
    clientMessageId: string
    text: string
    mentions?: ProjectChatMention[]
    replyToMessageId?: string | null
    model?: string | null
    assistantSource?: { deviceId: string; taskId: string }
    /** Bound local code project chosen by the user for this comment's run. */
    localProjectId?: number | null
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
  executeTaskComment?: (input: {
    humanRequestId?: string
    runnerSelection?: {
      execution_policy?: {
        mode: 'project_pool' | 'fixed' | 'user_select'
        environment_id?: string
      }
      model?: {
        runtime: 'codex' | 'claude_code'
        provider: string
        model_id: string
      }
    }
    projectId: string
    taskId: string
    triggerMessageId: string
    attachmentIds?: number[]
  }) => Promise<ProjectChatMessage[]>
  continueWegentTask?: (input: {
    projectId: string
    taskId: string
    triggerMessageId: string
    agentId: string
    attachmentIds?: number[]
  }) => Promise<ProjectChatMessage>
  subscribeLoopItemChanges?: (
    onChange: (event: LoopItemChangedEvent) => void,
  ) => Promise<() => void>
  onReconnect?: (callback: () => void) => () => void
  dispose: () => void
}

export interface RuntimeExecutionSnapshot {
  deviceId: string
  taskId: string
  running?: boolean
  completeHistory: boolean
  turns: {
    id: string
    userMessageIds: string[]
    status: 'done' | 'failed' | 'cancelled' | 'running' | 'unknown'
    completedAt?: string | number | null
  }[]
}

interface ProjectChatClientOptions {
  socketBaseUrl: string | (() => string | Promise<string>)
  socketPath: string
  getToken: () => string | null
  clientOrigin?: 'wework' | 'web'
  requestRunnerSelection?: (request: unknown) => Promise<unknown>
}

interface SocketAck<T> {
  ok?: boolean
  result?: T
  error?: {
    code?: string
    message?: string
    detail?: { runner_selection_request?: unknown }
  }
}

export function createProjectChatClient(
  options: ProjectChatClientOptions,
): ProjectChatClient {
  const client = createSocketClient({
    socketBaseUrl:
      typeof options.socketBaseUrl === 'function'
        ? options.socketBaseUrl
        : () => options.socketBaseUrl as string,
    path: options.socketPath,
    namespace: NAMESPACE,
    getToken: options.getToken,
    auth: { client_origin: options.clientOrigin ?? 'wework' },
    logger: console,
  })
  const subscriptionLeases = new Map<string, number>()
  const leaveUnusedRoom = (projectId: string, taskId?: string) => {
    if (!subscriptionLeases.has(JSON.stringify([projectId, taskId ?? null])))
      client.socket.emit(UNSUBSCRIBE_EVENT, { projectId, taskId })
  }

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
      leaveUnusedRoom(projectId, taskId)
    }
  }

  return {
    reconcileExecutionSnapshot(snapshot) {
      return emitWithAck<ProjectChatMessage[]>(
        client,
        'wework:project_chat:execution:snapshot',
        {
          ...snapshot,
        },
      )
    },
    async subscribe(projectId, taskId, afterSequence, onMessage, onChunk) {
      await client.ensureConnected()
      const releaseSubscriptionLease = acquireSubscriptionLease(
        projectId,
        taskId,
      )
      let subscribed = false
      let active = true
      const revisions = new Map<string, number>()
      const latestMessages = new Map<string, ProjectChatMessage>()
      const resolvedSources = new Map<
        string,
        Pick<
          ProjectChatMessage,
          'traceRef' | 'traceState' | 'runtimeAddress' | 'metadata'
        >
      >()
      const sourceReads = new Map<string, Promise<void>>()
      const resolveSource = (message: ProjectChatMessage, revision: number) => {
        if (!message.traceRef || message.traceState !== 'restricted') return
        // Resolve this viewer's exact persisted source; the first message's
        // sequence zero cursor otherwise selects the newest history page.
        const read = emitWithAck<ProjectChatSubscription>(
          client,
          SUBSCRIBE_EVENT,
          {
            projectId,
            taskId,
            messageId: message.messageId,
            afterSequence: message.sequenceNumber - 1,
            limit: 1,
          },
        )
          .then((snapshot) => {
            if (!active) {
              leaveUnusedRoom(projectId, taskId)
              return
            }
            const superseded = (revisions.get(message.messageId) ?? 0) !== revision
            const resolved = snapshot.messages.find(
              (row) =>
                row.messageId === message.messageId &&
                row.projectId === projectId &&
                (row.taskId ?? undefined) === taskId,
            )
            console.debug('[Project chat source] Exact message read', {
              messageId: message.messageId,
              matched: Boolean(resolved),
              superseded,
              traceMatches: resolved?.traceRef === message.traceRef,
              traceState: resolved?.traceState,
              hasRuntimeAddress: Boolean(resolved?.runtimeAddress),
            })
            if (superseded) return
            const latest = latestMessages.get(message.messageId)
            if (resolved && latest && latest.traceRef === message.traceRef) {
              // Restore the authorized title without replacing live stream metadata.
              const source = {
                traceRef: resolved.traceRef,
                traceState: resolved.traceState,
                runtimeAddress: resolved.runtimeAddress,
                metadata:
                  typeof resolved.metadata.workflow_task_title === 'string'
                    ? {
                        workflow_task_title:
                          resolved.metadata.workflow_task_title,
                      }
                    : {},
              }
              resolvedSources.set(message.messageId, source)
              onMessage({
                ...latest,
                ...source,
                metadata: { ...source.metadata, ...latest.metadata },
              })
            }
          })
          .catch((error) => {
            if (active)
              console.warn(
                '[Wework] Failed to resolve project chat source',
                error,
              )
          })
          .finally(() => {
            if (sourceReads.get(message.messageId) === read)
              sourceReads.delete(message.messageId)
          })
        sourceReads.set(message.messageId, read)
      }
      const inScope = (message: ProjectChatMessage) =>
        message.projectId === projectId &&
        (message.taskId ?? undefined) === taskId
      const handler = (message: ProjectChatMessage) => {
        if (!inScope(message)) return
        const previous = latestMessages.get(message.messageId)
        if (previous && !acceptsProjectChatMessage(previous, message)) return
        const revision = (revisions.get(message.messageId) ?? 0) + 1
        revisions.set(message.messageId, revision)
        resolvedSources.delete(message.messageId)
        latestMessages.set(message.messageId, message)
        onMessage(message)
        resolveSource(message, revision)
      }
      const chunkHandler = (message: ProjectChatMessage) => {
        if (!inScope(message)) return
        const source = resolvedSources.get(message.messageId)
        const latest =
          source && source.traceRef === message.traceRef
            ? {
                ...message,
                ...source,
                metadata: { ...source.metadata, ...message.metadata },
              }
            : message
        const previous = latestMessages.get(message.messageId)
        const isDelta = message.metadata.contentMode !== 'snapshot'
        if (previous && !acceptsProjectChatMessage(previous, message, isDelta))
          return
        latestMessages.set(message.messageId, {
          ...latest,
          content: isDelta
            ? `${previous?.content ?? ''}${latest.content}`
            : latest.content,
        })
        onChunk?.(latest)
        // Streaming can be the first event carrying a Runtime binding. One
        // lookup per source avoids issuing a database read for every token.
        if (
          message.traceRef &&
          source?.traceRef !== message.traceRef &&
          !sourceReads.has(message.messageId)
        )
          resolveSource(message, revisions.get(message.messageId) ?? 0)
      }
      const reconnectHandler = () => {
        if (!subscribed) return
        void emitWithAck<ProjectChatSubscription>(client, SUBSCRIBE_EVENT, {
          projectId,
          taskId,
          afterSequence: 0,
        })
          .then((snapshot) => snapshot.messages.forEach(handler))
          .catch((error) => {
            console.warn(
              '[Wework] Failed to refresh project chat after reconnect',
              error,
            )
          })
      }
      client.socket.on(CREATED_EVENT, handler)
      client.socket.on(AGENT_CHUNK_EVENT, chunkHandler)
      client.socket.on('connect', reconnectHandler)
      try {
        const snapshot = await emitWithAck<ProjectChatSubscription>(
          client,
          SUBSCRIBE_EVENT,
          {
            projectId,
            taskId,
            afterSequence,
          },
        )
        subscribed = true
        for (const message of snapshot.messages) {
          const previous = latestMessages.get(message.messageId)
          if (!previous || acceptsProjectChatMessage(previous, message))
            latestMessages.set(message.messageId, message)
        }
        return {
          snapshot,
          unsubscribe: () => {
            active = false
            client.socket.off(CREATED_EVENT, handler)
            client.socket.off(AGENT_CHUNK_EVENT, chunkHandler)
            client.socket.off('connect', reconnectHandler)
            releaseSubscriptionLease()
          },
        }
      } catch (error) {
        active = false
        client.socket.off(CREATED_EVENT, handler)
        client.socket.off(AGENT_CHUNK_EVENT, chunkHandler)
        client.socket.off('connect', reconnectHandler)
        releaseSubscriptionLease()
        throw error
      }
    },
    async send(input) {
      if (input.assistantSource)
        throw new Error(
          'Assistant publication provenance requires the activity transport',
        )
      return emitWithAck<ProjectChatMessage>(client, SEND_EVENT, {
        projectId: input.projectId,
        taskId: input.taskId,
        clientMessageId: input.clientMessageId,
        content: input.text,
        mentions: input.mentions ?? [],
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
    async executeTaskComment(input) {
      try {
        return await emitWithAck<ProjectChatMessage[]>(
          client,
          'wework:project_chat:comment:execute',
          input,
          90_000,
        )
      } catch (error) {
        const request = (
          error as { detail?: { runner_selection_request?: unknown } }
        ).detail?.runner_selection_request
        if (
          !request ||
          !options.requestRunnerSelection ||
          input.runnerSelection
        )
          throw error
        const runnerSelection = await options.requestRunnerSelection(request)
        return emitWithAck<ProjectChatMessage[]>(
          client,
          'wework:project_chat:comment:execute',
          { ...input, runnerSelection },
          90_000,
        )
      }
    },
    async continueWegentTask(input) {
      const messages = await emitWithAck<ProjectChatMessage[]>(
        client,
        'wework:project_chat:comment:execute',
        input,
        90_000,
      )
      const message = messages.find(
        (message) => message.agentId === input.agentId,
      )
      if (!message)
        throw new Error('The saved comment did not start an agent response')
      return message
    },
    async subscribeLoopItemChanges(onChange) {
      const handler = (event: LoopItemChangedEvent) => {
        console.debug('[Wework] Loop-item change received', {
          projectId: event.projectId,
          itemId: event.itemId,
          version: event.version,
          reason: event.reason,
        })
        onChange(event)
      }
      client.socket.on(LOOP_ITEM_CHANGED_EVENT, handler)
      const unsubscribe = () => {
        client.socket.off(LOOP_ITEM_CHANGED_EVENT, handler)
      }
      try {
        await client.ensureConnected()
      } catch (error) {
        unsubscribe()
        throw error
      }
      return unsubscribe
    },
    onReconnect(callback) {
      return client.onReconnect(callback)
    },
    dispose() {
      client.dispose()
    },
  }
}

async function emitWithAck<T>(
  client: AuthenticatedSocketClient,
  event: string,
  payload: Record<string, unknown>,
  timeoutMs = ACK_TIMEOUT_MS,
): Promise<T> {
  await client.ensureConnected()
  return new Promise<T>((resolve, reject) => {
    const timeout = globalThis.setTimeout(
      () => reject(new Error(`${event} timed out`)),
      timeoutMs,
    )
    client.socket.emit(event, payload, (ack: SocketAck<T> | undefined) => {
      globalThis.clearTimeout(timeout)
      if (!ack || ack.ok === false || ack.error) {
        reject(
          Object.assign(
            new Error(ack?.error?.message || 'Project chat request failed'),
            {
              detail: ack?.error?.detail,
              code: ack?.error?.code,
            },
          ),
        )
        return
      }
      resolve(ack.result as T)
    })
  })
}
