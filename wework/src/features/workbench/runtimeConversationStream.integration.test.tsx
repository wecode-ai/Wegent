import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
import type { LocalExecutorEvent } from '@/desktop/localExecutor'
import type { RuntimeTaskSummary } from '@/types/api'
import { createRuntimeChatStream } from '@/api/runtime/runtimeChatStream'
import {
  applyRuntimeConversationAction,
  beginRuntimeConversationHydration,
  clearRuntimeConversationCacheForTests,
  completeRuntimeConversationHydration,
  getRuntimeConversationTurns,
  replaceRuntimeConversationSnapshot,
} from './runtimeConversationCache'
import { registerRuntimeConversationStream } from './runtimeConversationStreamCoordinator'
import { useRuntimeConversationSnapshot } from './useRuntimeConversationSnapshot'
import { mergeRuntimeConversationTurns } from './runtimeConversationTurns'
import type { RuntimeConversationTurn } from '@/types/workbench'

const address = { deviceId: 'device', taskId: 'task' }
const previous: RuntimeConversationTurn[] = [
  { id: 'previous', position: 10, status: 'done' as const, items: [] },
  {
    id: 'goal-continuation',
    status: 'done',
    items: [{ id: 'old-reply', type: 'assistant_text', content: 'Browser blocked' }],
  },
]

afterEach(clearRuntimeConversationCacheForTests)

test('keeps already observed turns before the live overlay of an older page', () => {
  const active = { id: 'native-turn', status: 'streaming' as const, items: [] }
  const merged = mergeRuntimeConversationTurns(
    [...previous, active],
    [{ id: 'older', position: 1, status: 'done', items: [] }, previous[0], active]
  )
  expect(merged.map(turn => turn.id)).toEqual([
    'older',
    'previous',
    'goal-continuation',
    'native-turn',
  ])
})

test('publishes a resumed native turn through transport, shared cache and pane during history paging', async () => {
  let receive!: (event: LocalExecutorEvent) => void
  const stream = createRuntimeChatStream({
    subscribe: async handler => {
      receive = handler
      return () => {}
    },
    request: vi.fn(),
  })
  const unregister = registerRuntimeConversationStream(
    stream,
    { onMessageAction: applyRuntimeConversationAction },
    true
  )
  replaceRuntimeConversationSnapshot(address, previous)
  const { result, unmount } = renderHook(() => useRuntimeConversationSnapshot(address))
  const task = {
    taskId: address.taskId,
    executionState: {
      revision: '1',
      phase: 'running',
      turnId: 'native-turn',
      latestTurnId: 'native-turn',
      outcome: null,
      startedAt: 1793773122000,
    },
  } as RuntimeTaskSummary
  const emit = (event: string, data: Record<string, unknown>, subtaskId = 'native-turn') =>
    receive({ event, payload: { ...address, subtaskId, data } })
  try {
    await act(async () => {
      applyRuntimeConversationAction(address, {
        type: 'user_added',
        message: { id: 'user', role: 'user', content: 'Continue', status: 'done', createdAt: '' },
      })
      emit('runtime.turn.updated', { status: 'started', turnId: 'native-turn', task })
      receive({
        event: 'response.created',
        payload: {
          ...address,
          subtaskId: 'native-turn',
          clientUserMessageId: 'user',
          data: { task },
        },
      })
      const token = beginRuntimeConversationHydration(address)
      emit('response.block.created', {
        block: { id: 'build-tool', type: 'tool', tool_name: 'bash', status: 'streaming' },
      })
      emit('response.output_text.delta', {
        item_id: 'progress',
        delta: 'Build submitted',
        offset: 0,
      })
      // An older page can include the executor's live transcript overlay. It does
      // not contain the more recent Goal continuation already loaded by the pane.
      completeRuntimeConversationHydration(address, token, [
        { id: 'older', position: 1, status: 'done', items: [] },
        previous[0],
        getRuntimeConversationTurns(address).find(turn => turn.id === 'native-turn')!,
      ])
    })
    await waitFor(() => expect(result.current.messages.at(-1)?.content).toBe('Build submitted'))
    expect(result.current.turns.map(turn => turn.id)).toEqual([
      'older',
      'previous',
      'goal-continuation',
      'native-turn',
    ])
    expect(result.current.messages.find(message => message.role === 'user')?.content).toBe(
      'Continue'
    )
    expect(result.current.messages.at(-1)?.blocks).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: 'build-tool', status: 'streaming' })])
    )
    await act(async () => {
      emit('response.output_text.done', {
        item_id: 'progress',
        text: 'Build submitted successfully',
      })
    })
    await waitFor(() =>
      expect(result.current.messages.at(-1)?.content).toBe('Build submitted successfully')
    )
  } finally {
    unmount()
    unregister()
  }
})
