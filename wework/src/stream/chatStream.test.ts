import { describe, expect, test, vi } from 'vitest'
import { createChatStream } from './chatStream'

describe('createChatStream', () => {
  test('sends chat message through chat:send', async () => {
    const emit = vi.fn((_event, _payload, ack) => ack({ success: true, task_id: 3 }))
    const socket = { emit, on: vi.fn(), off: vi.fn() }
    const stream = createChatStream(socket)

    const result = await stream.sendMessage({
      team_id: 2,
      task_id: 3,
      message: 'hello',
      task_type: 'code',
    })

    expect(result).toEqual({ success: true, task_id: 3 })
    expect(emit).toHaveBeenCalledWith(
      'chat:send',
      { team_id: 2, task_id: 3, message: 'hello', task_type: 'code' },
      expect.any(Function)
    )
  })

  test('registers and unregisters streaming handlers', () => {
    const socket = { emit: vi.fn(), on: vi.fn(), off: vi.fn() }
    const stream = createChatStream(socket)
    const handlers = { onChatChunk: vi.fn() }

    const cleanup = stream.subscribe(handlers)
    cleanup()

    expect(socket.on).toHaveBeenCalledWith('chat:chunk', handlers.onChatChunk)
    expect(socket.off).toHaveBeenCalledWith('chat:chunk', handlers.onChatChunk)
  })
})
