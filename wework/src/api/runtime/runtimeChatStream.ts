import type { ChatCancelAck, ChatCancelPayload, ChatGuideAck, ChatGuidePayload } from '@/types/api'
import type { ChatStreamHandlers } from '@/stream/chatStream'
import type { LocalExecutorEvent } from '@/desktop/localExecutor'
import {
  createResponseApiStreamState,
  emitResponseApiEvent,
  RESPONSE_API_STREAM_EVENTS,
} from '@/stream/responseApiStream'

interface RuntimeChatStreamDeps {
  subscribe: (handler: (event: LocalExecutorEvent) => void) => Promise<() => void>
  request: <T>(method: string, params?: Record<string, unknown>) => Promise<T>
}

interface RuntimeChatSubscription {
  handlers: ChatStreamHandlers
  state: ReturnType<typeof createResponseApiStreamState>
  eventCount: number
  textDeltaCount: number
  emittedTextDeltaKeys: Set<string>
  pendingTextDeltas: Map<string, LocalExecutorEvent>
  pendingTextDeltaFrame: number | null
  pendingBlockUpdates: Map<string, LocalExecutorEvent>
  pendingBlockUpdateFrame: number | null
}

let nextRuntimeChatStreamSubscriptionId = 1
let activeRuntimeChatStreamSubscriptions = 0
const RUNTIME_CHAT_STREAM_DEBUG_STORAGE_KEY = 'wework:debug-runtime-chat-stream'

export function isRuntimeChatStreamDebugEnabled(): boolean {
  return (
    import.meta.env.VITE_WEWORK_RUNTIME_DEBUG === '1' ||
    globalThis.localStorage?.getItem(RUNTIME_CHAT_STREAM_DEBUG_STORAGE_KEY) === '1'
  )
}

export function setRuntimeChatStreamDebugEnabled(enabled: boolean): void {
  if (enabled) {
    globalThis.localStorage?.setItem(RUNTIME_CHAT_STREAM_DEBUG_STORAGE_KEY, '1')
    return
  }
  globalThis.localStorage?.removeItem(RUNTIME_CHAT_STREAM_DEBUG_STORAGE_KEY)
}

