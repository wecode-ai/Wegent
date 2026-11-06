import { afterEach, expect, test, vi } from 'vitest'
import { createChatStream } from './chatStream'
import { createRuntimeChatStream } from '@/api/runtime/runtimeChatStream'
import type { LocalExecutorEvent } from '@/desktop/localExecutor'
import {
  getRuntimeStreamDiagnostics,
  measureRuntimeStreamEvent,
  startRuntimeStreamDiagnostics,
  stopRuntimeStreamDiagnostics,
} from './runtimeStreamDiagnostics'

afterEach(stopRuntimeStreamDiagnostics)

test('captures the local IPC stream used by standalone conversations', async () => {
  let listener!: (event: LocalExecutorEvent) => void
  const stream = createRuntimeChatStream({
    subscribe: async handler => {
      listener = handler
      return vi.fn()
    },
    request: vi.fn(),
  })
  const onChatChunk = vi.fn()
  const unsubscribe = stream.subscribe({ onChatChunk })
  await Promise.resolve()
  startRuntimeStreamDiagnostics()
  listener({
    event: 'response.output_text.delta',
    payload: {
      taskId: 'private-task',
      subtaskId: 'private-turn',
      data: { delta: 'private-local-content', offset: 0 },
    },
  })
  expect(onChatChunk).toHaveBeenCalledWith(
    expect.objectContaining({ content: 'private-local-content' })
  )
  const capture = getRuntimeStreamDiagnostics()!
  expect(capture.eventCount).toBe(2)
  expect(capture.events['native:response.output_text.delta'].count).toBe(1)
  expect(capture.events['response.output_text.delta'].count).toBe(1)
  expect(JSON.stringify(getRuntimeStreamDiagnostics())).not.toContain('private')
  unsubscribe()
})

test('captures actual stream dispatch timing without payloads or identities', () => {
  const listeners = new Map<string, (payload: unknown) => void>()
  const socket = {
    connected: true,
    emit: vi.fn(),
    on: (event: string, listener: (payload: unknown) => void) => listeners.set(event, listener),
    off: vi.fn(),
  }
  const onChatChunk = vi.fn()
  const unsubscribe = createChatStream(socket).subscribe({ onChatChunk })
  startRuntimeStreamDiagnostics()
  listeners.get('response.output_text.delta')!({
    deviceId: 'private-device',
    taskId: 'private-task',
    subtaskId: 'private-turn',
    data: { delta: 'private-message', offset: 0 },
  })
  expect(onChatChunk).toHaveBeenCalledWith(expect.objectContaining({ content: 'private-message' }))
  const snapshot = getRuntimeStreamDiagnostics()!
  expect(snapshot.eventCount).toBe(1)
  expect(snapshot.events['response.output_text.delta']).toMatchObject({ count: 1 })
  expect(snapshot.events['response.output_text.delta'].elapsedMs).toBeGreaterThanOrEqual(0)
  expect(JSON.stringify(snapshot)).not.toContain('private')
  snapshot.events['response.output_text.delta'].count = 99
  expect(getRuntimeStreamDiagnostics()!.events['response.output_text.delta'].count).toBe(1)
  unsubscribe()
})

test('keeps timing checkpoints bounded during a large stream and stops recording on request', () => {
  startRuntimeStreamDiagnostics()
  const apply = vi.fn()
  for (let index = 0; index < 6000; index++) {
    measureRuntimeStreamEvent('response.output_text.delta', apply)
  }
  expect(getRuntimeStreamDiagnostics()!.eventCount).toBe(6000)
  expect(getRuntimeStreamDiagnostics()!.checkpoints).toHaveLength(32)
  stopRuntimeStreamDiagnostics()
  measureRuntimeStreamEvent('response.output_text.delta', apply)
  expect(apply).toHaveBeenCalledTimes(6001)
  expect(getRuntimeStreamDiagnostics()!.eventCount).toBe(6000)
  expect(getRuntimeStreamDiagnostics()!.finishedAt).not.toBeNull()
})

test('records failed dispatch timing without consuming or logging its exception', () => {
  startRuntimeStreamDiagnostics()
  const failure = new Error('private-error')
  expect(() =>
    measureRuntimeStreamEvent('response.output_text.delta', () => {
      throw failure
    })
  ).toThrow(failure)
  expect(getRuntimeStreamDiagnostics()!.eventCount).toBe(1)
  expect(JSON.stringify(getRuntimeStreamDiagnostics())).not.toContain('private')
})

test('does not retain arbitrary event labels and resets the previous capture', () => {
  startRuntimeStreamDiagnostics()
  const apply = vi.fn()
  measureRuntimeStreamEvent('private-event', apply)
  expect(apply).toHaveBeenCalledOnce()
  expect(getRuntimeStreamDiagnostics()!.eventCount).toBe(0)
  measureRuntimeStreamEvent('response.created', apply)
  startRuntimeStreamDiagnostics()
  expect(getRuntimeStreamDiagnostics()!.events).toEqual({})
})
