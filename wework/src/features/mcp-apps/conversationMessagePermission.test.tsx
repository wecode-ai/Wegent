import { useState, type ReactNode } from 'react'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { DesktopToolServices } from '@/components/chat/DesktopToolServices'
import { createMcpAppConversationServices } from './conversationServices'

vi.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en' } }),
}))

const app = vi.hoisted(() => ({
  onMessage: undefined as ((message: string) => Promise<void>) | undefined,
}))
const native = vi.hoisted(() => ({ invoke: vi.fn() }))
vi.mock('@/api/dsh/desktopHost', () => ({ invokeDesktopHost: native.invoke }))
vi.mock('./McpAppsProvider', () => ({
  McpAppsProvider: ({
    children,
    onMessage,
  }: {
    children: ReactNode
    onMessage?: typeof app.onMessage
  }) => {
    app.onMessage = onMessage
    return children
  },
  McpAppSlot: () => null,
}))

describe('MCP App pending message admission', () => {
  it('preserves conversation state when message admission changes', () => {
    function Conversation() {
      const [open, setOpen] = useState(false)
      return <button onClick={() => setOpen(true)}>{open ? 'Picker open' : 'Open picker'}</button>
    }
    const options = {
      address: { deviceId: 'device', taskId: 'original' },
      api: { requestMcpApp: vi.fn() },
      sendMessage: vi.fn().mockResolvedValue(true),
    }
    const content = (readOnly: boolean) => (
      <DesktopToolServices mcpApp={createMcpAppConversationServices({ ...options, readOnly })}>
        <Conversation />
      </DesktopToolServices>
    )
    const { rerender } = render(content(true))
    fireEvent.click(screen.getByRole('button', { name: 'Open picker' }))
    rerender(content(false))
    expect(screen.getByRole('button', { name: 'Picker open' })).toBeVisible()
    expect(app.onMessage).toBeTypeOf('function')
    rerender(content(true))
    expect(screen.getByRole('button', { name: 'Picker open' })).toBeVisible()
    expect(app.onMessage).toBeUndefined()
  })

  it.each(['read-only', 'different-task', 'unmounted'] as const)(
    'rejects pending approval after changing to %s',
    async change => {
      let approve!: (value: { response: number }) => void
      native.invoke.mockImplementationOnce(
        () =>
          new Promise(resolve => {
            approve = resolve
          })
      )
      const sendMessage = vi.fn().mockResolvedValue(true)
      const address = { deviceId: 'device', taskId: 'original' }
      const options = { address, api: { requestMcpApp: vi.fn() }, readOnly: false, sendMessage }
      const { rerender, unmount } = render(
        <DesktopToolServices mcpApp={createMcpAppConversationServices(options)}>
          <p>App remains available</p>
        </DesktopToolServices>
      )
      const pending = app.onMessage!('Continue')
      await waitFor(() => expect(approve).toBeTypeOf('function'))
      rerender(
        <DesktopToolServices
          mcpApp={createMcpAppConversationServices({
            ...options,
            address: change === 'different-task' ? { ...address, taskId: 'other' } : address,
            readOnly: change === 'read-only',
          })}
        >
          <p>App remains available</p>
        </DesktopToolServices>
      )
      if (change === 'unmounted') unmount()
      if (change === 'read-only') expect(app.onMessage).toBeUndefined()
      if (change !== 'unmounted') expect(screen.getByText('App remains available')).toBeVisible()
      await act(async () => {
        const rejected = expect(pending).rejects.toThrow('message admission is no longer available')
        approve({ response: 1 })
        await rejected
      })
      expect(sendMessage).not.toHaveBeenCalled()
    }
  )
})
