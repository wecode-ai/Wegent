import { afterEach, expect, test, vi } from 'vitest'
import {
  applyRuntimeConversationAction,
  clearRuntimeConversationCacheForTests,
  getRuntimeConversationTurns,
  subscribeRuntimeConversation,
} from './runtimeConversationCache'

afterEach(() => {
  clearRuntimeConversationCacheForTests()
  vi.useRealTimers()
})

test('coalesces native block bursts while preserving bounded item order and terminal state', () => {
  const address = { deviceId: 'device-1', taskId: 'task-1', workspacePath: '/workspace/one' }
  vi.useFakeTimers()
  applyRuntimeConversationAction(address, {
    type: 'assistant_started',
    taskId: address.taskId,
    subtaskId: 'burst-turn',
  })
  const notifications: Array<string | undefined> = []
  const unsubscribe = subscribeRuntimeConversation(address, action => {
    notifications.push(action?.type)
  })
  for (let index = 0; index < 520; index += 1) {
    // A native burst spans multiple paint frames; it must not render on each one.
    if (index > 0 && index % 100 === 0) vi.advanceTimersByTime(16)
    applyRuntimeConversationAction(address, {
      type: 'block_created',
      subtaskId: 'burst-turn',
      block: {
        id: `progress-${index}`,
        subtaskId: 'burst-turn',
        type: 'text',
        content: `progress ${index}`,
        status: 'streaming',
        createdAt: index,
      },
    })
    applyRuntimeConversationAction(address, {
      type: 'block_updated',
      subtaskId: 'burst-turn',
      blockId: `progress-${index}`,
      updates: { status: 'done' },
    })
  }
  expect(notifications).toEqual([])
  // Completed blocks use the existing 256-item visible-cache bound.
  expect(getRuntimeConversationTurns(address)[0].items.map(item => item.id)).toEqual(
    Array.from({ length: 520 }, (_, index) => `progress-${index}`).slice(-256)
  )
  vi.advanceTimersByTime(19)
  expect(notifications).toEqual([])
  vi.advanceTimersByTime(1)
  expect(notifications).toEqual([undefined])
  applyRuntimeConversationAction(address, { type: 'assistant_done', subtaskId: 'burst-turn' })
  expect(notifications).toEqual([undefined, 'assistant_done'])
  expect(getRuntimeConversationTurns(address)[0].status).toBe('done')
  vi.advanceTimersByTime(100)
  expect(notifications).toEqual([undefined, 'assistant_done'])
  unsubscribe()
})
