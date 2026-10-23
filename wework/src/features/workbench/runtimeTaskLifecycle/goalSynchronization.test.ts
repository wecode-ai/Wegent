import { afterEach, expect, test } from 'vitest'
import type { RuntimeGoal } from '@/types/api'
import {
  clearRuntimeConversationCacheForTests,
  getRuntimeConversationMetadata,
} from '../runtimeConversationCache'
import {
  createRuntimeTaskLifecycleOwnershipView,
  RuntimeTaskLifecycleStore,
} from './RuntimeTaskLifecycleStore'
import { syncRuntimeGoal } from './goalSynchronization'

const address = { deviceId: 'local-device', taskId: 'goal-sync-task' }
const goal: RuntimeGoal = {
  threadId: 'thread-1',
  objective: 'Finish the fix',
  status: 'active',
  tokenBudget: null,
  tokensUsed: 0,
  timeUsedSeconds: 10,
  createdAt: 1,
  updatedAt: 3,
}

afterEach(() => clearRuntimeConversationCacheForTests())

test('projects the accepted Goal state into the lifecycle after stale and equal-time updates', () => {
  const store = new RuntimeTaskLifecycleStore('goal-sync')
  const updates: Array<RuntimeGoal | null> = [
    goal,
    { ...goal, status: 'blocked' },
    { ...goal, updatedAt: 2 },
    { ...goal, status: 'paused', updatedAt: 2 },
    goal,
    { ...goal, status: 'complete', updatedAt: 4 },
    goal,
    null,
  ]
  const expected = [
    'active',
    'blocked',
    'blocked',
    'blocked',
    'active',
    'complete',
    'complete',
    null,
  ]

  updates.forEach((update, index) => {
    const accepted = syncRuntimeGoal(store, address, update)
    expect(accepted?.status ?? null).toBe(expected[index])
    expect(getRuntimeConversationMetadata(address).goal).toBe(accepted)
    expect(store.getTask(address)?.goalStatus).toBe(expected[index])
  })
})

test('updates conversation content from an inactive pane without writing task lifecycle', () => {
  const store = new RuntimeTaskLifecycleStore('goal-sync-owner')
  syncRuntimeGoal(store, address, goal)
  const inactivePane = createRuntimeTaskLifecycleOwnershipView(store, () => false)

  syncRuntimeGoal(inactivePane, address, { ...goal, status: 'blocked', updatedAt: 4 })

  expect(getRuntimeConversationMetadata(address).goal?.status).toBe('blocked')
  expect(store.getTask(address)?.goalStatus).toBe('active')
  syncRuntimeGoal(store, address, goal)
  expect(store.getTask(address)?.goalStatus).toBe('blocked')
})

test('replaces the pending Goal clock with the native Goal before projecting lifecycle', () => {
  const store = new RuntimeTaskLifecycleStore('goal-sync-pending')
  const nativeGoal = { ...goal, createdAt: 1792759113000, updatedAt: 1792759113000 }
  syncRuntimeGoal(store, address, {
    ...nativeGoal,
    threadId: 'pending',
    updatedAt: 1792759113093,
  })

  syncRuntimeGoal(store, address, { ...nativeGoal, status: 'blocked' })

  expect(getRuntimeConversationMetadata(address).goal).toEqual({
    ...nativeGoal,
    status: 'blocked',
  })
  expect(store.getTask(address)?.goalStatus).toBe('blocked')
})
