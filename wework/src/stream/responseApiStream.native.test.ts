import { expect, test, vi } from 'vitest'
import { createResponseApiStreamState, emitResponseApiEvent } from './responseApiStream'

test('preserves native task evidence on request presentation binding', () => {
  const onChatStart = vi.fn()
  const task = { executionState: { revision: '42', phase: 'running', turnId: 'turn-1' } }
  emitResponseApiEvent(
    { onChatStart },
    'response.created',
    { taskId: 'task-1', subtaskId: 'turn-1', data: { task, response: { status: 'in_progress' } } },
    createResponseApiStreamState()
  )
  expect(onChatStart).toHaveBeenCalledWith(expect.objectContaining({ task, subtaskId: 'turn-1' }))
})
