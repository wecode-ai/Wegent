import { describe, expect, test, vi } from 'vitest'
import { createChatStream } from './chatStream'

describe('createChatStream', () => {
  test('sends chat message through chat:send', async () => {
    const emit = vi.fn((_event, _payload, ack) => ack({ success: true, task_id: 3 }))
    const socket = { emit, on: vi.fn(), off: vi.fn(), connected: true }
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

  test('treats backend task ack without success as successful', async () => {
    const emit = vi.fn((_event, _payload, ack) => ack({ task_id: 8 }))
    const socket = { emit, on: vi.fn(), off: vi.fn(), connected: true }
    const stream = createChatStream(socket)

    const result = await stream.sendMessage({
      team_id: 2,
      message: 'hello',
      task_type: 'code',
    })

    expect(result).toEqual({ success: true, task_id: 8 })
  })

  test('preserves backend send errors as failures', async () => {
    const emit = vi.fn((_event, _payload, ack) => ack({ error: 'boom' }))
    const socket = { emit, on: vi.fn(), off: vi.fn(), connected: true }
    const stream = createChatStream(socket)

    const result = await stream.sendMessage({
      team_id: 2,
      message: 'hello',
      task_type: 'code',
    })

    expect(result).toEqual({ success: false, error: 'boom' })
  })

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

    const chunkWrapper = socket.on.mock.calls.find(([event]) => event === 'chat:chunk')?.[1]
    const slotWrapper = socket.on.mock.calls.find(([event]) => event === 'device:slot_update')?.[1]
    const upgradeWrapper = socket.on.mock.calls.find(
      ([event]) => event === 'device:upgrade_status'
    )?.[1]

    expect(chunkWrapper).toEqual(expect.any(Function))
    expect(slotWrapper).toEqual(expect.any(Function))
    expect(upgradeWrapper).toEqual(expect.any(Function))

    chunkWrapper?.({ subtask_id: 9, content: 'hi', offset: 2 })
    slotWrapper?.({ device_id: 'device-1', total: 1, used: 0 })
    upgradeWrapper?.({ device_id: 'device-1', status: 'running' })

    cleanup()

    expect(handlers.onChatChunk).toHaveBeenCalledWith({ subtask_id: 9, content: 'hi', offset: 2 })
    expect(handlers.onDeviceSlotUpdate).toHaveBeenCalledWith({
      device_id: 'device-1',
      total: 1,
      used: 0,
    })
    expect(handlers.onDeviceUpgradeStatus).toHaveBeenCalledWith({
      device_id: 'device-1',
      status: 'running',
    })
    expect(socket.off).toHaveBeenCalledWith('chat:chunk', chunkWrapper)
    expect(socket.off).toHaveBeenCalledWith('device:slot_update', slotWrapper)
    expect(socket.off).toHaveBeenCalledWith('device:upgrade_status', upgradeWrapper)
  })
})
