import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, expect, test } from 'vitest'
import { useRuntimeTaskRateLimitWait } from './useRuntimeTaskRateLimitWait'
import {
  applyRuntimeConversationAction,
  clearRuntimeConversationCacheForTests,
  replaceRuntimeConversationSnapshot,
} from './runtimeConversationCache'
import type { ProcessingBlock } from '@/types/workbench'

const address = { deviceId: 'retry-device', taskId: 'retry-task' }
const waitingBlock: ProcessingBlock = {
  id: 'retry-block',
  type: 'tool',
  toolName: 'runtime_reconnecting',
  toolInput: { retry_reason: 'rate_limit' },
  status: 'streaming',
  createdAt: 1,
}

afterEach(clearRuntimeConversationCacheForTests)

test('tracks rate-limit waiting from the existing conversation stream and clears on progress', async () => {
  const { result } = renderHook(() => useRuntimeTaskRateLimitWait(address))
  expect(result.current).toBe(false)
  act(() => {
    applyRuntimeConversationAction(address, { type: 'assistant_started', subtaskId: 'turn-1' })
    applyRuntimeConversationAction(address, {
      type: 'block_created',
      subtaskId: 'turn-1',
      block: waitingBlock,
    })
  })
  expect(result.current).toBe(true)
  act(() => {
    applyRuntimeConversationAction(address, {
      type: 'assistant_chunk',
      subtaskId: 'turn-1',
      itemId: 'resumed-message',
      content: 'Resumed',
    })
  })
  await waitFor(() => expect(result.current).toBe(false))
})

test('restores waiting from cached turns but ignores terminal and other-device turns', () => {
  replaceRuntimeConversationSnapshot(address, [
    {
      id: 'turn-1',
      status: 'streaming',
      items: [{ id: waitingBlock.id, type: 'block', block: waitingBlock }],
    },
  ])
  const { result } = renderHook(() => useRuntimeTaskRateLimitWait(address))
  const other = renderHook(() => useRuntimeTaskRateLimitWait({ ...address, deviceId: 'other' }))
  expect(result.current).toBe(true)
  expect(other.result.current).toBe(false)
  act(() => {
    applyRuntimeConversationAction(address, {
      type: 'assistant_error',
      subtaskId: 'turn-1',
      error: 'Retry exhausted',
    })
  })
  expect(result.current).toBe(false)
})

test('updates one retry block when a connection failure becomes a rate limit', async () => {
  applyRuntimeConversationAction(address, { type: 'assistant_started', subtaskId: 'turn-1' })
  applyRuntimeConversationAction(address, {
    type: 'block_created',
    subtaskId: 'turn-1',
    block: { ...waitingBlock, toolInput: { retry_reason: 'connection' } },
  })
  const { result } = renderHook(() => useRuntimeTaskRateLimitWait(address))
  expect(result.current).toBe(false)
  act(() => {
    applyRuntimeConversationAction(address, {
      type: 'block_updated',
      subtaskId: 'turn-1',
      blockId: waitingBlock.id,
      updates: { toolInput: { retry_reason: 'rate_limit' } },
    })
  })
  await waitFor(() => expect(result.current).toBe(true))
  act(() => {
    applyRuntimeConversationAction(address, {
      type: 'block_updated',
      subtaskId: 'turn-1',
      blockId: waitingBlock.id,
      updates: { status: 'done' },
    })
  })
  await waitFor(() => expect(result.current).toBe(false))
})
