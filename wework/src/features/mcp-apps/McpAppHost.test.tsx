import { act, render, screen, waitFor, fireEvent } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { ToolBlock } from '@wegent/chat-core/runtime-conversation'
import { McpAppHost } from './McpAppHost'

const translate = vi.hoisted(() => (key: string) => key)
const native = vi.hoisted(() => ({ invoke: vi.fn() }))
vi.mock('@/hooks/useTranslation', () => ({ useTranslation: () => ({ t: translate }) }))
vi.mock('@/api/dsh/desktopHost', () => ({ invokeDesktopHost: native.invoke }))
vi.mock('@modelcontextprotocol/ext-apps/app-bridge', () => ({
  AppBridge: class {
    oninitialized?: () => void
    async connect() {
      queueMicrotask(() => this.oninitialized?.())
    }
    async sendToolInput() {}
    async sendToolResult() {}
    async setHostContext() {}
    async teardownResource() {}
    async close() {}
  },
}))

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

describe('MCP App close completion', () => {
  const descriptor = {
    server: 'app',
    resource: {
      contents: [{ uri: 'ui://app', mimeType: 'text/html;profile=mcp-app', text: '<p>App</p>' }],
    },
    result: { content: [] },
    arguments: {},
  }

  it('waits for native document release and releases it only once across close and cleanup', async () => {
    let finishRelease!: () => void
    native.invoke.mockImplementation((method: string) => {
      if (method === 'mcpApps.createDocument')
        return Promise.resolve({ id: 'document', url: 'http://127.0.0.1:9000/document' })
      if (method === 'mcpApps.releaseDocument')
        return new Promise<void>(resolve => {
          finishRelease = resolve
        })
      throw new Error('Unexpected host method: ' + method)
    })
    render(
      <McpAppHost
        block={{ ...running, status: 'done' }}
        address={address}
        api={{ requestMcpApp: vi.fn().mockResolvedValue(descriptor) }}
      />
    )
    await waitFor(() =>
      expect(screen.getByTestId('mcp-app-frame')).toHaveAttribute('data-ready', 'true')
    )
    fireEvent.click(screen.getByTestId('mcp-app-close'))
    await waitFor(() => expect(finishRelease).toBeTypeOf('function'))
    expect(screen.getByTestId('mcp-app-frame')).toBeInTheDocument()
    expect(screen.getByTestId('mcp-app-close')).toBeDisabled()
    await act(async () => finishRelease())
    await waitFor(() => expect(screen.queryByTestId('mcp-app-frame')).not.toBeInTheDocument())
    expect(
      native.invoke.mock.calls.filter(([method]) => method === 'mcpApps.releaseDocument')
    ).toHaveLength(1)
  })

  it('allows closing again after native document release fails', async () => {
    let releaseAttempts = 0
    native.invoke.mockImplementation((method: string) => {
      if (method === 'mcpApps.createDocument')
        return Promise.resolve({ id: 'document', url: 'http://127.0.0.1:9000/document' })
      if (method === 'mcpApps.releaseDocument') {
        releaseAttempts++
        return releaseAttempts === 1
          ? Promise.reject(new Error('Host temporarily unavailable'))
          : Promise.resolve()
      }
      throw new Error('Unexpected host method: ' + method)
    })
    render(
      <McpAppHost
        block={{ ...running, status: 'done' }}
        address={address}
        api={{ requestMcpApp: vi.fn().mockResolvedValue(descriptor) }}
      />
    )
    await waitFor(() =>
      expect(screen.getByTestId('mcp-app-frame')).toHaveAttribute('data-ready', 'true')
    )
    fireEvent.click(screen.getByTestId('mcp-app-close'))
    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent('Host temporarily unavailable')
    )
    expect(screen.getByTestId('mcp-app-frame')).toBeInTheDocument()
    expect(screen.getByTestId('mcp-app-close')).toBeEnabled()
    fireEvent.click(screen.getByTestId('mcp-app-close'))
    await waitFor(() => expect(screen.queryByTestId('mcp-app-frame')).not.toBeInTheDocument())
    expect(releaseAttempts).toBe(2)
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })
})
