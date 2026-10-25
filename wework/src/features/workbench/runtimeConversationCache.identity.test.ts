import { afterEach, describe, expect, it, vi } from 'vitest'
import type { DeviceInfo, RuntimeTaskAddress } from '@/types/api'
import type { RuntimeConversationTurn, RuntimePaneQueuedMessage } from '@/types/workbench'
import {
  applyRuntimeConversationAction,
  adoptRuntimeConversationThread,
  applyRuntimeConversationSubagentActivity,
  beginRuntimeConversationHydration,
  cacheConversationScrollSnapshot,
  cacheRuntimeConversationQueuedMessages,
  clearRuntimeConversationCacheForTests,
  completeRuntimeConversationHydration,
  getConversationScrollSnapshot,
  getRuntimeConversationCacheStats,
  getRuntimeConversationMessages,
  getRuntimeConversationMetadata,
  getRuntimeConversationQueuedMessages,
  getRuntimeConversationTurns,
  replaceRuntimeConversationSnapshot,
  runtimeConversationKey,
  setRuntimeConversationGoal,
  subscribeRuntimeConversation,
  syncRuntimeConversationDeviceAliases,
} from './runtimeConversationCache'

const canonical = { deviceId: 'electron-local', taskId: 'task-1' }
const alias = { ...canonical, deviceId: 'app-record-65' }
const device: DeviceInfo = {
  id: 65,
  device_id: canonical.deviceId,
  socket_device_id: alias.deviceId,
  runtime_instance_id: 'runtime-local',
  name: 'Local Executor',
  status: 'online',
  is_default: true,
  device_type: 'local',
  bind_shell: 'codex',
}

function turns(content: string, status: RuntimeConversationTurn['status'] = 'streaming') {
  return [
    {
      id: 'turn-1',
      status,
      items: [{ id: 'text-1', type: 'assistant_text', content }],
    },
  ] satisfies RuntimeConversationTurn[]
}

function queue(id: string, content = id): RuntimePaneQueuedMessage {
  return { id, content, status: 'queued', createdAt: '2026-10-16T00:00:00Z' }
}

