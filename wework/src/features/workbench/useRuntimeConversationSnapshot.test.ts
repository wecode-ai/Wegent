import { act, renderHook } from '@testing-library/react'
import { afterEach, expect, test } from 'vitest'
import {
  applyRuntimeConversationAction,
  clearRuntimeConversationCacheForTests,
} from './runtimeConversationCache'
import { useRuntimeConversationSnapshot } from './useRuntimeConversationSnapshot'

const first = { deviceId: 'device', taskId: 'first' }
const second = { deviceId: 'device', taskId: 'second' }
function start(address: typeof first, content: string) {
  applyRuntimeConversationAction(address, { type: 'assistant_started', subtaskId: address.taskId })
  applyRuntimeConversationAction(address, {
    type: 'assistant_chunk',
    subtaskId: address.taskId,
    itemId: 'reply',
    content,
    contentMode: 'snapshot',
  })
}
afterEach(clearRuntimeConversationCacheForTests)

test('switches snapshots in the same render and retains background updates for the previous task', () => {
  start(first, 'First task')
  start(second, 'Second task')
  const { result, rerender } = renderHook(
    ({ address }) => useRuntimeConversationSnapshot(address),
    {
      initialProps: { address: first },
    }
  )
  expect(result.current.messages[0].content).toBe('First task')
  rerender({ address: second })
  expect(result.current.messages[0].content).toBe('Second task')
  act(() =>
    applyRuntimeConversationAction(first, {
      type: 'assistant_chunk',
      subtaskId: first.taskId,
      itemId: 'reply',
      content: 'First updated',
      contentMode: 'snapshot',
    })
  )
  expect(result.current.messages[0].content).toBe('Second task')
  rerender({ address: first })
  expect(result.current.messages[0].content).toBe('First updated')
})
