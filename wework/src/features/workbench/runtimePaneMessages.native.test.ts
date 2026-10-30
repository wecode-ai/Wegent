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

function runningTask(turnId = 'turn-1'): RuntimeTaskSummary {
  const task = settledTask('succeeded')
  task.executionState = {
    ...task.executionState!,
    phase: 'running',
    turnId,
    latestTurnId: turnId,
    outcome: null,
  }
  return task
}

describe('native turn content settlement', () => {
  afterEach(() => vi.useRealTimers())
  test('does not settle native content from an RPC result before its native boundary', () => {
    let turns: RuntimeConversationTurn[] = []
    const onAssistantSettled = vi.fn()
    const handlers = createRuntimeTaskStreamHandlers(address, {
      onAssistantSettled,
      onMessageAction: action => {
        turns = reduceRuntimeConversationTurns(turns, action)
      },
    })
    handlers.onChatStart?.({
      ...address,
      subtaskId: 'turn-1',
      clientUserMessageId: 'client-user',
      task: runningTask(),
    })
    handlers.onChatDone?.({
      ...address,
      subtaskId: 'turn-1',
      task: runningTask(),
      result: { turnId: 'turn-1', value: 'RPC result' },
    })
    expect(onAssistantSettled).not.toHaveBeenCalled()
    handlers.onRuntimeTurnUpdated?.({
      ...address,
      status: 'started',
      turnId: 'turn-1',
      task: runningTask(),
    })
    handlers.onChatChunk?.({
      ...address,
      subtaskId: 'turn-1',
      itemId: 'native-text-1',
      content: 'Native content',
    })
    expect(turns[0].status).toBe('streaming')
    expect(turns[0].items).toEqual([
      expect.objectContaining({ type: 'assistant_text', content: 'Native content' }),
    ])
    handlers.onRuntimeTurnUpdated?.({
      ...address,
      status: 'settled',
      turnId: 'turn-1',
      task: settledTask('succeeded'),
    })
    expect(turns[0].status).toBe('done')
    expect(onAssistantSettled).toHaveBeenCalledOnce()
  })

  test.each([false, true])(
    'keeps content before RPC user binding, already settled: %s',
    settled => {
      let turns: RuntimeConversationTurn[] = []
      const onAssistantStart = vi.fn()
      const handlers = createRuntimeTaskStreamHandlers(address, {
        onAssistantStart,
        onMessageAction: action => {
          turns = reduceRuntimeConversationTurns(turns, action)
        },
      })
      turns = reduceRuntimeConversationTurns(turns, {
        type: 'user_added',
        message: {
          id: 'client-user',
          role: 'user',
          content: 'Original prompt',
          status: 'done',
          createdAt: '',
        },
      })
      handlers.onRuntimeTurnUpdated?.({
        ...address,
        status: 'started',
        turnId: 'turn-1',
        task: runningTask(),
      })
      handlers.onChatChunk?.({
        ...address,
        subtaskId: 'turn-1',
        itemId: 'text-1',
        content: 'Early native output',
      })
      if (settled)
        handlers.onRuntimeTurnUpdated?.({
          ...address,
          status: 'settled',
          turnId: 'turn-1',
          task: settledTask('succeeded'),
        })
      handlers.onChatStart?.({
        ...address,
        subtaskId: 'turn-1',
        clientUserMessageId: 'client-user',
        task: settled ? settledTask('succeeded') : runningTask(),
      })
      expect(turns).toHaveLength(1)
      expect(turns[0].id).toBe('turn-1')
      expect(turns[0].status).toBe(settled ? 'done' : 'streaming')
      expect(
        turns[0].items.some(
          item => item.type === 'assistant_text' && item.content === 'Early native output'
        )
      ).toBe(true)
      expect(
        turns[0].items.some(
          item => item.type === 'user_message' && item.message.id === 'client-user'
        )
      ).toBe(true)
      expect(onAssistantStart).toHaveBeenCalledTimes(1)
    }
  )

  test('does not attach an optimistic user to an autonomous native turn', () => {
    let turns = reduceRuntimeConversationTurns([], {
      type: 'user_added',
      message: {
        id: 'pending-user',
        role: 'user',
        content: 'Pending prompt',
        status: 'done',
        createdAt: '',
      },
    })
    const handlers = createRuntimeTaskStreamHandlers(address, {
      onMessageAction: action => {
        turns = reduceRuntimeConversationTurns(turns, action)
      },
    })
    handlers.onRuntimeTurnUpdated?.({
      ...address,
      status: 'started',
      turnId: 'auto-turn',
      task: runningTask('auto-turn'),
    })
    expect(turns).toHaveLength(2)
    expect(turns.find(turn => turn.id === 'auto-turn')?.items).toEqual([])
    expect(turns.find(turn => turn.clientUserMessageId === 'pending-user')?.id).toBeNull()
  })

  test('binds a late generated user without moving its completed turn after a continuation', () => {
    let turns: RuntimeConversationTurn[] = []
    const handlers = createRuntimeTaskStreamHandlers(address, {
      onMessageAction: action => {
        turns = reduceRuntimeConversationTurns(turns, action)
      },
    })
    handlers.onRuntimeTurnUpdated?.({
      ...address,
      status: 'started',
      turnId: 'turn-1',
      task: runningTask(),
    })
    handlers.onChatChunk?.({
      ...address,
      subtaskId: 'turn-1',
      itemId: 'text-1',
      content: 'First output',
    })
    handlers.onRuntimeTurnUpdated?.({
      ...address,
      status: 'settled',
      turnId: 'turn-1',
      task: settledTask('succeeded'),
    })
    handlers.onRuntimeTurnUpdated?.({
      ...address,
      status: 'started',
      turnId: 'turn-2',
      task: runningTask('turn-2'),
    })
    handlers.onChatStart?.({
      ...address,
      subtaskId: 'turn-1',
      task: runningTask('turn-2'),
      runtimeGeneratedUserMessage: {
        id: 'generated-user',
        message: 'Generated prompt',
        createdAt: 1000,
        source: {},
      },
    })
    expect(turns.map(turn => turn.id)).toEqual(['turn-1', 'turn-2'])
    expect(turns[0].status).toBe('done')
    expect(
      turns[0].items.some(
        item => item.type === 'user_message' && item.message.content === 'Generated prompt'
      )
    ).toBe(true)
  })
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
