import { describe, expect, test, vi } from 'vitest'
import { createChatStream } from './chatStream'

describe('createChatStream', () => {
  test('cancels active stream through chat:cancel', async () => {
    const emit = vi.fn((_event, _payload, ack) => ack({ success: true }))
    const socket = { emit, on: vi.fn(), off: vi.fn(), connected: true }
    const stream = createChatStream(socket)

    const result = await stream.cancelStream({
      subtask_id: 9,
      partial_content: 'partial',
      shell_type: 'ClaudeCode',
    })

    expect(result).toEqual({ success: true })
    expect(emit).toHaveBeenCalledWith(
      'chat:cancel',
      {
        subtask_id: 9,
        partial_content: 'partial',
        shell_type: 'ClaudeCode',
      },
      expect.any(Function)
    )
  })

  test('registers and unregisters streaming handlers', () => {
    const socket = { emit: vi.fn(), on: vi.fn(), off: vi.fn(), connected: true }
    const stream = createChatStream(socket)
    const handlers = {
      onChatChunk: vi.fn(),
      onDeviceSlotUpdate: vi.fn(),
      onDeviceUpgradeStatus: vi.fn(),
    }

    const cleanup = stream.subscribe(handlers)
    cleanup()

    expect(socket.on).toHaveBeenCalledWith('chat:chunk', handlers.onChatChunk)
    expect(socket.on).toHaveBeenCalledWith('device:slot_update', handlers.onDeviceSlotUpdate)
    expect(socket.on).toHaveBeenCalledWith(
      'device:upgrade_status',
      handlers.onDeviceUpgradeStatus
    )
    expect(socket.off).toHaveBeenCalledWith('chat:chunk', handlers.onChatChunk)
    expect(socket.off).toHaveBeenCalledWith('device:slot_update', handlers.onDeviceSlotUpdate)
    expect(socket.off).toHaveBeenCalledWith(
      'device:upgrade_status',
      handlers.onDeviceUpgradeStatus
    )
  })
})
