import { act, render, screen, waitFor, fireEvent } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { ToolBlock } from '@wegent/chat-core/runtime-conversation'
import { McpAppHost } from './McpAppHost'

vi.mock('@/hooks/useTranslation', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))

const address = { deviceId: 'device', taskId: 'task' }
const running: ToolBlock = {
  id: 'call',
  type: 'tool',
  toolName: 'show',
  mcpServer: 'app',
  status: 'running',
  subtaskId: 'turn',
  createdAt: 0,
}

describe('MCP App discovery', () => {
  it('preserves a pending resource error across transcript updates and retries only on user action', async () => {
    let reject!: (error: Error) => void
    const requestMcpApp = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise((_, fail) => {
            reject = fail
          })
      )
      .mockResolvedValue(null)
    const api = { requestMcpApp }
    const { rerender } = render(<McpAppHost block={running} address={address} api={api} />)
    await waitFor(() => expect(requestMcpApp).toHaveBeenCalledTimes(1))
    rerender(
      <McpAppHost
        block={{ ...running, status: 'done', toolOutput: { content: [] } }}
        address={address}
        api={api}
      />
    )
    await act(async () => reject(new Error('Resource unavailable')))
    expect(screen.getByRole('alert')).toHaveTextContent('Resource unavailable')
    expect(requestMcpApp).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByTestId('mcp-app-retry'))
    await waitFor(() => expect(requestMcpApp).toHaveBeenCalledTimes(2))
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })
})
