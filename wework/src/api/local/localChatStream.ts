import type { ChatCancelAck, ChatCancelPayload, ChatGuideAck, ChatGuidePayload } from '@/types/api'
import type { ChatStreamHandlers } from '@/stream/chatStream'
import type { LocalExecutorEvent } from '@/tauri/localExecutor'
import {
  createResponseApiStreamState,
  emitResponseApiEvent,
  RESPONSE_API_STREAM_EVENTS,
} from '@/stream/responseApiStream'

interface LocalChatStreamDeps {
  subscribe: (handler: (event: LocalExecutorEvent) => void) => Promise<() => void>
  request: <T>(method: string, params?: Record<string, unknown>) => Promise<T>
}

let nextLocalChatStreamSubscriptionId = 1
let activeLocalChatStreamSubscriptions = 0
const LOCAL_CHAT_STREAM_DEBUG_STORAGE_KEY = 'wework:debug-local-chat-stream'

export function isLocalChatStreamDebugEnabled(): boolean {
  return globalThis.localStorage?.getItem(LOCAL_CHAT_STREAM_DEBUG_STORAGE_KEY) === '1'
}

export function setLocalChatStreamDebugEnabled(enabled: boolean): void {
  if (enabled) {
    globalThis.localStorage?.setItem(LOCAL_CHAT_STREAM_DEBUG_STORAGE_KEY, '1')
    return
  }
  globalThis.localStorage?.removeItem(LOCAL_CHAT_STREAM_DEBUG_STORAGE_KEY)
}

export function createLocalChatStream(deps: LocalChatStreamDeps) {
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
    nativeSubscribePromise = deps
      .subscribe(event => {
        if (import.meta.env.DEV && event.event === 'runtime.plan.updated') {
          console.warn('[Wework] Local runtime task plan event received', {
            taskId: stringField(asRecord(event.payload), 'taskId') ?? null,
            deviceId: stringField(asRecord(event.payload), 'deviceId') ?? null,
          })
        }
        const subscriptionEntries = Array.from(subscriptions)
        if (shouldLogLocalChatStreamEvent(event.event)) {
          const matchedSubscriptionCount = subscriptionEntries.filter(([, subscription]) =>
            isLocalExecutorEventInScope(event, subscription.handlers.scope)
          ).length
          logLocalChatTerminalEvent(event, matchedSubscriptionCount, subscriptionEntries.length)
        }
        for (const [subscriptionId, subscription] of subscriptionEntries) {
          const inScope = isLocalExecutorEventInScope(event, subscription.handlers.scope)
          if (!inScope && event.event !== 'runtime.plan.updated') {
            continue
          }
          if (!inScope && import.meta.env.DEV) {
            console.warn(
              '[Wework] Local runtime task plan event cached outside subscription scope',
              {
                subscriptionId,
              }
            )
          }
          subscription.eventCount += 1
          if (event.event === 'response.output_text.delta') {
            subscription.textDeltaCount += 1
          }
          logLocalChatStreamEvent(
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
      .then(unlisten => {
        nativeSubscribePromise = null
        if (subscriptions.size === 0) {
          logLocalChatStreamNativeSubscription('late-native-listener-cleanup')
          unlisten()
          return
        }
        nativeCleanup = unlisten
        logLocalChatStreamNativeSubscription('native-listener-ready')
      })
      .catch(error => {
        nativeSubscribePromise = null
        console.error('[Wework] Local chat stream native listener failed', {
          error: error instanceof Error ? error.message : String(error),
          activeSubscriptions: activeLocalChatStreamSubscriptions,
        })
        logLocalChatStreamNativeSubscription('native-listener-failed', {
          error: error instanceof Error ? error.message : String(error),
        })
      })
  }

  function releaseNativeListenerIfIdle(): void {
    if (subscriptions.size > 0) return
    if (!nativeCleanup) return
    nativeCleanup()
    nativeCleanup = null
    logLocalChatStreamNativeSubscription('native-listener-released')
  }

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
      const subscriptionId = nextLocalChatStreamSubscriptionId++
      let released = false
      subscriptions.set(subscriptionId, {
        handlers,
        state: createResponseApiStreamState(),
        eventCount: 0,
        textDeltaCount: 0,
      })
      activeLocalChatStreamSubscriptions += 1
      logLocalChatStreamSubscription('subscribed', subscriptionId, {
        activeSubscriptions: activeLocalChatStreamSubscriptions,
        ...streamScopeDebug(handlers.scope),
      })
      ensureNativeListener()

      return () => {
        if (released) return
        released = true
        const subscription = subscriptions.get(subscriptionId)
        subscriptions.delete(subscriptionId)
        activeLocalChatStreamSubscriptions = Math.max(0, activeLocalChatStreamSubscriptions - 1)
        logLocalChatStreamSubscription('unsubscribed', subscriptionId, {
          activeSubscriptions: activeLocalChatStreamSubscriptions,
          eventCount: subscription?.eventCount ?? 0,
          textDeltaCount: subscription?.textDeltaCount ?? 0,
          ...streamScopeDebug(subscription?.handlers.scope),
        })
        releaseNativeListenerIfIdle()
      }
    },
  }
}

function logLocalChatTerminalEvent(
  event: LocalExecutorEvent,
  matchedSubscriptionCount: number,
  subscriptionCount: number
): void {
  const payload = asRecord(event.payload)
  console.info('[Wework] Local chat stream terminal event received', {
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
    handlers.onGuidanceApplied
  )
}

function streamScopeDebug(scope: ChatStreamHandlers['scope']): Record<string, unknown> {
  return {
    scopeTaskId: scope?.taskId ?? null,
    scopeDeviceId: scope?.deviceId ?? null,
  }
}

function logLocalChatStreamSubscription(
  action: string,
  subscriptionId: number,
  details: Record<string, unknown>
): void {
  if (!isLocalChatStreamDebugEnabled()) return
  console.debug('[Wework] Local chat stream subscription', {
    action,
    subscriptionId,
    ...details,
  })
}

function logLocalChatStreamNativeSubscription(
  action: string,
  details: Record<string, unknown> = {}
): void {
  if (!isLocalChatStreamDebugEnabled()) return
  console.debug('[Wework] Local chat stream native subscription', {
    action,
    activeSubscriptions: activeLocalChatStreamSubscriptions,
    ...details,
  })
}

function logLocalChatStreamEvent(
  subscriptionId: number,
  event: LocalExecutorEvent,
  eventCount: number,
  textDeltaCount: number
): void {
  if (!isLocalChatStreamDebugEnabled()) return
  if (!shouldLogLocalChatStreamEvent(event.event)) return
  const payload = asRecord(event.payload)
  const data = asRecord(payload.data)
  console.debug('[Wework] Local chat stream event', {
    subscriptionId,
    activeSubscriptions: activeLocalChatStreamSubscriptions,
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

function shouldLogLocalChatStreamEvent(eventName: string): boolean {
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
