import type { ChatCancelAck, ChatCancelPayload, ChatGuideAck, ChatGuidePayload } from '@/types/api'
import type { ChatStreamHandlers } from '@/stream/chatStream'
import type { LocalExecutorEvent } from '@/tauri/localExecutor'
import {
  createResponseApiStreamState,
  emitResponseApiEvent,
  RESPONSE_API_STREAM_EVENTS,
} from '@/stream/responseApiStream'

interface RuntimeChatStreamDeps {
  subscribe: (handler: (event: LocalExecutorEvent) => void) => Promise<() => void>
  request: <T>(method: string, params?: Record<string, unknown>) => Promise<T>
}

let nextRuntimeChatStreamSubscriptionId = 1
let activeRuntimeChatStreamSubscriptions = 0
const RUNTIME_CHAT_STREAM_DEBUG_STORAGE_KEY = 'wework:debug-runtime-chat-stream'

export function isRuntimeChatStreamDebugEnabled(): boolean {
  return globalThis.localStorage?.getItem(RUNTIME_CHAT_STREAM_DEBUG_STORAGE_KEY) === '1'
}

export function setRuntimeChatStreamDebugEnabled(enabled: boolean): void {
  if (enabled) {
    globalThis.localStorage?.setItem(RUNTIME_CHAT_STREAM_DEBUG_STORAGE_KEY, '1')
    return
  }
  globalThis.localStorage?.removeItem(RUNTIME_CHAT_STREAM_DEBUG_STORAGE_KEY)
}

export function createRuntimeChatStream(deps: RuntimeChatStreamDeps) {
  const subscriptions = new Map<
    number,
    {
      handlers: ChatStreamHandlers
      state: ReturnType<typeof createResponseApiStreamState>
      eventCount: number
      textDeltaCount: number
    }
  >()
  let nativeCleanup: (() => void) | null = null
  let nativeSubscribePromise: Promise<void> | null = null
  function ensureNativeListener(): void {
    if (nativeCleanup || nativeSubscribePromise) return
    nativeSubscribePromise = Promise.resolve(
      deps.subscribe(event => {
        if (import.meta.env.DEV && event.event === 'runtime.plan.updated') {
          console.warn('[Wework] Runtime task plan event received', {
            taskId: stringField(asRecord(event.payload), 'taskId') ?? null,
            deviceId: stringField(asRecord(event.payload), 'deviceId') ?? null,
          })
        }
        const subscriptionEntries = Array.from(subscriptions)
        if (shouldLogRuntimeChatStreamEvent(event.event)) {
          const matchedSubscriptionCount = subscriptionEntries.filter(([, subscription]) =>
            isLocalExecutorEventInScope(event, subscription.handlers.scope)
          ).length
          logRuntimeChatTerminalEvent(event, matchedSubscriptionCount, subscriptionEntries.length)
        }
        for (const [subscriptionId, subscription] of subscriptionEntries) {
          if (event.event === 'executor.runtime_replaced') {
            const payload = runtimeTransportReplacedPayload(event.payload)
            if (payload) {
              subscription.state = createResponseApiStreamState()
              subscription.handlers.onRuntimeTransportReplaced?.(payload)
            }
            continue
          }
          const inScope = isLocalExecutorEventInScope(event, subscription.handlers.scope)
          if (!inScope && event.event !== 'runtime.plan.updated') {
            continue
          }
          if (!inScope && import.meta.env.DEV) {
            console.warn('[Wework] Runtime task plan event forwarded outside subscription scope', {
              subscriptionId,
            })
          }
          subscription.eventCount += 1
          if (event.event === 'response.output_text.delta') {
            subscription.textDeltaCount += 1
          }
          logRuntimeChatStreamEvent(
            subscriptionId,
            event,
            subscription.eventCount,
            subscription.textDeltaCount
          )
          emitResponseApiEvent(
            subscription.handlers,
            event.event,
            event.payload,
            subscription.state
          )
        }
        if (event.event === 'runtime.plan.updated') {
          globalThis.dispatchEvent(new Event('wework-runtime-plan-updated'))
        }
      })
    )
      .then(unlisten => {
        nativeSubscribePromise = null
        nativeCleanup = unlisten
        logRuntimeChatStreamNativeSubscription('native-listener-ready')
      })
      .catch(error => {
        nativeSubscribePromise = null
        console.error('[Wework] Runtime chat stream native listener failed', {
          error: error instanceof Error ? error.message : String(error),
          activeSubscriptions: activeRuntimeChatStreamSubscriptions,
        })
        logRuntimeChatStreamNativeSubscription('native-listener-failed', {
          error: error instanceof Error ? error.message : String(error),
        })
      })
  }

  // Start listening before a task pane exists. Local task creation and the
  // first tool event can otherwise race the pane's asynchronous subscription.
  ensureNativeListener()

  return {
    sendGuidance(payload: ChatGuidePayload): Promise<ChatGuideAck> {
      return deps.request<ChatGuideAck>(
        'runtime.tasks.guidance',
        payload as unknown as Record<string, unknown>
      )
    },
    cancelStream(payload: ChatCancelPayload): Promise<ChatCancelAck> {
      return deps.request<ChatCancelAck>(
        'runtime.tasks.cancel',
        payload as unknown as Record<string, unknown>
      )
    },
    subscribe(handlers: ChatStreamHandlers): () => void {
      if (!hasLocalExecutorResponseHandlers(handlers)) {
        return () => undefined
      }
      const subscriptionId = nextRuntimeChatStreamSubscriptionId++
      let released = false
      subscriptions.set(subscriptionId, {
        handlers,
        state: createResponseApiStreamState(),
        eventCount: 0,
        textDeltaCount: 0,
      })
      activeRuntimeChatStreamSubscriptions += 1
      logRuntimeChatStreamSubscription('subscribed', subscriptionId, {
        activeSubscriptions: activeRuntimeChatStreamSubscriptions,
        ...streamScopeDebug(handlers.scope),
      })
      // Retry setup if the eager native subscription failed.
      ensureNativeListener()

      return () => {
        if (released) return
        released = true
        const subscription = subscriptions.get(subscriptionId)
        subscriptions.delete(subscriptionId)
        activeRuntimeChatStreamSubscriptions = Math.max(0, activeRuntimeChatStreamSubscriptions - 1)
        logRuntimeChatStreamSubscription('unsubscribed', subscriptionId, {
          activeSubscriptions: activeRuntimeChatStreamSubscriptions,
          eventCount: subscription?.eventCount ?? 0,
          textDeltaCount: subscription?.textDeltaCount ?? 0,
          ...streamScopeDebug(subscription?.handlers.scope),
        })
      }
    },
  }
}

