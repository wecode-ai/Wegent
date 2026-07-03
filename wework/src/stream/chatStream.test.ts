import { describe, expect, test, vi } from 'vitest'
import { createChatStream } from './chatStream'

describe('createChatStream', () => {
  test('maps backend response api text events to chat chunks', () => {
    const listeners = new Map<string, (payload: unknown) => void>()
    const socket = {
      emit: vi.fn(),
      on: vi.fn((event: string, handler: (payload: unknown) => void) => {
        listeners.set(event, handler)
      }),
      off: vi.fn(),
      connected: true,
    }
    const onChatChunk = vi.fn()
    const stream = createChatStream(socket)

    stream.subscribe({ onChatChunk })
    listeners.get('response.output_text.delta')?.({
      taskId: 'codex-1',
      subtaskId: '202',
      deviceId: 'device-1',
      runtime: 'codex',
      data: { delta: 'hello' },
    })

    expect(onChatChunk).toHaveBeenCalledWith({
      taskId: 'codex-1',
      subtaskId: '202',
      deviceId: 'device-1',
      content: 'hello',
      offset: 0,
      result: { delta: 'hello' },
    })
  })

  test('does not subscribe to legacy chat stream events', () => {
    const socket = {
      emit: vi.fn(),
      on: vi.fn(),
      off: vi.fn(),
      connected: true,
    }
    const onChatChunk = vi.fn()
    const stream = createChatStream(socket)

    stream.subscribe({ onChatChunk })

    expect(socket.on).not.toHaveBeenCalledWith('chat:start', expect.any(Function))
    expect(socket.on).not.toHaveBeenCalledWith('chat:chunk', expect.any(Function))
    expect(socket.on).not.toHaveBeenCalledWith('chat:done', expect.any(Function))
    expect(socket.on).not.toHaveBeenCalledWith('chat:error', expect.any(Function))
    expect(socket.on).not.toHaveBeenCalledWith('chat:block_created', expect.any(Function))
    expect(socket.on).not.toHaveBeenCalledWith('chat:block_updated', expect.any(Function))
  })

  test('registers and unregisters response api and device handlers', () => {
    const socket = { emit: vi.fn(), on: vi.fn(), off: vi.fn(), connected: true }
    const stream = createChatStream(socket)
    const handlers = {
      onChatChunk: vi.fn(),
      onDeviceSlotUpdate: vi.fn(),
      onDeviceUpgradeStatus: vi.fn(),
    }

    const cleanup = stream.subscribe(handlers)
    cleanup()

    expect(socket.on).toHaveBeenCalledWith('response.output_text.delta', expect.any(Function))
    expect(socket.on).toHaveBeenCalledWith('device:slot_update', handlers.onDeviceSlotUpdate)
    expect(socket.on).toHaveBeenCalledWith('device:upgrade_status', handlers.onDeviceUpgradeStatus)
    expect(socket.off).toHaveBeenCalledWith('response.output_text.delta', expect.any(Function))
    expect(socket.off).toHaveBeenCalledWith('device:slot_update', handlers.onDeviceSlotUpdate)
    expect(socket.off).toHaveBeenCalledWith('device:upgrade_status', handlers.onDeviceUpgradeStatus)
  })
})
