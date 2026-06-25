import type { ChatCancelAck, ChatCancelPayload, ChatGuideAck, ChatGuidePayload } from '@/types/api'
import type { ChatStreamHandlers } from '@/stream/chatStream'
import type { LocalExecutorEvent } from '@/tauri/localExecutor'

interface LocalChatStreamDeps {
  subscribe: (handler: (event: LocalExecutorEvent) => void) => Promise<() => void>
  request: <T>(method: string, params?: Record<string, unknown>) => Promise<T>
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value : {}
}

function stringField(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key]
  return typeof value === 'string' ? value : undefined
}

function numberField(record: Record<string, unknown>, key: string): number {
  const value = record[key]
  return typeof value === 'number' ? value : 0
}

function eventBase(payload: Record<string, unknown>) {
  return {
    task_id: numberField(payload, 'task_id'),
    subtask_id: numberField(payload, 'subtask_id'),
    device_id: stringField(payload, 'device_id'),
    local_task_id: stringField(payload, 'local_task_id'),
  }
}

function eventResult(payload: Record<string, unknown>): Record<string, unknown> {
  return asRecord(payload.data)
}

function eventContent(payload: Record<string, unknown>): string {
  const result = eventResult(payload)
  return (
    stringField(result, 'delta') ??
    stringField(result, 'value') ??
    stringField(result, 'output_text') ??
    ''
  )
}

function emitResponseEvent(handlers: ChatStreamHandlers, event: LocalExecutorEvent): void {
  const payload = asRecord(event.payload)
  const base = eventBase(payload)

  if (event.event === 'response.created' || event.event === 'response.in_progress') {
    handlers.onChatStart?.({
      ...base,
      shell_type: stringField(payload, 'runtime'),
    })
    return
  }

  if (event.event === 'response.output_text.delta') {
    handlers.onChatChunk?.({
      ...base,
      content: eventContent(payload),
      offset: numberField(payload, 'offset'),
      result: eventResult(payload),
    })
    return
  }

  if (event.event === 'response.completed') {
    handlers.onChatDone?.({
      ...base,
      offset: numberField(payload, 'offset'),
      result: eventResult(payload),
    })
    return
  }

  if (event.event === 'response.incomplete' || event.event === 'error') {
    handlers.onChatError?.({
      ...base,
      error: stringField(payload, 'error') ?? (eventContent(payload) || 'Local executor error'),
      type: stringField(payload, 'type') ?? event.event,
    })
  }
}

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
      let cleanup: (() => void) | null = null
      let active = true

      void deps.subscribe(event => {
        if (active) {
          emitResponseEvent(handlers, event)
        }
      }).then(unlisten => {
        if (active) {
          cleanup = unlisten
          return
        }
        unlisten()
      })

      return () => {
        active = false
        cleanup?.()
      }
    },
  }
}
