import { afterEach, describe, expect, test } from 'vitest'
import {
  applyRuntimeConversationAction,
  cacheRuntimeConversationMessages,
  cacheConversationScrollSnapshot,
  cacheConversationVirtualMeasurements,
  clearRuntimeConversationCacheForTests,
  evictRuntimeConversation,
  getConversationScrollSnapshot,
  getConversationVirtualMeasurements,
  getRuntimeConversationMessages,
} from './runtimeConversationCache'

const address = {
  deviceId: 'device-1',
  taskId: 'task-1',
  workspacePath: '/workspace/one',
}

describe('runtimeConversationCache', () => {
  afterEach(clearRuntimeConversationCacheForTests)

  test('keeps transcript data independently from a mounted pane', () => {
    cacheRuntimeConversationMessages(address, [
      {
        id: 'user-1',
        role: 'user',
        content: 'hello',
        status: 'done',
        createdAt: '2026-07-24T00:00:00.000Z',
      },
    ])

    expect(getRuntimeConversationMessages(address)).toHaveLength(1)
  })

  test('uses device and task identity across normalized workspace paths', () => {
    cacheRuntimeConversationMessages(address, [
      {
        id: 'user-1',
        role: 'user',
        content: 'stable identity',
        status: 'done',
        createdAt: '2026-07-24T00:00:00.000Z',
      },
    ])

    expect(
      getRuntimeConversationMessages({
        ...address,
        workspacePath: '/workspace/normalized-path',
      })
    ).toHaveLength(1)
  })

  test('continues reducing assistant stream events while the pane is unmounted', () => {
    applyRuntimeConversationAction(address, {
      type: 'assistant_started',
      taskId: 'task-1',
      subtaskId: 'subtask-1',
      shellType: 'Codex',
    })
    applyRuntimeConversationAction(address, {
      type: 'assistant_chunk',
      subtaskId: 'subtask-1',
      content: 'background output',
    })

    expect(getRuntimeConversationMessages(address)).toMatchObject([
      {
        role: 'assistant',
        content: 'background output',
        status: 'streaming',
      },
    ])
  })

  test('bounds cached transcripts when many conversations are opened', () => {
    for (let index = 0; index <= 50; index += 1) {
      cacheRuntimeConversationMessages({ ...address, taskId: `task-${index}` }, [
        {
          id: `user-${index}`,
          role: 'user',
          content: `message ${index}`,
          status: 'done',
          createdAt: '2026-07-24T00:00:00.000Z',
        },
      ])
    }

    expect(getRuntimeConversationMessages({ ...address, taskId: 'task-0' })).toEqual([])
    expect(getRuntimeConversationMessages({ ...address, taskId: 'task-50' })).toHaveLength(1)
  })

  test('evicts transcript and view state immediately when a task is archived', () => {
    cacheRuntimeConversationMessages(address, [
      {
        id: 'user-1',
        role: 'user',
        content: 'archived content',
        status: 'done',
        createdAt: '2026-07-24T00:00:00.000Z',
      },
    ])
    cacheConversationScrollSnapshot('device-1:task-1', {
      distanceFromBottomPx: 240,
      pinnedToBottom: false,
    })
    cacheConversationVirtualMeasurements('device-1:task-1', [
      { index: 0, key: 'user-1', start: 0, end: 120, size: 120, lane: 0 },
    ])

    evictRuntimeConversation(address)

    expect(getRuntimeConversationMessages(address)).toEqual([])
    expect(getConversationScrollSnapshot('device-1:task-1')).toBeUndefined()
    expect(getConversationVirtualMeasurements('device-1:task-1')).toBeUndefined()
  })
})
