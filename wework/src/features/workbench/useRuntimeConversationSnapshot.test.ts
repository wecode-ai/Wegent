import { act, renderHook } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
import {
  applyRuntimeConversationAction,
  clearRuntimeConversationCacheForTests,
  getRuntimeConversationTurns,
  cacheRuntimeConversationQueuedMessages,
  cacheRuntimeConversationQueuePaused,
  setRuntimeConversationTaskPlan,
} from './runtimeConversationCache'
import {
  useRuntimeConversationMetadata,
  useRuntimeConversationQueue,
  useRuntimeConversationSnapshot,
} from './useRuntimeConversationSnapshot'

const first = { deviceId: 'device', taskId: 'first' }
const second = { deviceId: 'device', taskId: 'second' }
function start(address: typeof first, content: string) {
  applyRuntimeConversationAction(address, { type: 'assistant_started', subtaskId: address.taskId })
  applyRuntimeConversationAction(address, {
    type: 'assistant_chunk',
    subtaskId: address.taskId,
    itemId: 'reply',
    content,
    contentMode: 'snapshot',
  })
}
afterEach(clearRuntimeConversationCacheForTests)

test('reads queue and metadata changes directly and switches their owner synchronously', () => {
  cacheRuntimeConversationQueuedMessages(first, [
    { id: 'queued', content: 'Follow up', status: 'queued', createdAt: '2026-11-06T00:00:00Z' },
  ])
  cacheRuntimeConversationQueuePaused(first, true)
  setRuntimeConversationTaskPlan(first, {
    ...first,
    turnId: 'turn',
    plan: [{ step: 'Implement', status: 'inProgress' }],
  })
  const { result, rerender } = renderHook(
    ({ address }) => ({
      queue: useRuntimeConversationQueue(address),
      metadata: useRuntimeConversationMetadata(address),
    }),
    { initialProps: { address: first as typeof first | null } }
  )
  expect(result.current.queue.messages[0].content).toBe('Follow up')
  expect(result.current.queue.paused).toBe(true)
  expect(result.current.metadata.taskPlan?.turnId).toBe('turn')
  rerender({ address: second })
  expect(result.current.queue).toEqual({ messages: [], paused: false })
  expect(result.current.metadata.taskPlan).toBeNull()
  act(() => cacheRuntimeConversationQueuePaused(second, true))
  expect(result.current.queue.paused).toBe(true)
  rerender({ address: null })
  expect(result.current.queue).toEqual({ messages: [], paused: false })
  expect(result.current.metadata.taskPlan).toBeNull()
  rerender({ address: first })
  expect(result.current.queue.messages[0].id).toBe('queued')
})

test('switches snapshots in the same render and retains background updates for the previous task', () => {
  start(first, 'First task')
  start(second, 'Second task')
  const { result, rerender } = renderHook(
    ({ address }) => useRuntimeConversationSnapshot(address),
    {
      initialProps: { address: first },
    }
  )
  expect(result.current.messages[0].content).toBe('First task')
  rerender({ address: second })
  expect(result.current.messages[0].content).toBe('Second task')
  act(() =>
    applyRuntimeConversationAction(first, {
      type: 'assistant_chunk',
      subtaskId: first.taskId,
      itemId: 'reply',
      content: 'First updated',
      contentMode: 'snapshot',
    })
  )
  expect(result.current.messages[0].content).toBe('Second task')
  rerender({ address: first })
  expect(result.current.messages[0].content).toBe('First updated')
})

test('coalesces structural stream changes without delaying the shared cache', () => {
  const frames = new Map<number, FrameRequestCallback>()
  let sequence = 0
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    frames.set(++sequence, callback)
    return sequence
  })
  vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id))
  try {
    start(first, 'Initial')
    let renders = 0
    const { result, unmount } = renderHook(() => {
      renders += 1
      return useRuntimeConversationSnapshot(first)
    })
    const before = renders
    for (let index = 0; index < 20; index += 1) {
      act(() =>
        applyRuntimeConversationAction(first, {
          type: 'assistant_started',
          subtaskId: 'turn-' + index,
        })
      )
    }
    expect(renders).toBe(before)
    expect(getRuntimeConversationTurns(first)).toHaveLength(21)
    act(() => {
      for (const [id, callback] of [...frames]) {
        frames.delete(id)
        callback(0)
      }
    })
    expect(result.current.turns).toHaveLength(21)
    expect(renders).toBe(before + 1)
    unmount()
  } finally {
    clearRuntimeConversationCacheForTests()
    vi.unstubAllGlobals()
  }
})