function logRuntimeChatTerminalEvent(
  event: LocalExecutorEvent,
  matchedSubscriptionCount: number,
  subscriptionCount: number
): void {
  const payload = asRecord(event.payload)
  console.info('[Wework] Runtime chat stream terminal event received', {
    event: event.event,
    taskId: stringField(payload, 'taskId') ?? null,
    subtaskId: stringField(payload, 'subtaskId') ?? null,
    deviceId: stringField(payload, 'deviceId') ?? null,
    subscriptionCount,
    matchedSubscriptionCount,
  })
}

function hasLocalExecutorResponseHandlers(handlers: ChatStreamHandlers): boolean {
  return Boolean(
    handlers.onChatStart ||
    handlers.onChatChunk ||
    handlers.onChatDone ||
    handlers.onChatError ||
    handlers.onBlockCreated ||
    handlers.onBlockUpdated ||
    handlers.onSubagentActivity ||
    handlers.onRuntimeGoalUpdated ||
    handlers.onRuntimeGoalCleared ||
    handlers.onRuntimePlanUpdated ||
    handlers.onGuidanceApplied ||
    handlers.onRuntimeTransportReplaced
  )
}

function runtimeTransportReplacedPayload(
  value: unknown
): { previousRuntimeInstanceId: string; runtimeInstanceId: string } | null {
  const payload = asRecord(value)
  const previousRuntimeInstanceId = stringField(payload, 'previousRuntimeInstanceId')
  const runtimeInstanceId = stringField(payload, 'runtimeInstanceId')
  if (!previousRuntimeInstanceId || !runtimeInstanceId) return null
  return { previousRuntimeInstanceId, runtimeInstanceId }
}

function streamScopeDebug(scope: ChatStreamHandlers['scope']): Record<string, unknown> {
  return {
    scopeTaskId: scope?.taskId ?? null,
    scopeDeviceId: scope?.deviceId ?? null,
  }
}

function logRuntimeChatStreamSubscription(
  action: string,
  subscriptionId: number,
  details: Record<string, unknown>
): void {
  if (!isRuntimeChatStreamDebugEnabled()) return
  console.debug('[Wework] Runtime chat stream subscription', {
    action,
    subscriptionId,
    ...details,
  })
}

function logRuntimeChatStreamNativeSubscription(
  action: string,
  details: Record<string, unknown> = {}
): void {
  if (!isRuntimeChatStreamDebugEnabled()) return
  console.debug('[Wework] Runtime chat stream native subscription', {
    action,
    activeSubscriptions: activeRuntimeChatStreamSubscriptions,
    ...details,
  })
}

function logRuntimeChatStreamEvent(
  subscriptionId: number,
  event: LocalExecutorEvent,
  eventCount: number,
  textDeltaCount: number
): void {
  if (!isRuntimeChatStreamDebugEnabled()) return
  if (!shouldLogRuntimeChatStreamEvent(event.event)) return
  const payload = asRecord(event.payload)
  const data = asRecord(payload.data)
  console.debug('[Wework] Runtime chat stream event', {
    subscriptionId,
    activeSubscriptions: activeRuntimeChatStreamSubscriptions,
    event: event.event,
    mapped: isMappedResponseApiEvent(event.event),
    eventCount,
    textDeltaCount,
    taskId: stringField(payload, 'taskId'),
    subtaskId: stringField(payload, 'subtaskId'),
    deviceId: stringField(payload, 'deviceId'),
    deltaLength: typeof data.delta === 'string' ? data.delta.length : undefined,
    offset: typeof data.offset === 'number' ? data.offset : undefined,
  })
}

function isLocalExecutorEventInScope(
  event: LocalExecutorEvent,
  scope: ChatStreamHandlers['scope']
): boolean {
  if (!scope?.taskId) return true
  const payload = asRecord(event.payload)
  const taskId = stringField(payload, 'taskId')
  if (taskId && taskId !== scope.taskId) return false
  const deviceId = stringField(payload, 'deviceId')
  if (scope.deviceId && deviceId && deviceId !== scope.deviceId) return false
  return true
}

function shouldLogRuntimeChatStreamEvent(eventName: string): boolean {
  return (
    eventName === 'response.completed' ||
    eventName === 'response.failed' ||
    eventName === 'response.incomplete' ||
    eventName === 'error'
  )
}

function isMappedResponseApiEvent(eventName: string): boolean {
  return (RESPONSE_API_STREAM_EVENTS as readonly string[]).includes(eventName)
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function stringField(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key]
  return typeof value === 'string' ? value : undefined
}
