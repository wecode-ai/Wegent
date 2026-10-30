import { act, render, screen, fireEvent } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ToolBlock } from '@wegent/chat-core/runtime-conversation'
import { McpAppHost } from './McpAppHost'

const translate = vi.hoisted(() => (key: string) => key)
const native = vi.hoisted(() => ({ invoke: vi.fn() }))
const connection = vi.hoisted(() => ({ start: vi.fn() }))
const bridges = vi.hoisted(() => [] as Array<Record<string, unknown>>)
const toolResults = vi.hoisted(() => vi.fn())
vi.mock('@/hooks/useTranslation', () => ({ useTranslation: () => ({ t: translate }) }))
vi.mock('@/api/dsh/desktopHost', () => ({ invokeDesktopHost: native.invoke }))
vi.mock('@modelcontextprotocol/ext-apps/app-bridge', () => ({
  AppBridge: class {
    constructor() {
      bridges.push(this as unknown as Record<string, unknown>)
    }
    oninitialized?: () => void
    async connect() {
      await connection.start()
      queueMicrotask(() => this.oninitialized?.())
    }
    async sendToolInput() {}
    async sendToolResult(result: unknown) {
      toolResults(result)
    }
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

beforeEach(() => {
  native.invoke.mockClear()
  connection.start.mockReset().mockResolvedValue(undefined)
  bridges.length = 0
  toolResults.mockClear()
})

describe('MCP App discovery', () => {
  it('discovers again when a streamed call becomes a native invocation', async () => {
    const requestMcpApp = vi.fn().mockResolvedValue(null)
    const api = { requestMcpApp }
    const view = render(
      <McpAppHost
        block={{ ...running, status: 'generating_arguments' }}
        address={address}
        api={api}
      />
    )
    await act(async () => {})
    expect(requestMcpApp).toHaveBeenCalledTimes(1)
    await act(async () => view.rerender(<McpAppHost block={running} address={address} api={api} />))
    expect(requestMcpApp).toHaveBeenCalledTimes(2)
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })
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
    expect(requestMcpApp).toHaveBeenCalledTimes(1)
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
    await act(async () => fireEvent.click(screen.getByTestId('mcp-app-retry')))
    expect(requestMcpApp).toHaveBeenCalledTimes(2)
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

  it('preserves widget state across equivalent transcript results and sends actual changes', async () => {
    native.invoke.mockResolvedValue({
      id: 'document',
      url: 'codex-sandbox://test.web-sandbox.oaiusercontent.com/mcp-app.html',
    })
    const api = { requestMcpApp: vi.fn().mockResolvedValue(descriptor) }
    const output = { content: [], structuredContent: { count: 1 } }
    const block = { ...running, status: 'done' as const, toolOutput: output }
    const view = render(<McpAppHost block={block} address={address} api={api} />)
    await act(async () => {})
    expect(toolResults).toHaveBeenCalledTimes(1)

    await act(async () =>
      view.rerender(
        <McpAppHost
          block={{ ...block, toolOutput: structuredClone(output) }}
          address={address}
          api={api}
        />
      )
    )
    expect(toolResults).toHaveBeenCalledTimes(1)

    const changed = { content: [], structuredContent: { count: 2 } }
    await act(async () =>
      view.rerender(
        <McpAppHost block={{ ...block, toolOutput: changed }} address={address} api={api} />
      )
    )
    expect(toolResults).toHaveBeenCalledTimes(2)
    await act(async () =>
      view.rerender(
        <McpAppHost
          block={{ ...block, status: 'error', toolOutput: changed }}
          address={address}
          api={api}
        />
      )
    )
    expect(toolResults).toHaveBeenCalledTimes(3)
    expect(toolResults).toHaveBeenLastCalledWith({ ...changed, isError: true })
  })

  it('loads the app document only after the message transport is connected', async () => {
    let finish!: () => void
    connection.start.mockImplementationOnce(
      () =>
        new Promise<void>(resolve => {
          finish = resolve
        })
    )
    const url = 'codex-sandbox://test.web-sandbox.oaiusercontent.com/mcp-app.html'
    native.invoke.mockResolvedValue({ id: 'document', url })
    render(
      <McpAppHost
        block={running}
        address={address}
        api={{ requestMcpApp: vi.fn().mockResolvedValue(descriptor) }}
      />
    )
    await act(async () => {})
    expect(connection.start).toHaveBeenCalledOnce()
    expect(screen.getByTestId('mcp-app-frame')).toHaveAttribute('src', 'about:blank')
    await act(async () => finish())
    expect(screen.getByTestId('mcp-app-frame')).toHaveAttribute('src', url)
  })

  it('does not navigate a removed frame when its connection finishes late', async () => {
    let finish!: () => void
    connection.start.mockImplementationOnce(
      () =>
        new Promise<void>(resolve => {
          finish = resolve
        })
    )
    native.invoke.mockResolvedValue({
      id: 'document',
      url: 'codex-sandbox://test.web-sandbox.oaiusercontent.com/mcp-app.html',
    })
    const view = render(
      <McpAppHost
        block={running}
        address={address}
        api={{ requestMcpApp: vi.fn().mockResolvedValue(descriptor) }}
      />
    )
    await act(async () => {})
    const frame = screen.getByTestId('mcp-app-frame')
    view.unmount()
    await act(async () => finish())
    expect(frame).toHaveAttribute('src', 'about:blank')
  })

  it('downloads remaining resources when a resource filename contains malformed percent encoding', async () => {
    native.invoke.mockImplementation((method: string) => {
      if (method === 'mcpApps.createDocument')
        return Promise.resolve({
          id: 'document',
          url: 'codex-sandbox://test.web-sandbox.oaiusercontent.com/mcp-app.html',
        })
      if (method === 'mcpApps.saveFile') return Promise.resolve({})
      if (method === 'mcpApps.releaseDocument') return Promise.resolve()
      throw new Error('Unexpected host method: ' + method)
    })
    render(
      <McpAppHost
        block={running}
        address={address}
        api={{ requestMcpApp: vi.fn().mockResolvedValue(descriptor) }}
      />
    )
    await act(async () => {})
    const download = bridges.at(-1)!.ondownloadfile as (params: unknown) => Promise<unknown>
    await expect(
      download({
        contents: [
          { type: 'resource', resource: { uri: 'file:///broken%E0%A4', text: 'first' } },
          { type: 'resource', resource: { uri: 'file:///report%20one.txt', text: 'second' } },
        ],
      })
    ).resolves.toEqual({})
    expect(native.invoke.mock.calls.filter(([method]) => method === 'mcpApps.saveFile')).toEqual([
      ['mcpApps.saveFile', { name: 'download', data: btoa('first') }],
      ['mcpApps.saveFile', { name: 'report one.txt', data: btoa('second') }],
    ])
  })

  it('dismisses and reopens a fullscreen-only view without releasing its document', async () => {
    native.invoke.mockImplementation((method: string) => {
      if (method === 'mcpApps.createDocument')
        return Promise.resolve({ id: 'full-document', url: 'http://127.0.0.1:9000/full-document' })
      if (method === 'mcpApps.releaseDocument') return Promise.resolve()
      throw new Error('Unexpected host method: ' + method)
    })
    const onDisplayModeChange = vi.fn()
    const full = {
      ...descriptor,
      resource: {
        contents: [
          {
            ...descriptor.resource.contents[0],
            _meta: {
              'openai/ui': { availableDisplayModes: ['fullscreen'] },
            },
          },
        ],
      },
    }
    await act(async () =>
      render(
        <McpAppHost
          block={{ ...running, status: 'done' }}
          address={address}
          api={{ requestMcpApp: vi.fn().mockResolvedValue(full) }}
          onDisplayModeChange={onDisplayModeChange}
        />
      )
    )
    const frame = screen.getByTestId('mcp-app-frame')
    expect(frame).toBeVisible()
    expect(screen.queryByTestId('mcp-app-expand')).not.toBeInTheDocument()
    act(() => onDisplayModeChange.mock.lastCall![1]())
    expect(frame).not.toBeVisible()
    expect(
      native.invoke.mock.calls.filter(([method]) => method === 'mcpApps.releaseDocument')
    ).toHaveLength(0)
    await act(async () => fireEvent.click(screen.getByTestId('mcp-app-expand')))
    expect(screen.getByTestId('mcp-app-frame')).toBe(frame)
    expect(frame).toBeVisible()
    expect(
      native.invoke.mock.calls.filter(([method]) => method === 'mcpApps.createDocument')
    ).toHaveLength(1)
  })

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
    await act(async () =>
      render(
        <McpAppHost
          block={{ ...running, status: 'done' }}
          address={address}
          api={{ requestMcpApp: vi.fn().mockResolvedValue(descriptor) }}
        />
      )
    )
    expect(screen.getByTestId('mcp-app-frame')).toHaveAttribute('data-ready', 'true')
    await act(async () => fireEvent.click(screen.getByTestId('mcp-app-close')))
    expect(finishRelease).toBeTypeOf('function')
    expect(screen.getByTestId('mcp-app-frame')).toBeInTheDocument()
    expect(screen.getByTestId('mcp-app-close')).toBeDisabled()
    await act(async () => finishRelease())
    expect(screen.queryByTestId('mcp-app-frame')).not.toBeInTheDocument()
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
    await act(async () =>
      render(
        <McpAppHost
          block={{ ...running, status: 'done' }}
          address={address}
          api={{ requestMcpApp: vi.fn().mockResolvedValue(descriptor) }}
        />
      )
    )
    expect(screen.getByTestId('mcp-app-frame')).toHaveAttribute('data-ready', 'true')
    await act(async () => fireEvent.click(screen.getByTestId('mcp-app-close')))
    expect(screen.getByRole('alert')).toHaveTextContent('Host temporarily unavailable')
    expect(screen.getByTestId('mcp-app-frame')).toBeInTheDocument()
    expect(screen.getByTestId('mcp-app-close')).toBeEnabled()
    await act(async () => fireEvent.click(screen.getByTestId('mcp-app-close')))
    expect(screen.queryByTestId('mcp-app-frame')).not.toBeInTheDocument()
    expect(releaseAttempts).toBe(2)
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })
})
