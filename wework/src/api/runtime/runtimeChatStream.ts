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

let nextRuntimeChatStreamSubscriptionId = 1
let activeRuntimeChatStreamSubscriptions = 0
const RUNTIME_CHAT_STREAM_DEBUG_STORAGE_KEY = 'wework:debug-runtime-chat-stream'
const STREAM_EVENT_BATCH_INTERVAL_MS = 16

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
  let pendingStreamEvent: LocalExecutorEvent | null = null
  let streamEventFlushTimer: ReturnType<typeof globalThis.setTimeout> | null = null

  function processNativeEvent(event: LocalExecutorEvent): void {
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
      emitResponseApiEvent(subscription.handlers, event.event, event.payload, subscription.state)
    }
  }

  function flushPendingStreamEvent(): void {
    if (streamEventFlushTimer !== null) {
      globalThis.clearTimeout(streamEventFlushTimer)
      streamEventFlushTimer = null
    }
    const event = pendingStreamEvent
    pendingStreamEvent = null
    if (event) processNativeEvent(event)
  }

  function startStreamEventBatchWindow(): void {
    streamEventFlushTimer = globalThis.setTimeout(() => {
      streamEventFlushTimer = null
      const event = pendingStreamEvent
      pendingStreamEvent = null
      if (event) processNativeEvent(event)
    }, STREAM_EVENT_BATCH_INTERVAL_MS)
  }

  function handleNativeEvent(event: LocalExecutorEvent): void {
    if (!isBatchableRuntimeStreamEvent(event)) {
      flushPendingStreamEvent()
      processNativeEvent(event)
      return
    }

    if (streamEventFlushTimer === null) {
      processNativeEvent(event)
      startStreamEventBatchWindow()
      return
    }

    if (!pendingStreamEvent) {
      pendingStreamEvent = event
      return
    }

    const merged = mergeBatchableRuntimeStreamEvents(pendingStreamEvent, event)
    if (merged) {
      pendingStreamEvent = merged
      return
    }

    flushPendingStreamEvent()
    processNativeEvent(event)
    startStreamEventBatchWindow()
  }

  function ensureNativeListener(): void {
    if (nativeCleanup || nativeSubscribePromise) return
    nativeSubscribePromise = Promise.resolve(deps.subscribe(handleNativeEvent))
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
      flushPendingStreamEvent()
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
        flushPendingStreamEvent()
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

function isBatchableRuntimeStreamEvent(event: LocalExecutorEvent): boolean {
  return (
    isRuntimeTextDeltaEvent(event) ||
    isRuntimeBlockContentDeltaEvent(event) ||
    isRuntimeBlockContentSnapshotEvent(event)
  )
}

function mergeBatchableRuntimeStreamEvents(
  current: LocalExecutorEvent,
  next: LocalExecutorEvent
): LocalExecutorEvent | null {
  if (isRuntimeTextDeltaEvent(current) && isRuntimeTextDeltaEvent(next)) {
    return mergeRuntimeTextDeltaEvents(current, next)
  }
  if (isRuntimeBlockContentDeltaEvent(current) && isRuntimeBlockContentDeltaEvent(next)) {
    return mergeRuntimeBlockContentDeltas(current, next)
  }
  if (isRuntimeBlockContentSnapshotEvent(current) && isRuntimeBlockContentSnapshotEvent(next)) {
    return mergeRuntimeBlockContentSnapshots(current, next)
  }
  return null
}

function isRuntimeTextDeltaEvent(event: LocalExecutorEvent): boolean {
  return event.event === 'response.output_text.delta' || event.event === 'response.refusal.delta'
}

function mergeRuntimeTextDeltaEvents(
  current: LocalExecutorEvent,
  next: LocalExecutorEvent
): LocalExecutorEvent | null {
  if (current.event !== next.event) return null
  const currentPayload = asRecord(current.payload)
  const nextPayload = asRecord(next.payload)
  const currentData = asRecord(currentPayload.data)
  const nextData = asRecord(nextPayload.data)
  if (
    !sameRuntimeEventAddress(currentPayload, nextPayload) ||
    !sameRuntimeTextDeltaIdentity(currentData, nextData)
  ) {
    return null
  }

  const currentDelta = stringField(currentData, 'delta')
  const nextDelta = stringField(nextData, 'delta')
  if (currentDelta === undefined || nextDelta === undefined) return null
  const currentOffset = runtimeTextDeltaOffset(currentPayload, currentData)
  const nextOffset = runtimeTextDeltaOffset(nextPayload, nextData)
  if (
    (currentOffset === undefined) !== (nextOffset === undefined) ||
    (currentOffset !== undefined && nextOffset !== currentOffset + currentDelta.length)
  ) {
    return null
  }

  return {
    event: current.event,
    payload: {
      ...currentPayload,
      ...nextPayload,
      data: {
        ...currentData,
        ...nextData,
        delta: `${currentDelta}${nextDelta}`,
        ...(currentOffset !== undefined && { offset: currentOffset }),
      },
      ...(currentOffset !== undefined && { offset: currentOffset }),
    },
  }
}

function sameRuntimeTextDeltaIdentity(
  currentData: Record<string, unknown>,
  nextData: Record<string, unknown>
): boolean {
  return [
    [currentData.itemId ?? currentData.item_id, nextData.itemId ?? nextData.item_id],
    [
      currentData.outputIndex ?? currentData.output_index,
      nextData.outputIndex ?? nextData.output_index,
    ],
    [
      currentData.contentIndex ?? currentData.content_index,
      nextData.contentIndex ?? nextData.content_index,
    ],
  ].every(([currentValue, nextValue]) => currentValue === nextValue)
}

function isRuntimeBlockContentDeltaEvent(event: LocalExecutorEvent): boolean {
  if (event.event !== 'response.block.updated') return false
  const data = asRecord(asRecord(event.payload).data)
  if (Object.keys(asRecord(data.block)).length > 0) return false
  const updates = asRecord(data.updates)
  if (typeof (updates.contentDelta ?? updates.content_delta) !== 'string') return false
  if (updates.status !== undefined && updates.status !== 'streaming') return false
  return Object.keys(updates).every(
    key => key === 'contentDelta' || key === 'content_delta' || key === 'status'
  )
}

function mergeRuntimeBlockContentDeltas(
  current: LocalExecutorEvent,
  next: LocalExecutorEvent
): LocalExecutorEvent | null {
  const currentPayload = asRecord(current.payload)
  const nextPayload = asRecord(next.payload)
  const currentData = asRecord(currentPayload.data)
  const nextData = asRecord(nextPayload.data)
  if (
    !sameRuntimeEventAddress(currentPayload, nextPayload) ||
    (currentData.blockId ?? currentData.block_id) !== (nextData.blockId ?? nextData.block_id)
  ) {
    return null
  }
  const currentUpdates = asRecord(currentData.updates)
  const nextUpdates = asRecord(nextData.updates)
  const currentDelta =
    stringField(currentUpdates, 'contentDelta') ?? stringField(currentUpdates, 'content_delta')
  const nextDelta =
    stringField(nextUpdates, 'contentDelta') ?? stringField(nextUpdates, 'content_delta')
  if (currentDelta === undefined || nextDelta === undefined) return null
  const deltaKey =
    'contentDelta' in currentUpdates || 'contentDelta' in nextUpdates
      ? 'contentDelta'
      : 'content_delta'
  return {
    event: current.event,
    payload: {
      ...currentPayload,
      ...nextPayload,
      data: {
        ...currentData,
        ...nextData,
        updates: {
          ...currentUpdates,
          ...nextUpdates,
          [deltaKey]: `${currentDelta}${nextDelta}`,
        },
      },
    },
  }
}

function isRuntimeBlockContentSnapshotEvent(event: LocalExecutorEvent): boolean {
  if (event.event !== 'response.block.updated') return false
  const data = asRecord(asRecord(event.payload).data)
  if (Object.keys(asRecord(data.block)).length > 0) return false
  const updates = asRecord(data.updates)
  if (typeof updates.content !== 'string') return false
  if (updates.status !== undefined && updates.status !== 'streaming') return false
  return Object.keys(updates).every(key => key === 'content' || key === 'status')
}

function mergeRuntimeBlockContentSnapshots(
  current: LocalExecutorEvent,
  next: LocalExecutorEvent
): LocalExecutorEvent | null {
  const currentPayload = asRecord(current.payload)
  const nextPayload = asRecord(next.payload)
  const currentData = asRecord(currentPayload.data)
  const nextData = asRecord(nextPayload.data)
  if (!sameRuntimeEventAddress(currentPayload, nextPayload)) return null
  if ((currentData.blockId ?? currentData.block_id) !== (nextData.blockId ?? nextData.block_id)) {
    return null
  }
  return next
}

function sameRuntimeEventAddress(
  currentPayload: Record<string, unknown>,
  nextPayload: Record<string, unknown>
): boolean {
  return (
    currentPayload.taskId === nextPayload.taskId &&
    currentPayload.subtaskId === nextPayload.subtaskId &&
    currentPayload.deviceId === nextPayload.deviceId
  )
}

function runtimeTextDeltaOffset(
  payload: Record<string, unknown>,
  data: Record<string, unknown>
): number | undefined {
  const value = payload.offset ?? data.offset
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
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
