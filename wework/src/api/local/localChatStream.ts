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

export function createLocalChatStream(deps: LocalChatStreamDeps) {
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
      const subscriptionId = nextLocalChatStreamSubscriptionId++
      let cleanup: (() => void) | null = null
      let active = true
      let released = false
      let eventCount = 0
      let textDeltaCount = 0
      const state = createResponseApiStreamState()
      activeLocalChatStreamSubscriptions += 1
      logLocalChatStreamSubscription('subscribed', subscriptionId, {
        activeSubscriptions: activeLocalChatStreamSubscriptions,
      })

      void deps
        .subscribe(event => {
          if (active) {
            eventCount += 1
            if (event.event === 'response.output_text.delta') {
              textDeltaCount += 1
            }
            logLocalChatStreamEvent(subscriptionId, event, eventCount, textDeltaCount)
            emitResponseApiEvent(handlers, event.event, event.payload, state)
          }
        })
        .then(unlisten => {
          if (active) {
            cleanup = unlisten
            logLocalChatStreamSubscription('native-listener-ready', subscriptionId, {
              activeSubscriptions: activeLocalChatStreamSubscriptions,
            })
            return
          }
          logLocalChatStreamSubscription('late-native-listener-cleanup', subscriptionId, {
            activeSubscriptions: activeLocalChatStreamSubscriptions,
          })
          unlisten()
        })
        .catch(error => {
          logLocalChatStreamSubscription('native-listener-failed', subscriptionId, {
            activeSubscriptions: activeLocalChatStreamSubscriptions,
            error: error instanceof Error ? error.message : String(error),
          })
        })

      return () => {
        if (released) return
        released = true
        active = false
        activeLocalChatStreamSubscriptions = Math.max(0, activeLocalChatStreamSubscriptions - 1)
        logLocalChatStreamSubscription('unsubscribed', subscriptionId, {
          activeSubscriptions: activeLocalChatStreamSubscriptions,
          eventCount,
          textDeltaCount,
          hadNativeCleanup: Boolean(cleanup),
        })
        cleanup?.()
        cleanup = null
      }
    },
  }
}

function logLocalChatStreamSubscription(
  action: string,
  subscriptionId: number,
  details: Record<string, unknown>
): void {
  console.debug('[Wework] Local chat stream subscription', {
    action,
    subscriptionId,
    ...details,
  })
}

function logLocalChatStreamEvent(
  subscriptionId: number,
  event: LocalExecutorEvent,
  eventCount: number,
  textDeltaCount: number
): void {
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
