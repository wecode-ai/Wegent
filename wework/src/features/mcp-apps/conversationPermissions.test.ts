// @vitest-environment node

import { describe, expect, it, vi } from 'vitest'
import { createMcpAppConversationServices } from './conversationServices'

describe('MCP App conversation permission contract', () => {
  it('does not discover app resources for stand-in memory review evidence tools', () => {
    const services = createMcpAppConversationServices({
      address: {
        deviceId: 'device',
        taskId: 'memory-review',
        runtimeHandle: { origin: { type: 'stand_in_schedule', memoryReview: true } },
      },
      api: { requestMcpApp: vi.fn() },
      readOnly: false,
      sendMessage: vi.fn(),
    })
    expect(services).toBeUndefined()
  })

  it('preserves rendering and resource access while withholding message admission in read-only views', () => {
    const requestMcpApp = vi.fn()
    const sendMessage = vi.fn()
    const address = { deviceId: 'device', taskId: 'execution' }
    const services = createMcpAppConversationServices({
      address,
      api: { requestMcpApp },
      readOnly: true,
      sendMessage,
    })
    expect(services?.address).toEqual(address)
    expect(services?.api.requestMcpApp).toBe(requestMcpApp)
    expect(services?.sendMessage).toBeUndefined()
    expect(sendMessage).not.toHaveBeenCalled()
  })

  it('routes an editable app message to its originating conversation', async () => {
    const sendMessage = vi.fn().mockResolvedValue(true)
    const address = { deviceId: 'device', taskId: 'conversation' }
    const services = createMcpAppConversationServices({
      address,
      api: { requestMcpApp: vi.fn() },
      readOnly: false,
      sendMessage,
    })
    expect(await services?.sendMessage?.('Continue with my selection')).toBe(true)
    expect(sendMessage).toHaveBeenCalledExactlyOnceWith({
      address,
      message: 'Continue with my selection',
    })
  })
})
