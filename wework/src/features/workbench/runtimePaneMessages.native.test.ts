import { afterEach, describe, expect, test, vi } from 'vitest'
import type { RuntimeTaskSummary } from '@/types/api'
import type { RuntimeConversationTurn } from '@/types/workbench'
import { createRuntimeTaskStreamHandlers } from './runtimePaneMessages'
import { reduceRuntimeConversationTurns } from './runtimeConversationTurns'

const address = { deviceId: 'device-1', taskId: 'task-1' }

function settledTask(outcome: 'succeeded' | 'failed' | 'cancelled'): RuntimeTaskSummary {
  return {
    taskId: address.taskId,
    workspacePath: '/project',
    title: 'Native',
    runtime: 'codex',
    executionState: {
      revision: '1793351778604000000',
      phase: 'continuing',
      turnId: null,
      latestTurnId: 'turn-1',
      outcome,
      startedAt: 1000,
      completedAt: 2000,
      durationMs: 1000,
      error: outcome === 'failed' ? 'Native failure reason' : null,
    },
  }
}

describe('native turn content settlement', () => {
  afterEach(() => vi.useRealTimers())
  test.each(['succeeded', 'failed', 'cancelled'] as const)(
    'settles %s native turns without waiting for the owning RPC to return',
    outcome => {
      vi.useFakeTimers()
      vi.setSystemTime(1000)
      let turns: RuntimeConversationTurn[] = []
      const handlers = createRuntimeTaskStreamHandlers(address, {
        onMessageAction: action => {
          turns = reduceRuntimeConversationTurns(turns, action)
        },
      })
      handlers.onChatStart?.({ ...address, subtaskId: 'turn-1' })
      handlers.onChatChunk?.({
        ...address,
        subtaskId: 'turn-1',
        itemId: 'text-1',
        content: 'Before ',
      })
      vi.setSystemTime(2000)
      handlers.onRuntimeTurnUpdated?.({
        ...address,
        turnId: 'turn-1',
        status: 'settled',
        task: settledTask(outcome),
      })
      const expected = outcome === 'succeeded' ? 'done' : outcome
      expect(turns[0].status).toBe(expected)
      expect(turns[0].durationMs).toBe(1000)
      handlers.onChatChunk?.({
        ...address,
        subtaskId: 'turn-1',
        itemId: 'text-1',
        content: 'late text',
      })
      expect(turns[0].status).toBe(expected)
      expect(
        turns[0].items.some(
          item => item.type === 'assistant_text' && item.content.includes('Before ')
        )
      ).toBe(true)
    }
  )

  test('does not alias an older native completion to the active continuation', () => {
    const onAssistantSettled = vi.fn()
    const handlers = createRuntimeTaskStreamHandlers(address, {
      onMessageAction: vi.fn(),
      onAssistantSettled,
    })
    handlers.onChatStart?.({ ...address, subtaskId: 'turn-2' })
    handlers.onRuntimeTurnUpdated?.({
      ...address,
      turnId: 'turn-1',
      status: 'settled',
      task: settledTask('succeeded'),
    })
    expect(onAssistantSettled).toHaveBeenCalledWith('turn-1', 'succeeded')
    expect(onAssistantSettled).not.toHaveBeenCalledWith('turn-2', expect.anything())
  })
})