export function createRuntimeChatStream(deps: RuntimeChatStreamDeps) {
  const subscriptions = new Map<number, RuntimeChatSubscription>()
  let nativeCleanup: (() => void) | null = null
  let nativeSubscribePromise: Promise<void> | null = null

  function emitSubscriptionEvent(
    subscription: RuntimeChatSubscription,
    event: LocalExecutorEvent
  ): void {
    emitResponseApiEvent(subscription.handlers, event.event, event.payload, subscription.state)
  }

  function flushPendingBlockUpdates(subscription: RuntimeChatSubscription): void {
    if (subscription.pendingBlockUpdateFrame !== null) {
      cancelAnimationFrame(subscription.pendingBlockUpdateFrame)
      subscription.pendingBlockUpdateFrame = null
    }
    if (subscription.pendingBlockUpdates.size === 0) return
    const events = [...subscription.pendingBlockUpdates.values()]
    subscription.pendingBlockUpdates.clear()
    events.forEach(event => emitSubscriptionEvent(subscription, event))
  }

  function flushPendingTextDeltas(subscription: RuntimeChatSubscription): void {
    if (subscription.pendingTextDeltaFrame !== null) {
      cancelAnimationFrame(subscription.pendingTextDeltaFrame)
      subscription.pendingTextDeltaFrame = null
    }
    subscription.emittedTextDeltaKeys.clear()
    if (subscription.pendingTextDeltas.size === 0) return
    const events = [...subscription.pendingTextDeltas.values()]
    subscription.pendingTextDeltas.clear()
    events.forEach(event => emitSubscriptionEvent(subscription, event))
  }

  function scheduleTextDeltaFrame(subscription: RuntimeChatSubscription): void {
    if (subscription.pendingTextDeltaFrame !== null) return
    subscription.pendingTextDeltaFrame = requestAnimationFrame(() => {
      subscription.pendingTextDeltaFrame = null
      subscription.emittedTextDeltaKeys.clear()
      if (subscription.pendingTextDeltas.size === 0) return
      const events = [...subscription.pendingTextDeltas.values()]
      subscription.pendingTextDeltas.clear()
      events.forEach(event => emitSubscriptionEvent(subscription, event))
    })
  }

  function queueTextDelta(
    subscription: RuntimeChatSubscription,
    event: LocalExecutorEvent
  ): boolean {
    const key = coalescibleRuntimeTextDeltaKey(event)
    if (!key || !subscription.handlers.onChatChunk) return false
    if (!subscription.emittedTextDeltaKeys.has(key)) {
      if (subscription.pendingTextDeltas.size > 0) {
        flushPendingTextDeltas(subscription)
      }
      subscription.emittedTextDeltaKeys.add(key)
      scheduleTextDeltaFrame(subscription)
      emitSubscriptionEvent(subscription, event)
      return true
    }
    const pending = subscription.pendingTextDeltas.get(key)
    const merged = mergeCoalescibleTextDeltas(pending, event)
    if (!merged && pending) {
      subscription.pendingTextDeltas.delete(key)
      emitSubscriptionEvent(subscription, pending)
    }
    subscription.pendingTextDeltas.set(key, merged ?? event)
    return true
  }

  function queueBlockUpdate(
    subscription: RuntimeChatSubscription,
    event: LocalExecutorEvent
  ): boolean {
    const key = coalescibleRuntimeBlockUpdateKey(event)
    if (!key || !subscription.handlers.onBlockUpdated) return false
    const pending = subscription.pendingBlockUpdates.get(key)
    subscription.pendingBlockUpdates.set(key, mergeCoalescibleBlockUpdates(pending, event))
    if (subscription.pendingBlockUpdateFrame === null) {
      subscription.pendingBlockUpdateFrame = requestAnimationFrame(() => {
        subscription.pendingBlockUpdateFrame = null
        flushPendingBlockUpdates(subscription)
      })
    }
    return true
  }

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
          if (event.event === 'project.task.assigned') {
            const payload = projectTaskAssignedPayload(event.payload)
            if (payload) subscription.handlers.onProjectTaskAssigned?.(payload)
            continue
          }
          if (event.event === 'executor.event_lagged') {
            const payload = runtimeEventLaggedPayload(event.payload)
            if (payload) subscription.handlers.onRuntimeEventLagged?.(payload)
            continue
          }
          if (event.event === 'executor.runtime_replaced') {
            const payload = runtimeTransportReplacedPayload(event.payload)
            if (payload) {
              subscription.state = createResponseApiStreamState()
              subscription.handlers.onRuntimeTransportReplaced?.(payload)
            }
            continue
          }
          const inScope = isLocalExecutorEventInScope(event, subscription.handlers.scope)
          if (!inScope) continue
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
          if (coalescibleRuntimeTextDeltaKey(event)) {
            flushPendingBlockUpdates(subscription)
            if (queueTextDelta(subscription, event)) continue
          }
          flushPendingTextDeltas(subscription)
          if (queueBlockUpdate(subscription, event)) continue
          flushPendingBlockUpdates(subscription)
          emitSubscriptionEvent(subscription, event)
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
        emittedTextDeltaKeys: new Set(),
        pendingTextDeltas: new Map(),
        pendingTextDeltaFrame: null,
        pendingBlockUpdates: new Map(),
        pendingBlockUpdateFrame: null,
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
        if (subscription && subscription.pendingTextDeltaFrame !== null) {
          cancelAnimationFrame(subscription.pendingTextDeltaFrame)
        }
        if (subscription && subscription.pendingBlockUpdateFrame !== null) {
          cancelAnimationFrame(subscription.pendingBlockUpdateFrame)
        }
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

function coalescibleRuntimeTextDeltaKey(event: LocalExecutorEvent): string | null {
  if (event.event !== 'response.output_text.delta') return null
  const payload = asRecord(event.payload)
  const data = asRecord(payload.data)
  if (!stringField(data, 'delta')) return null
  const taskId = stringField(payload, 'taskId')
  const subtaskId = stringField(payload, 'subtaskId')
  if (!taskId || !subtaskId) return null
  const itemId = stringField(data, 'itemId') ?? stringField(data, 'item_id') ?? ''
  const outputIndex = finiteNumberField(data, 'outputIndex', 'output_index')
  const contentIndex = finiteNumberField(data, 'contentIndex', 'content_index')
  return [
    stringField(payload, 'deviceId') ?? '',
    taskId,
    subtaskId,
    itemId,
    outputIndex ?? '',
    contentIndex ?? '',
  ].join(':')
}

function mergeCoalescibleTextDeltas(
  previous: LocalExecutorEvent | undefined,
  next: LocalExecutorEvent
): LocalExecutorEvent | null {
  if (!previous) return next
  const previousPayload = asRecord(previous.payload)
  const previousData = asRecord(previousPayload.data)
  const nextPayload = asRecord(next.payload)
  const nextData = asRecord(nextPayload.data)
  const previousDelta = stringField(previousData, 'delta')
  const nextDelta = stringField(nextData, 'delta')
  if (previousDelta === undefined || nextDelta === undefined) return null
  const previousOffset = finiteNumberField(previousData, 'offset')
  const nextOffset = finiteNumberField(nextData, 'offset')
  if (
    previousOffset !== undefined &&
    nextOffset !== undefined &&
    nextOffset !== previousOffset + previousDelta.length
  ) {
    return null
  }
  if ((previousOffset === undefined) !== (nextOffset === undefined)) return null
  return {
    ...next,
    payload: {
      ...nextPayload,
      data: {
        ...nextData,
        delta: previousDelta + nextDelta,
        ...(previousOffset !== undefined && { offset: previousOffset }),
      },
    },
  }
}

function coalescibleRuntimeBlockUpdateKey(event: LocalExecutorEvent): string | null {
  if (event.event !== 'response.block.updated') return null
  const payload = asRecord(event.payload)
  const data = asRecord(payload.data)
  const updates = asRecord(data.updates)
  const updateKeys = Object.keys(updates)
  const hasContentSnapshot = typeof updates.content === 'string'
  const hasContentDelta =
    typeof updates.contentDelta === 'string' || typeof updates.content_delta === 'string'
  if (
    (!hasContentSnapshot && !hasContentDelta) ||
    updates.status !== 'streaming' ||
    updateKeys.some(
      key =>
        key !== 'content' && key !== 'contentDelta' && key !== 'content_delta' && key !== 'status'
    )
  ) {
    return null
  }
  const taskId = stringField(payload, 'taskId')
  const subtaskId = stringField(payload, 'subtaskId')
  const blockId = stringField(data, 'blockId') ?? stringField(data, 'block_id')
  if (!taskId || !subtaskId || !blockId) return null
  return [stringField(payload, 'deviceId') ?? '', taskId, subtaskId, blockId].join(':')
}

function mergeCoalescibleBlockUpdates(
  previous: LocalExecutorEvent | undefined,
  next: LocalExecutorEvent
): LocalExecutorEvent {
  if (!previous) return next
  const previousPayload = asRecord(previous.payload)
  const previousData = asRecord(previousPayload.data)
  const previousUpdates = asRecord(previousData.updates)
  const nextPayload = asRecord(next.payload)
  const nextData = asRecord(nextPayload.data)
  const nextUpdates = asRecord(nextData.updates)
  const previousDelta =
    stringField(previousUpdates, 'contentDelta') ?? stringField(previousUpdates, 'content_delta')
  const nextDelta =
    stringField(nextUpdates, 'contentDelta') ?? stringField(nextUpdates, 'content_delta')
  if (previousDelta === undefined || nextDelta === undefined) return next
  return {
    ...next,
    payload: {
      ...nextPayload,
      data: {
        ...nextData,
        updates: {
          ...nextUpdates,
          content_delta: previousDelta + nextDelta,
        },
      },
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
    handlers.onRuntimeTaskTitleUpdated ||
    handlers.onRuntimeGoalUpdated ||
    handlers.onRuntimeGoalCleared ||
    handlers.onRuntimeSupervisorUpdated ||
    handlers.onRuntimePlanUpdated ||
    handlers.onGuidanceApplied ||
    handlers.onRuntimeEventLagged ||
    handlers.onRuntimeTransportReplaced ||
    handlers.onProjectTaskAssigned
  )
}

function runtimeEventLaggedPayload(value: unknown): { skipped: number } | null {
  const payload = asRecord(value)
  const skipped = payload.skipped
  return typeof skipped === 'number' && Number.isFinite(skipped) && skipped >= 0
    ? { skipped }
    : null
}

function projectTaskAssignedPayload(
  payload: Record<string, unknown>
): Parameters<NonNullable<ChatStreamHandlers['onProjectTaskAssigned']>>[0] | null {
  const projectId = stringField(payload, 'projectId')
  const projectName = stringField(payload, 'projectName')
  const itemId = stringField(payload, 'itemId')
  const itemTitle = stringField(payload, 'itemTitle')
  const assignerName = stringField(payload, 'assignerName')
  if (!projectId || !itemId || !itemTitle || !assignerName) return null
  return {
    projectId,
    projectName: projectName ?? '',
    itemId,
    itemTitle,
    assignerName,
  }
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
  const payload = asRecord(event.payload)
  const data = asRecord(payload.data)
  console.info('[Wework] Runtime chat stream event', {
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

function finiteNumberField(record: Record<string, unknown>, ...keys: string[]): number | undefined {
  for (const key of keys) {
    const value = record[key]
    if (typeof value === 'number' && Number.isFinite(value)) return value
  }
  return undefined
}