describe('runtime conversation identity synchronization', () => {
  it('does not merge old native thread positions when device aliases converge', () => {
    adoptRuntimeConversationThread(alias, 'old-thread')
    adoptRuntimeConversationThread(canonical, 'current-thread')
    replaceRuntimeConversationSnapshot(alias, turns('Old branch', 'done'))
    replaceRuntimeConversationSnapshot(canonical, turns('Current branch', 'done'))
    syncRuntimeConversationDeviceAliases([device])
    expect(getRuntimeConversationMessages(canonical).map(message => message.content)).toEqual([
      'Current branch',
    ])
  })
  afterEach(() => {
    clearRuntimeConversationCacheForTests()
    vi.useRealTimers()
  })

  it('notifies migrated subscribers when the follow-up queue changes or clears', () => {
    cacheRuntimeConversationQueuedMessages(alias, [queue('original')])
    const listener = vi.fn()
    const unsubscribe = subscribeRuntimeConversation(alias, listener)
    syncRuntimeConversationDeviceAliases([device])
    listener.mockClear()

    cacheRuntimeConversationQueuedMessages(canonical, [queue('reply')])

    expect(listener).toHaveBeenCalledTimes(1)
    expect(getRuntimeConversationQueuedMessages(alias)).toEqual([queue('reply')])

    cacheRuntimeConversationQueuedMessages(alias, [])

    expect(listener).toHaveBeenCalledTimes(2)
    expect(getRuntimeConversationQueuedMessages(canonical)).toEqual([])
    unsubscribe()
  })

  it('merges existing state without replacing a completed canonical turn with stale streaming', () => {
    replaceRuntimeConversationSnapshot(alias, turns('Old progress'))
    replaceRuntimeConversationSnapshot(canonical, turns('Completed result', 'done'))
    cacheRuntimeConversationQueuedMessages(alias, [queue('raw-only'), queue('shared', 'Old draft')])
    cacheRuntimeConversationQueuedMessages(canonical, [
      queue('canonical-only'),
      queue('shared', 'Updated draft'),
    ])
    cacheConversationScrollSnapshot(runtimeConversationKey(alias), {
      distanceFromBottomPx: 125,
      pinnedToBottom: false,
    })
    const goal = {
      threadId: 'thread-1',
      objective: 'Check CPU',
      status: 'active' as const,
      tokenBudget: null,
      tokensUsed: 0,
      timeUsedSeconds: 0,
      createdAt: 1,
      updatedAt: 2,
    }
    setRuntimeConversationGoal(canonical, goal)
    setRuntimeConversationGoal(alias, { ...goal, status: 'complete', updatedAt: 3 })
    applyRuntimeConversationSubagentActivity(alias, {
      agentPath: 'worker',
      status: 'running',
      occurredAtMs: 1,
    })
    applyRuntimeConversationSubagentActivity(canonical, {
      agentPath: 'worker',
      status: 'done',
      occurredAtMs: 2,
    })
    const separateTask: RuntimeTaskAddress = { ...alias, taskId: 'task-2' }
    replaceRuntimeConversationSnapshot(separateTask, turns('Independent task'))

    syncRuntimeConversationDeviceAliases([device])

    expect(getRuntimeConversationTurns(alias)).toEqual(turns('Completed result', 'done'))
    expect(getRuntimeConversationTurns(alias)).toBe(getRuntimeConversationTurns(canonical))
    expect(getRuntimeConversationQueuedMessages(canonical)).toEqual([
      queue('raw-only'),
      queue('shared', 'Updated draft'),
      queue('canonical-only'),
    ])
    expect(getRuntimeConversationMetadata(canonical).goal?.status).toBe('complete')
    expect(getRuntimeConversationMetadata(canonical).subagentStatuses[0]?.status).toBe('done')
    expect(getConversationScrollSnapshot(runtimeConversationKey(canonical))).toEqual({
      distanceFromBottomPx: 125,
      pinnedToBottom: false,
    })
    expect(getRuntimeConversationMessages(separateTask)[0]?.content).toBe('Independent task')
    expect(getRuntimeConversationCacheStats().messageEntries).toBe(2)
  })

  it('moves existing subscriptions and releases retention when they unsubscribe after alias sync', () => {
    vi.useFakeTimers()
    replaceRuntimeConversationSnapshot(alias, turns('Old result', 'done'))
    const listener = vi.fn()
    const unsubscribe = subscribeRuntimeConversation(alias, listener)

    syncRuntimeConversationDeviceAliases([device])
    expect(listener).toHaveBeenCalledTimes(1)
    syncRuntimeConversationDeviceAliases([device])
    expect(listener).toHaveBeenCalledTimes(1)

    replaceRuntimeConversationSnapshot(canonical, turns('New result', 'done'))
    expect(listener).toHaveBeenCalledTimes(2)
    unsubscribe()
    vi.advanceTimersByTime(5 * 60 * 1000 + 1)

    expect(getRuntimeConversationMessages(canonical)).toEqual([])
    expect(getRuntimeConversationCacheStats().messageEntries).toBe(0)
    expect(listener).toHaveBeenCalledTimes(2)
    replaceRuntimeConversationSnapshot(canonical, turns('After unmount', 'done'))
    expect(listener).toHaveBeenCalledTimes(2)
  })

  it('unsubscribes from its owned cache when a previously unique address becomes ambiguous', () => {
    vi.useFakeTimers()
    syncRuntimeConversationDeviceAliases([device])
    replaceRuntimeConversationSnapshot(alias, turns('Original result', 'done'))
    const listener = vi.fn()
    const unsubscribe = subscribeRuntimeConversation(alias, listener)
    syncRuntimeConversationDeviceAliases([
      device,
      {
        ...device,
        id: 66,
        device_id: 'remote-device',
        app_device_id: alias.deviceId,
        runtime_instance_id: 'other-runtime',
        socket_device_id: 'app-record-66',
        device_type: 'remote',
      },
    ])
    expect(runtimeConversationKey(alias)).not.toBe(runtimeConversationKey(canonical))

    unsubscribe()
    replaceRuntimeConversationSnapshot(canonical, turns('Later result', 'done'))

    expect(listener).not.toHaveBeenCalled()
    vi.advanceTimersByTime(5 * 60 * 1000 + 1)
    expect(getRuntimeConversationMessages(canonical)).toEqual([])
    expect(getRuntimeConversationCacheStats().messageEntries).toBe(0)
  })

  it.each([alias, canonical])(
    'keeps the latest streaming text and queue update from $deviceId',
    latest => {
      const older = latest === alias ? canonical : alias
      replaceRuntimeConversationSnapshot(older, turns('Old progress'))
      cacheRuntimeConversationQueuedMessages(older, [queue('shared', 'Old draft')])
      replaceRuntimeConversationSnapshot(latest, turns('New progress'))
      cacheRuntimeConversationQueuedMessages(latest, [queue('shared', 'Updated draft')])

      syncRuntimeConversationDeviceAliases([device])

      expect(getRuntimeConversationMessages(canonical)[0]?.content).toBe('New progress')
      expect(getRuntimeConversationQueuedMessages(canonical)[0]?.content).toBe('Updated draft')
    }
  )

  it('keeps a newer cleared goal when the old alias still contains a goal', () => {
    setRuntimeConversationGoal(alias, {
      threadId: 'thread-1',
      objective: 'Old goal',
      status: 'active',
      tokenBudget: null,
      tokensUsed: 0,
      timeUsedSeconds: 0,
      createdAt: 1,
      updatedAt: 2,
    })
    setRuntimeConversationGoal(canonical, null)

    syncRuntimeConversationDeviceAliases([device])

    expect(getRuntimeConversationMetadata(canonical).goal).toBeNull()
  })

  it('removes an old sending message once the canonical transcript has accepted it', () => {
    cacheRuntimeConversationQueuedMessages(alias, [
      { ...queue('accepted'), status: 'sending', deliveryMode: 'message' },
      queue('next'),
    ])
    replaceRuntimeConversationSnapshot(canonical, [
      {
        id: 'turn-1',
        clientUserMessageId: 'accepted',
        status: 'streaming',
        items: [],
      },
    ])

    syncRuntimeConversationDeviceAliases([device])

    expect(getRuntimeConversationQueuedMessages(canonical)).toEqual([queue('next')])
  })

  it('preserves an in-flight hydration token and buffered events when its address gains an alias', () => {
    const token = beginRuntimeConversationHydration(alias)
    applyRuntimeConversationAction(alias, {
      type: 'user_added',
      message: {
        id: 'user-1',
        role: 'user',
        content: 'Follow up',
        status: 'done',
        createdAt: '2026-10-16T00:00:00Z',
      },
    })

    syncRuntimeConversationDeviceAliases([device])
    completeRuntimeConversationHydration(alias, token, turns('History', 'done'))

    expect(getRuntimeConversationMessages(canonical).map(message => message.content)).toEqual([
      'History',
      'Follow up',
    ])
  })

  it('keeps canonical hydration ownership when both aliases had an in-flight request', () => {
    const oldToken = beginRuntimeConversationHydration(alias)
    const token = beginRuntimeConversationHydration(canonical)
    applyRuntimeConversationAction(alias, {
      type: 'user_added',
      message: {
        id: 'user-1',
        role: 'user',
        content: 'Buffered follow up',
        status: 'done',
        createdAt: '2026-10-16T00:00:00Z',
      },
    })

    syncRuntimeConversationDeviceAliases([device])
    const liveTurns = getRuntimeConversationTurns(canonical)
    expect(getRuntimeConversationMessages(canonical).map(message => message.content)).toEqual([
      'Buffered follow up',
    ])
    completeRuntimeConversationHydration(alias, oldToken, turns('Stale request', 'done'))
    expect(getRuntimeConversationTurns(canonical)).toBe(liveTurns)
    completeRuntimeConversationHydration(canonical, token, turns('Current request', 'done'))

    expect(getRuntimeConversationMessages(canonical).map(message => message.content)).toEqual([
      'Current request',
      'Buffered follow up',
    ])
  })

  it('does not merge devices from different runtimes when their advertised aliases collide', () => {
    const otherDevice = {
      ...device,
      id: 66,
      device_id: 'remote-device',
      app_device_id: canonical.deviceId,
      socket_device_id: 'app-record-66',
      runtime_instance_id: 'other-runtime',
      device_type: 'remote',
    } satisfies DeviceInfo
    const other = { ...canonical, deviceId: otherDevice.device_id }
    replaceRuntimeConversationSnapshot(canonical, turns('Local task'))
    replaceRuntimeConversationSnapshot(other, turns('Remote task'))

    syncRuntimeConversationDeviceAliases([device, otherDevice])

    expect(runtimeConversationKey(canonical)).not.toBe(runtimeConversationKey(other))
    expect(getRuntimeConversationMessages(canonical)[0]?.content).toBe('Local task')
    expect(getRuntimeConversationMessages(other)[0]?.content).toBe('Remote task')
    expect(getRuntimeConversationCacheStats().messageEntries).toBe(2)
  })
})
