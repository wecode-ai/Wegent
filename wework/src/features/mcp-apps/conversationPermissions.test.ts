import { describe, expect, it, vi } from 'vitest'
import { createMcpAppConversationServices } from './conversationServices'

describe('MCP App Issue execution permission contract', () => {
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
