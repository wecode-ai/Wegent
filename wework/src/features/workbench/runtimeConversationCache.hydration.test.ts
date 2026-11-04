// @vitest-environment node

import { afterEach, describe, expect, test, vi } from 'vitest'
import type { RuntimeConversationTurn } from '@/types/workbench'
import {
  applyRuntimeConversationAction,
  beginRuntimeConversationHydration,
  clearRuntimeConversationCacheForTests,
  completeRuntimeConversationHydration,
  getRuntimeConversationTurns,
  replaceRuntimeConversationSnapshot,
  runtimeConversationSnapshotSettlesLatestTurn,
  subscribeRuntimeConversation,
} from './runtimeConversationCache'

const address = { deviceId: 'device-1', taskId: 'task-1' }
const oldSnapshot: RuntimeConversationTurn[] = [{ id: 'old-turn', status: 'done', items: [] }]

function bufferFollowUp() {
  applyRuntimeConversationAction(address, {
    type: 'user_added',
    message: {
      id: 'new-user',
      role: 'user',
      content: 'Continue the task',
      status: 'done',
      createdAt: '2026-10-21T00:00:00.000Z',
    },
  })
}

function bufferAssistantStarted() {
  applyRuntimeConversationAction(address, {
    type: 'assistant_started',
    subtaskId: 'new-turn',
    clientUserMessageId: 'new-user',
  })
}

describe('runtime conversation hydration settlement', () => {
  afterEach(clearRuntimeConversationCacheForTests)

  test('preserves a follow-up when an older completed transcript arrives during hydration', () => {
    replaceRuntimeConversationSnapshot(address, oldSnapshot)
    const token = beginRuntimeConversationHydration(address)
    bufferFollowUp()

    expect(runtimeConversationSnapshotSettlesLatestTurn(address, oldSnapshot)).toBe(false)
    bufferAssistantStarted()
    expect(runtimeConversationSnapshotSettlesLatestTurn(address, oldSnapshot)).toBe(false)

    completeRuntimeConversationHydration(address, token, oldSnapshot)

    expect(getRuntimeConversationTurns(address)).toMatchObject([
      { id: 'old-turn', status: 'done' },
      { id: 'new-turn', status: 'streaming', clientUserMessageId: 'new-user' },
    ])
  })

  test.each(['done', 'failed', 'cancelled'] as const)(
    'allows a %s snapshot to settle the buffered current turn',
    status => {
      replaceRuntimeConversationSnapshot(address, oldSnapshot)
      beginRuntimeConversationHydration(address)
      bufferFollowUp()
      bufferAssistantStarted()

      expect(
        runtimeConversationSnapshotSettlesLatestTurn(address, [
          { id: 'new-turn', status: 'streaming', items: [] },
        ])
      ).toBe(false)
      expect(
        runtimeConversationSnapshotSettlesLatestTurn(address, [
          { id: 'new-turn', status, items: [] },
        ])
      ).toBe(true)
    }
  )

  test('checks hydration settlement without changing live turns or republishing actions', () => {
    const token = beginRuntimeConversationHydration(address)
    const listener = vi.fn()
    const unsubscribe = subscribeRuntimeConversation(address, listener)
    bufferFollowUp()
    bufferAssistantStarted()
    applyRuntimeConversationAction(address, {
      type: 'assistant_done',
      subtaskId: 'new-turn',
      itemId: 'new-answer',
      content: 'Completed answer',
    })

    expect(listener.mock.calls.map(([action]) => action?.type)).toEqual([
      'user_added',
      'assistant_started',
      'assistant_done',
    ])
    const committedTurns = getRuntimeConversationTurns(address)
    listener.mockClear()

    expect(runtimeConversationSnapshotSettlesLatestTurn(address, [])).toBe(false)
    expect(
      runtimeConversationSnapshotSettlesLatestTurn(address, [
        { id: 'new-turn', status: 'done', items: [] },
      ])
    ).toBe(true)
    expect(getRuntimeConversationTurns(address)).toBe(committedTurns)
    expect(listener).not.toHaveBeenCalled()

    const messages = completeRuntimeConversationHydration(address, token, [])

    expect(messages).toMatchObject([
      { role: 'user', content: 'Continue the task' },
      { role: 'assistant', status: 'done', content: 'Completed answer' },
    ])
    expect(getRuntimeConversationTurns(address)).toHaveLength(1)
    expect(listener.mock.calls.map(([action]) => action?.type)).toEqual([undefined])
    unsubscribe()
  })

  test('keeps a command completion received while the active turn transcript is loading', () => {
    const snapshot: RuntimeConversationTurn[] = [
      {
        id: 'turn',
        status: 'streaming',
        items: [
          {
            id: 'command',
            type: 'block',
            block: {
              id: 'command',
              type: 'tool',
              toolName: 'exec_command',
              status: 'pending',
              createdAt: 1,
              renderPayload: { kind: 'command_execution', status: 'inProgress' },
            },
          },
        ],
      },
    ]
    replaceRuntimeConversationSnapshot(address, snapshot)
    const token = beginRuntimeConversationHydration(address)
    applyRuntimeConversationAction(address, {
      type: 'block_updated',
      subtaskId: 'turn',
      blockId: 'command',
      updates: {
        status: 'done',
        completedAt: 2,
        toolOutput: '/workspace',
        renderPayload: { kind: 'command_execution', status: 'completed', exitCode: 0 },
      },
    })
    completeRuntimeConversationHydration(address, token, snapshot)

    expect(getRuntimeConversationTurns(address)[0]).toMatchObject({
      status: 'streaming',
      items: [
        {
          id: 'command',
          block: {
            status: 'done',
            completedAt: 2,
            toolOutput: '/workspace',
            renderPayload: { status: 'completed', exitCode: 0 },
          },
        },
      ],
    })
  })

  test.each(['message', 'process-message'])(
    'preserves live classification as %s during an older transcript read',
    blockId => {
      const snapshot: RuntimeConversationTurn[] = [
        {
          id: 'turn',
          status: 'streaming',
          items: [{ id: 'message', type: 'assistant_text', content: 'Working on the task' }],
        },
      ]
      replaceRuntimeConversationSnapshot(address, snapshot)
      const token = beginRuntimeConversationHydration(address)
      applyRuntimeConversationAction(address, {
        type: 'block_created',
        subtaskId: 'turn',
        replaceAssistantTextItemId: 'message',
        block: {
          id: blockId,
          type: 'text',
          content: 'Working on the task',
          status: 'done',
          createdAt: 1,
        },
      })
      expect(getRuntimeConversationTurns(address)[0].items[0].type).toBe('block')

      completeRuntimeConversationHydration(address, token, snapshot)

      expect(getRuntimeConversationTurns(address)[0].items).toEqual([
        expect.objectContaining({
          id: blockId,
          type: 'block',
          block: expect.objectContaining({ type: 'text', status: 'done' }),
        }),
      ])
    }
  )
})
