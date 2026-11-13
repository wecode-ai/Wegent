import { act, fireEvent, render, screen } from '@testing-library/react'
import type { ToolBlock } from '@wegent/chat-core/runtime-conversation'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { McpAppHost } from './McpAppHost'
import { WEWORK_OPEN_SCHEME_EVENT } from '@/features/notifications/schemeEvents'

const translate = vi.hoisted(() => (key: string) => key)
const native = vi.hoisted(() => ({ invoke: vi.fn() }))
const connection = vi.hoisted(() => ({ start: vi.fn() }))
const bridges = vi.hoisted(() => [] as Array<Record<string, unknown>>)
const toolResults = vi.hoisted(() => vi.fn())
const hostContexts = vi.hoisted(() => vi.fn())
vi.mock('@/hooks/useTranslation', () => ({ useTranslation: () => ({ t: translate }) }))
vi.mock('@/api/dsh/desktopHost', () => ({ invokeDesktopHost: native.invoke }))
vi.mock('@modelcontextprotocol/ext-apps/app-bridge', () => ({
  AppBridge: class {
    constructor(
      _client: unknown,
      _info: unknown,
      _capabilities: unknown,
      options: { hostContext: unknown }
    ) {
      bridges.push(this as unknown as Record<string, unknown>)
      hostContexts(options.hostContext)
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
    async setHostContext(context: unknown) {
      hostContexts(context)
    }
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
const discovery = {
  server: 'app',
  resourceUri: 'ui://app',
  tool: null,
  arguments: {},
  result: null,
}

beforeEach(() => {
  native.invoke.mockReset().mockResolvedValue(undefined)
  connection.start.mockReset().mockResolvedValue(undefined)
  bridges.length = 0
  toolResults.mockClear()
  hostContexts.mockClear()
})

afterEach(() => {
  const root = document.documentElement
  root.classList.remove('dark')
  root.removeAttribute('data-theme')
  root.removeAttribute('data-appearance-theme')
  for (const name of ['--color-bg-base', '--color-text-primary', '--color-focus']) {
    root.style.removeProperty(name)
  }
})

describe('MCP App discovery', () => {
  it.each(['Completed', { content: [{ type: 'text', text: 'Completed' }] }])(
    'keeps the saved interaction title when streamed output has no title: %j',
    async toolOutput => {
      const result = { content: [], structuredContent: { title: 'Saved title' } }
      const loaded = {
        ...discovery,
        result,
        resource: { contents: [{ uri: 'ui://app', mimeType: 'text/html', text: '<p>Saved</p>' }] },
      }
      native.invoke.mockResolvedValue({ id: 'saved-title', url: 'http://127.0.0.1/saved-title' })
      await act(async () =>
        render(
          <McpAppHost
            block={{ ...running, status: 'done', toolOutput }}
            address={address}
            api={{ requestMcpApp: vi.fn().mockResolvedValue(loaded) }}
          />
        )
      )
      expect(screen.getByTestId('mcp-app')).toHaveTextContent('Saved title')
      expect(screen.getByTestId('mcp-app-frame')).toHaveAttribute('title', 'Saved title')
    }
  )

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
  it('does not create cards for failed optional discovery and discovers on the next status update', async () => {
    const requestMcpApp = vi.fn().mockRejectedValue(new TypeError('Failed to fetch'))
    const api = { requestMcpApp }
    const hosts = (status: ToolBlock['status']) => (
      <>
        {Array.from({ length: 12 }, (_, index) => (
          <McpAppHost
            key={index}
            block={{ ...running, id: `call-${index}`, status }}
            address={address}
            api={api}
          />
        ))}
      </>
    )
    const view = render(hosts('running'))
    await act(async () => {})
    expect(requestMcpApp).toHaveBeenCalledTimes(12)
    expect(screen.queryByTestId('mcp-app')).not.toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    requestMcpApp.mockResolvedValue(null)
    await act(async () => view.rerender(hosts('done')))
    expect(requestMcpApp).toHaveBeenCalledTimes(24)
    expect(screen.queryByTestId('mcp-app')).not.toBeInTheDocument()
  })

  it('preserves a confirmed app resource error across transcript updates and retries only on user action', async () => {
    let reject!: (error: Error) => void
    const requestMcpApp = vi
      .fn()
      .mockResolvedValueOnce(discovery)
      .mockImplementationOnce(
        () =>
          new Promise((_, fail) => {
            reject = fail
          })
      )
      .mockResolvedValue(null)
    const api = { requestMcpApp }
    const { rerender } = render(<McpAppHost block={running} address={address} api={api} />)
    await act(async () => {})
    expect(requestMcpApp).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ method: 'discover' })
    )
    expect(requestMcpApp).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ method: 'initialize' })
    )
    rerender(
      <McpAppHost
        block={{ ...running, status: 'done', toolOutput: { content: [] } }}
        address={address}
        api={api}
      />
    )
    await act(async () => reject(new TypeError('Failed to fetch')))
    expect(screen.getByRole('alert')).toHaveTextContent('Failed to fetch')
    expect(screen.getByTestId('mcp-app')).toHaveTextContent('app')
    expect(requestMcpApp).toHaveBeenCalledTimes(2)
    await act(async () => fireEvent.click(screen.getByTestId('mcp-app-retry')))
    expect(requestMcpApp).toHaveBeenCalledTimes(3)
    expect(native.invoke).toHaveBeenCalledWith('mcpApps.releaseSession', {
      sessionId: requestMcpApp.mock.calls[1][0].sessionId,
    })
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('discovers a completed app when an earlier in-flight discovery fails', async () => {
    let reject!: (error: Error) => void
    const loaded = {
      ...discovery,
      resource: { contents: [{ uri: 'ui://app', mimeType: 'text/html', text: '<p>Ready</p>' }] },
    }
    native.invoke.mockResolvedValue({ id: 'recovered', url: 'http://127.0.0.1/recovered' })
    const requestMcpApp = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise((_, fail) => {
            reject = fail
          })
      )
      .mockResolvedValueOnce(discovery)
      .mockResolvedValue(loaded)
    const api = { requestMcpApp }
    const view = render(<McpAppHost block={running} address={address} api={api} />)
    view.rerender(<McpAppHost block={{ ...running, status: 'done' }} address={address} api={api} />)
    await act(async () => reject(new TypeError('Failed to fetch')))
    expect(requestMcpApp).toHaveBeenCalledTimes(3)
    expect(screen.getByTestId('mcp-app-frame')).toHaveAttribute('data-ready', 'true')
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('shows confirmed app initialization failures as a borderless activity row with retry and close', async () => {
    const requestMcpApp = vi
      .fn()
      .mockResolvedValueOnce(discovery)
      .mockRejectedValue(new Error('Source MCP server is no longer available'))
    await act(async () =>
      render(<McpAppHost block={running} address={address} api={{ requestMcpApp }} />)
    )

    const host = screen.getByTestId('mcp-app')
    expect(host).toHaveClass('font-normal', 'text-text-muted')
    expect(host).not.toHaveClass('shadow-sm', 'outline-1', 'rounded-lg')
    expect(screen.getByRole('alert')).toHaveTextContent('Source MCP server is no longer available')
    expect(screen.getByTestId('mcp-app-retry')).toBeEnabled()
    expect(screen.queryByTestId('mcp-app-expand')).not.toBeInTheDocument()
    expect(screen.queryByTestId('mcp-app-frame')).not.toBeInTheDocument()
    await act(async () => fireEvent.click(screen.getByTestId('mcp-app-close')))
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(screen.queryByTestId('mcp-app-close')).not.toBeInTheDocument()
    expect(screen.getByTestId('mcp-app-expand')).toBeEnabled()
    expect(requestMcpApp).toHaveBeenCalledTimes(2)
    expect(native.invoke).not.toHaveBeenCalledWith('mcpApps.createDocument', expect.anything())
  })

  it('keeps a historical card visible when its service is unavailable and restores it on retry', async () => {
    const result = {
      content: [],
      structuredContent: { title: 'Saved interaction' },
      _meta: { ui: { resourceUri: 'ui://app', html: '<p>Saved card</p>', tools: [] } },
    }
    const knownApp = { ...discovery, result }
    const loaded = {
      ...knownApp,
      resource: { contents: [{ uri: 'ui://app', mimeType: 'text/html', text: '<p>Host</p>' }] },
      modelContext: { structuredContent: { state: { view: 'created', id: 'saved-id' } } },
    }
    const requestMcpApp = vi
      .fn()
      .mockResolvedValueOnce(knownApp)
      .mockRejectedValueOnce(new Error('Source MCP server is no longer available'))
      .mockResolvedValueOnce(knownApp)
      .mockResolvedValueOnce(loaded)
    native.invoke.mockResolvedValue({ id: 'restored-document', url: 'http://127.0.0.1/restored' })
    await act(async () =>
      render(
        <McpAppHost
          block={{ ...running, status: 'done', toolOutput: result }}
          address={address}
          api={{ requestMcpApp }}
        />
      )
    )
    expect(screen.getByTestId('mcp-app')).toHaveTextContent('Saved interaction')
    expect(screen.getByRole('alert')).toHaveTextContent('Source MCP server is no longer available')
    await act(async () => fireEvent.click(screen.getByTestId('mcp-app-retry')))
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(screen.getByTestId('mcp-app-frame')).toHaveAttribute('data-ready', 'true')
    expect(toolResults).toHaveBeenCalledWith({ ...result, isError: false })
    expect(requestMcpApp.mock.calls.map(([request]) => request.method)).toEqual([
      'discover',
      'initialize',
      'discover',
      'initialize',
    ])
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

  it('updates named theme and accent variables without replacing the iframe or its bridge', async () => {
    const root = document.documentElement
    root.classList.add('dark')
    root.dataset.theme = 'dark'
    root.dataset.appearanceTheme = 'tokyo-night'
    root.style.setProperty('--color-bg-base', '26 27 38')
    root.style.setProperty('--color-text-primary', '169 177 214')
    native.invoke.mockImplementation((method: string) => {
      if (method === 'mcpApps.createDocument')
        return Promise.resolve({ id: 'document', url: 'http://127.0.0.1:9000/document' })
      if (
        method === 'mcpApps.releaseDocument' ||
        method === 'mcpApps.retainSession' ||
        method === 'mcpApps.releaseSession'
      )
        return Promise.resolve()
      throw new Error('Unexpected host method: ' + method)
    })
    await act(async () =>
      render(
        <McpAppHost
          block={running}
          address={address}
          api={{ requestMcpApp: vi.fn().mockResolvedValue(descriptor) }}
        />
      )
    )
    const frame = screen.getByTestId('mcp-app-frame') as HTMLIFrameElement
    const frameWindow = frame.contentWindow!
    const source = frame.src
    frameWindow.name = 'preserved app draft'
    expect(hostContexts).toHaveBeenLastCalledWith(
      expect.objectContaining({
        theme: 'dark',
        styles: {
          variables: expect.objectContaining({
            '--color-background-primary': 'rgb(26 27 38)',
          }),
        },
      })
    )

    await act(async () => {
      root.dataset.appearanceTheme = 'matrix'
      root.style.setProperty('--color-bg-base', '4 8 5')
      root.style.setProperty('--color-text-primary', '184 255 202')
    })
    expect(hostContexts).toHaveBeenLastCalledWith(
      expect.objectContaining({
        theme: 'dark',
        styles: {
          variables: expect.objectContaining({
            '--color-background-primary': 'rgb(4 8 5)',
            '--color-text-primary': 'rgb(184 255 202)',
          }),
        },
      })
    )

    await act(async () => {
      root.style.setProperty('--color-focus', '18 52 86')
    })
    expect(hostContexts).toHaveBeenLastCalledWith(
      expect.objectContaining({
        styles: { variables: expect.objectContaining({ '--color-text-info': 'rgb(18 52 86)' }) },
      })
    )
    expect(screen.getByTestId('mcp-app-frame')).toBe(frame)
    expect(frame.src).toBe(source)
    expect(frame.contentWindow).toBe(frameWindow)
    expect(frameWindow.name).toBe('preserved app draft')
    expect(bridges).toHaveLength(1)
    expect(connection.start).toHaveBeenCalledTimes(1)
    expect(
      native.invoke.mock.calls.filter(([method]) => method === 'mcpApps.createDocument')
    ).toHaveLength(1)
    expect(
      native.invoke.mock.calls.filter(([method]) => method === 'mcpApps.releaseDocument')
    ).toHaveLength(0)
  })

  it('forwards wheel input from its mounted document to the conversation only while inline', async () => {
    native.invoke.mockResolvedValue({ id: 'wheel-document', url: 'http://127.0.0.1/wheel' })
    const view = render(
      <div data-scroll-origin="bottom">
        <McpAppHost
          block={{ ...running, status: 'done' }}
          address={address}
          api={{ requestMcpApp: vi.fn().mockResolvedValue(descriptor) }}
        />
      </div>
    )
    await act(async () => {})
    const viewport = view.container.firstElementChild as HTMLElement
    const sequence: string[] = []
    viewport.addEventListener('wheel', () => sequence.push('user-input'))
    viewport.scrollBy = vi.fn(() => sequence.push('scroll'))
    const frame = screen.getByTestId<HTMLIFrameElement>('mcp-app-frame')
    const html = native.invoke.mock.calls.find(
      ([method]) => method === 'mcpApps.createDocument'
    )?.[1].html as string
    const token = html.match(/const token="([^"]+)"/)?.[1]
    expect(html).toContain("addEventListener('wheel'")
    expect(token).toBeTruthy()
    const data = {
      type: 'wework-inline-visualization-wheel',
      token,
      deltaX: 0,
      deltaY: -80,
      altKey: false,
      ctrlKey: false,
      metaKey: false,
      shiftKey: false,
    }
    const send = (source: Window | null, origin: string, value = data) =>
      window.dispatchEvent(new MessageEvent('message', { source, origin, data: value }))
    act(() => {
      send(window, 'http://127.0.0.1')
      send(frame.contentWindow, 'https://foreign.example')
      send(frame.contentWindow, 'http://127.0.0.1', { ...data, token: 'foreign-token' })
    })
    expect(viewport.scrollBy).not.toHaveBeenCalled()
    act(() => send(frame.contentWindow, 'http://127.0.0.1'))
    expect(sequence).toEqual(['user-input', 'scroll'])
    expect(viewport.scrollBy).toHaveBeenCalledExactlyOnceWith({
      left: 0,
      top: -80,
      behavior: 'instant',
    })
    await act(async () => fireEvent.click(screen.getByTestId('mcp-app-expand')))
    act(() => send(frame.contentWindow, 'http://127.0.0.1'))
    expect(viewport.scrollBy).toHaveBeenCalledTimes(1)
    await act(async () => view.unmount())
    act(() => send(frame.contentWindow, 'http://127.0.0.1'))
    expect(viewport.scrollBy).toHaveBeenCalledTimes(1)
  })

  it('keeps an inline-preferred app in the message until the user expands it', async () => {
    native.invoke.mockImplementation((method: string) => {
      if (method === 'mcpApps.createDocument')
        return Promise.resolve({
          id: 'inline-document',
          url: 'http://127.0.0.1:9000/inline-document',
        })
      return Promise.resolve()
    })
    const onDisplayModeChange = vi.fn()
    const inline = {
      ...descriptor,
      result: {
        content: [],
        structuredContent: { title: 'Generated workflow' },
        _meta: { ui: { html: '<button>Generated action</button>' } },
      },
      preferredDisplayMode: 'fullscreen',
      resource: {
        contents: [
          {
            ...descriptor.resource.contents[0],
            _meta: {
              'openai/ui': {
                availableDisplayModes: ['inline', 'fullscreen'],
                preferredDisplayMode: 'inline',
              },
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
          api={{ requestMcpApp: vi.fn().mockResolvedValue(inline) }}
          onDisplayModeChange={onDisplayModeChange}
        />
      )
    )
    const frame = screen.getByTestId('mcp-app-frame')
    expect(frame).toHaveAttribute('data-ready', 'true')
    expect(screen.getByTestId('mcp-app')).toHaveTextContent('Generated workflow')
    expect(toolResults).toHaveBeenCalledWith(
      expect.objectContaining({ _meta: inline.result._meta })
    )
    expect(screen.getByTestId('mcp-app')).toHaveAttribute('data-display-mode', 'inline')
    expect(onDisplayModeChange.mock.calls.every(([mode]) => mode === 'inline')).toBe(true)
    const resize = bridges.at(-1)!.onsizechange as (size: { height: number }) => void
    await act(async () => resize({ height: 1100 }))
    expect(frame).toHaveStyle({ height: '1100px' })
    await act(async () => resize({ height: 360 }))
    expect(frame).toHaveStyle({ height: '360px' })
    await act(async () => fireEvent.click(screen.getByTestId('mcp-app-expand')))
    expect(screen.getByTestId('mcp-app')).toHaveAttribute('data-display-mode', 'fullscreen')
    expect(screen.getByTestId('mcp-app-frame')).toBe(frame)
  })

  it('connects internal links to existing native navigation and rejects unsupported schemes', async () => {
    native.invoke.mockResolvedValue({ id: 'navigation', url: 'http://127.0.0.1/navigation' })
    await act(async () =>
      render(
        <McpAppHost
          block={{ ...running, status: 'done' }}
          address={address}
          api={{ requestMcpApp: vi.fn().mockResolvedValue(descriptor) }}
        />
      )
    )
    const open = bridges.at(-1)!.onopenlink as (params: { url: string }) => Promise<unknown>
    const navigated = vi.fn()
    window.addEventListener(WEWORK_OPEN_SCHEME_EVENT, navigated)
    try {
      await expect(open({ url: 'wework://tasks/device/task' })).resolves.toEqual({ isError: false })
      expect(navigated.mock.calls[0][0].detail).toBe('wework://tasks/device/task')
      await expect(open({ url: 'wework://navigate/%2Fnot-registered' })).resolves.toEqual({
        isError: true,
      })
      await expect(open({ url: 'javascript:alert(1)' })).resolves.toEqual({ isError: true })
    } finally {
      window.removeEventListener(WEWORK_OPEN_SCHEME_EVENT, navigated)
    }
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
      if (method === 'mcpApps.retainSession' || method === 'mcpApps.releaseSession')
        return Promise.resolve()
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
      if (method === 'mcpApps.retainSession' || method === 'mcpApps.releaseSession')
        return Promise.resolve()
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
      if (method === 'mcpApps.retainSession' || method === 'mcpApps.releaseSession')
        return Promise.resolve()
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
