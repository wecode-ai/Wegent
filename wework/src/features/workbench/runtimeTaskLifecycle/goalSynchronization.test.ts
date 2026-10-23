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

test('replaces a millisecond optimistic Goal with a same-second native blocked Goal', () => {
  const store = new RuntimeTaskLifecycleStore('goal-sync-pending')
  const startedAt = 1_792_770_994_048
  const nativeTimestamp = Math.floor(startedAt / 1000) * 1000
  syncRuntimeGoal(store, address, {
    ...goal,
    threadId: 'pending',
    createdAt: startedAt,
    updatedAt: startedAt,
  })
  const nativeGoal: RuntimeGoal = {
    ...goal,
    createdAt: nativeTimestamp,
    updatedAt: nativeTimestamp,
  }
  syncRuntimeGoal(store, address, nativeGoal)
  const blockedGoal: RuntimeGoal = { ...nativeGoal, status: 'blocked' }

  const accepted = syncRuntimeGoal(store, address, blockedGoal)

  expect(accepted).toEqual(blockedGoal)
  expect(getRuntimeConversationMetadata(address).goal).toEqual(blockedGoal)
  expect(store.getTask(address)?.goalStatus).toBe('blocked')
})

test.each(['active', 'blocked', 'paused', 'complete'] as const)(
  'accepts the first authoritative %s Goal without requiring an active event first',
  status => {
    const store = new RuntimeTaskLifecycleStore('goal-sync-authority')
    const createdAt = 1_792_770_994_048
    syncRuntimeGoal(store, address, {
      ...goal,
      threadId: 'pending',
      createdAt,
      updatedAt: createdAt,
    })
    const nativeGoal: RuntimeGoal = {
      ...goal,
      status,
      createdAt: 1_792_770_994_000,
      updatedAt: 1_792_770_994_000,
    }

    expect(syncRuntimeGoal(store, address, nativeGoal)).toEqual(nativeGoal)
    expect(store.getTask(address)?.goalStatus).toBe(status)

    const staleGoal: RuntimeGoal = { ...nativeGoal, status: 'active', updatedAt: createdAt - 1000 }
    expect(syncRuntimeGoal(store, address, staleGoal)).toEqual(nativeGoal)
    expect(store.getTask(address)?.goalStatus).toBe(status)
  }
)

test.each(['creation', 'objective', 'budget'] as const)(
  'does not replace a newer optimistic Goal with a mismatched native %s',
  mismatch => {
    const store = new RuntimeTaskLifecycleStore('goal-sync-other-goal')
    const createdAt = 1_792_770_994_048
    const pendingGoal: RuntimeGoal = {
      ...goal,
      threadId: 'pending',
      createdAt,
      updatedAt: createdAt,
    }
    const nativeGoal: RuntimeGoal = {
      ...goal,
      status: 'complete',
      createdAt: 1_792_770_994_000,
      updatedAt: 1_792_770_994_000,
      ...(mismatch === 'creation' ? { createdAt: 1_792_770_993_000 } : {}),
      ...(mismatch === 'objective' ? { objective: 'An earlier objective' } : {}),
      ...(mismatch === 'budget' ? { tokenBudget: 1000 } : {}),
    }
    syncRuntimeGoal(store, address, pendingGoal)

    expect(syncRuntimeGoal(store, address, nativeGoal)).toEqual(pendingGoal)
    expect(store.getTask(address)?.goalStatus).toBe('active')
  }
)
