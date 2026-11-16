import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { CodexInlineVisualizationHost } from './CodexInlineVisualizationHost'

const runtimeMock = vi.hoisted(() => ({
  electron: false,
}))
const desktopHostMock = vi.hoisted(() => ({
  invokeDesktopHost: vi.fn(),
}))
const appearanceMock = vi.hoisted(() => ({
  resolvedMode: 'light' as 'light' | 'dark',
}))

vi.mock('@/features/appearance', () => ({
  useOptionalAppearance: () => appearanceMock,
}))
vi.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))

vi.mock('@/lib/runtime-environment', async importOriginal => ({
  ...(await importOriginal<typeof import('@/lib/runtime-environment')>()),
  isElectronRuntime: () => runtimeMock.electron,
}))
vi.mock('@/api/dsh/desktopHost', () => desktopHostMock)
vi.mock('@/desktop/inlineVisualization', () => ({
  readInlineVisualizationHtml: desktopHostMock.invokeDesktopHost,
}))

beforeEach(() => {
  runtimeMock.electron = true
  appearanceMock.resolvedMode = 'light'
  desktopHostMock.invokeDesktopHost.mockReset()
  document.documentElement.removeAttribute('style')
  document.documentElement.removeAttribute('data-appearance-theme')
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('CodexInlineVisualizationHost', () => {
  test('loads the unique nested fragment as a UTF-8 sandbox document and resizes safely', async () => {
    desktopHostMock.invokeDesktopHost.mockResolvedValue(
      '<h2>月度趋势</h2><svg style="stroke:var(--viz-series-1)"></svg>'
    )
    let documentBlob: Blob | undefined
    vi.spyOn(URL, 'createObjectURL').mockImplementation(blob => {
      documentBlob = blob
      return 'blob:inline-visualization'
    })
    const revokeObjectUrl = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined)

    const { unmount } = render(
      <CodexInlineVisualizationHost
        file="verify-chart.html"
        fileChanges={{
          version: 1,
          status: 'active',
          artifact_id: 'artifact-1',
          device_id: 'device-1',
          workspace_path: '/workspace',
          file_count: 1,
          additions: 1,
          deletions: 0,
          files: [
            {
              path: '.codex/visualizations/2026/07/23/thread/verify-chart.html',
              change_type: 'created',
              additions: 1,
              deletions: 0,
              binary: false,
            },
          ],
        }}
      />
    )

    const frame = screen.getByTestId('codex-inline-visualization-frame')
    await waitFor(() => expect(frame).toHaveAttribute('src', 'blob:inline-visualization'))
    expect(documentBlob?.type).toBe('text/html;charset=utf-8')

    const document = await documentBlob?.text()
    const parsedDocument = new DOMParser().parseFromString(document ?? '', 'text/html')
    expect(parsedDocument.compatMode).toBe('CSS1Compat')
    expect(parsedDocument.head.querySelector('base')?.href).toBe(
      'file:///workspace/.codex/visualizations/2026/07/23/thread/'
    )
    expect(parsedDocument.body.querySelector('h2')?.textContent).toBe('月度趋势')
    expect(document).toContain('<h2>月度趋势</h2>')
    expect(document).toContain('--viz-series-1: var(--primary)')
    expect(document).toContain(
      '<base href="file:///workspace/.codex/visualizations/2026/07/23/thread/">'
    )
    const token = document?.match(/const token="([^"]+)"/)?.[1]
    expect(token).toBeTruthy()

    act(() => {
      window.dispatchEvent(
        new MessageEvent('message', {
          source: frame.contentWindow,
          data: {
            type: 'wework-inline-visualization-resize',
            token,
            height: 321.2,
          },
        })
      )
    })
    expect(frame).toHaveStyle({ height: '322px' })

    unmount()
    expect(revokeObjectUrl).toHaveBeenCalledWith('blob:inline-visualization')
  })

  test('shows loading, reports a file failure, and retries the read', async () => {
    let rejectRead: (reason: Error) => void = () => undefined
    desktopHostMock.invokeDesktopHost.mockImplementationOnce(
      () =>
        new Promise((_, reject) => {
          rejectRead = reject
        })
    )
    desktopHostMock.invokeDesktopHost.mockResolvedValue('<section>Recovered</section>')
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:recovered-visualization')

    render(<CodexInlineVisualizationHost file="/workspace/missing.html" />)

    expect(screen.getByRole('status')).toHaveTextContent('visualization.loading')
    expect(screen.getByTestId('codex-inline-visualization-frame')).toHaveClass('hidden')
    await act(async () => rejectRead(new Error('ENOENT')))
    expect(screen.getByRole('alert')).toHaveTextContent('visualization.load_failed')

    fireEvent.click(screen.getByTestId('codex-inline-visualization-retry'))

    await waitFor(() => {
      expect(screen.getByTestId('codex-inline-visualization-frame')).toHaveAttribute(
        'src',
        'blob:recovered-visualization'
      )
    })
    expect(screen.queryByTestId('codex-inline-visualization-status')).not.toBeInTheDocument()
    expect(desktopHostMock.invokeDesktopHost).toHaveBeenCalledTimes(2)
  })

  test('uses the workbench theme and changes it without rereading or reloading the document', async () => {
    desktopHostMock.invokeDesktopHost.mockResolvedValue('<section>Theme</section>')
    appearanceMock.resolvedMode = 'dark'
    let documentBlob: Blob | undefined
    const createObjectURL = vi.spyOn(URL, 'createObjectURL').mockImplementation(blob => {
      documentBlob = blob
      return 'blob:themed-visualization'
    })
    const { rerender } = render(<CodexInlineVisualizationHost file="/workspace/theme.html" />)
    const frame = screen.getByTestId<HTMLIFrameElement>('codex-inline-visualization-frame')
    await waitFor(() => expect(frame).toHaveAttribute('src', 'blob:themed-visualization'))
    expect(await documentBlob?.text()).toContain(':root { color-scheme: dark; }')
    const postMessage = vi.spyOn(frame.contentWindow!, 'postMessage')

    appearanceMock.resolvedMode = 'light'
    rerender(<CodexInlineVisualizationHost file="/workspace/theme.html" />)

    expect(postMessage).toHaveBeenLastCalledWith(
      expect.objectContaining({ type: 'wework-inline-visualization-theme', theme: 'light' }),
      '*'
    )
    expect(frame).toHaveAttribute('sandbox', 'allow-scripts')
    expect(frame).toHaveAttribute('src', 'blob:themed-visualization')
    expect(createObjectURL).toHaveBeenCalledTimes(1)
    expect(desktopHostMock.invokeDesktopHost).toHaveBeenCalledTimes(1)
  })

  test('ignores foreign resize messages and bounds authenticated heights', async () => {
    desktopHostMock.invokeDesktopHost.mockResolvedValue('<section>Resize</section>')
    let documentBlob: Blob | undefined
    vi.spyOn(URL, 'createObjectURL').mockImplementation(blob => {
      documentBlob = blob
      return 'blob:resize-visualization'
    })
    render(<CodexInlineVisualizationHost file="/workspace/resize.html" />)
    const frame = screen.getByTestId<HTMLIFrameElement>('codex-inline-visualization-frame')
    await waitFor(() => expect(frame).toHaveAttribute('src', 'blob:resize-visualization'))
    const token = (await documentBlob?.text())?.match(/const token="([^"]+)"/)?.[1]
    const dispatch = (source: Window | null, messageToken: string | undefined, height: number) => {
      act(() => {
        window.dispatchEvent(
          new MessageEvent('message', {
            source,
            data: { type: 'wework-inline-visualization-resize', token: messageToken, height },
          })
        )
      })
    }

    dispatch(window, token, 700)
    dispatch(frame.contentWindow, 'wrong-token', 700)
    dispatch(frame.contentWindow, token, Number.POSITIVE_INFINITY)
    expect(frame).toHaveStyle({ height: '480px' })
    dispatch(frame.contentWindow, token, 2)
    expect(frame).toHaveStyle({ height: '120px' })
    dispatch(frame.contentWindow, token, 9999)
    expect(frame).toHaveStyle({ height: '1200px' })
  })

  test('accepts theme updates only from its parent with the current token', async () => {
    desktopHostMock.invokeDesktopHost.mockResolvedValue('<section>Theme bridge</section>')
    let documentBlob: Blob | undefined
    vi.spyOn(URL, 'createObjectURL').mockImplementation(blob => {
      documentBlob = blob
      return 'blob:theme-bridge'
    })
    render(<CodexInlineVisualizationHost file="/workspace/theme-bridge.html" />)
    await waitFor(() => {
      expect(screen.getByTestId('codex-inline-visualization-frame')).toHaveAttribute(
        'src',
        'blob:theme-bridge'
      )
    })
    const html = (await documentBlob?.text()) ?? ''
    const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1]
    const token = html.match(/const token="([^"]+)"/)?.[1]
    expect(script).toBeTruthy()
    const themeStyle = { textContent: ':root { --background:rgb(26 27 38); }' }
    const style = document.createElement('html').style
    style.colorScheme = 'light'
    const setProperty = vi.spyOn(style, 'setProperty')
    const frameDocument = {
      getElementById: () => themeStyle,
      documentElement: { style },
      body: { getBoundingClientRect: () => ({ top: 0, height: 120 }), children: [] },
    }
    const parent = { postMessage: vi.fn() }
    const addListener = vi.fn()
    new Function('document', 'parent', 'addEventListener', 'ResizeObserver', script!)(
      frameDocument,
      parent,
      addListener,
      class {
        observe() {}
      }
    )
    const receiveTheme = addListener.mock.calls.find(([type]) => type === 'message')?.[1]
    const message = {
      type: 'wework-inline-visualization-theme',
      token,
      theme: 'dark',
      variables: { '--background': 'rgb(26 27 38)', '--unrelated': 'ignored' },
    }

    receiveTheme({ source: {}, data: message })
    receiveTheme({ source: parent, data: { ...message, token: 'wrong-token' } })
    receiveTheme({ source: parent, data: { ...message, theme: 'invalid' } })
    expect(frameDocument.documentElement.style.colorScheme).toBe('light')
    receiveTheme({ source: parent, data: message })
    expect(frameDocument.documentElement.style.colorScheme).toBe('dark')
    expect(setProperty).toHaveBeenCalledExactlyOnceWith('--background', 'rgb(26 27 38)')
    expect(themeStyle.textContent).toBe('')
    receiveTheme({ source: parent, data: { ...message, variables: {} } })
    expect(style.getPropertyValue('--background')).toBe('')
    style.setProperty('--foreground', 'tomato', 'important')
    receiveTheme({ source: parent, data: { ...message, variables: { '--foreground': 'blue' } } })
    expect(style.getPropertyValue('--foreground')).toBe('blue')
    receiveTheme({ source: parent, data: { ...message, variables: {} } })
    expect(style.getPropertyValue('--foreground')).toBe('tomato')
    expect(style.getPropertyPriority('--foreground')).toBe('important')
  })

  test('updates a mounted visualization when a palette changes within the same dark mode', async () => {
    appearanceMock.resolvedMode = 'dark'
    document.documentElement.dataset.appearanceTheme = 'tokyo-night'
    document.documentElement.style.setProperty('--color-bg-base', '26 27 38')
    document.documentElement.style.setProperty('--color-terminal-blue', '122 162 247')
    desktopHostMock.invokeDesktopHost.mockResolvedValue('<input value="keep my state">')
    let documentBlob: Blob | undefined
    const createObjectURL = vi.spyOn(URL, 'createObjectURL').mockImplementation(blob => {
      documentBlob = blob
      return 'blob:palette-visualization'
    })
    render(<CodexInlineVisualizationHost file="/workspace/palette.html" />)
    const frame = screen.getByTestId<HTMLIFrameElement>('codex-inline-visualization-frame')
    await waitFor(() => expect(frame).toHaveAttribute('src', 'blob:palette-visualization'))
    expect(await documentBlob?.text()).toContain('--background:rgb(26 27 38)')
    const postMessage = vi.spyOn(frame.contentWindow!, 'postMessage')

    document.documentElement.style.setProperty('--color-bg-base', '40 42 54')
    await waitFor(() =>
      expect(postMessage).toHaveBeenLastCalledWith(
        expect.objectContaining({
          theme: 'dark',
          variables: expect.objectContaining({
            '--background': 'rgb(40 42 54)',
            '--viz-series-1': 'rgb(122 162 247)',
          }),
        }),
        '*'
      )
    )
    expect(frame).toHaveAttribute('src', 'blob:palette-visualization')
    expect(createObjectURL).toHaveBeenCalledTimes(1)
    expect(desktopHostMock.invokeDesktopHost).toHaveBeenCalledTimes(1)
    document.documentElement.dataset.appearanceTheme = 'wework'
    await waitFor(() =>
      expect(postMessage).toHaveBeenLastCalledWith(
        expect.objectContaining({ theme: 'dark', variables: {} }),
        '*'
      )
    )
    expect(frame).toHaveAttribute('src', 'blob:palette-visualization')
    expect(createObjectURL).toHaveBeenCalledTimes(1)
    expect(desktopHostMock.invokeDesktopHost).toHaveBeenCalledTimes(1)
  })

  test('accepts wheel input only from the mounted sandbox before scrolling the conversation', async () => {
    desktopHostMock.invokeDesktopHost.mockResolvedValue('<section>Wheel bridge</section>')
    let documentBlob: Blob | undefined
    vi.spyOn(URL, 'createObjectURL').mockImplementation(blob => {
      documentBlob = blob
      return 'blob:wheel-bridge'
    })
    const { container } = render(
      <div data-scroll-origin="bottom">
        <CodexInlineVisualizationHost file="/workspace/wheel.html" />
      </div>
    )
    const viewport = container.firstElementChild as HTMLElement
    const sequence: string[] = []
    viewport.addEventListener('wheel', () => sequence.push('user-input'))
    viewport.scrollBy = vi.fn(() => sequence.push('scroll'))
    const frame = screen.getByTestId<HTMLIFrameElement>('codex-inline-visualization-frame')
    await waitFor(() => expect(frame).toHaveAttribute('src', 'blob:wheel-bridge'))
    const html = (await documentBlob?.text()) ?? ''
    const token = html.match(/const token="([^"]+)"/)?.[1]
    expect(html).toContain("addEventListener('wheel'")
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
    act(() => {
      window.dispatchEvent(new MessageEvent('message', { source: window, data }))
      window.dispatchEvent(
        new MessageEvent('message', {
          source: frame.contentWindow,
          data: { ...data, token: 'foreign-frame-token' },
        })
      )
    })
    expect(viewport.scrollBy).not.toHaveBeenCalled()
    act(() => {
      window.dispatchEvent(new MessageEvent('message', { source: frame.contentWindow, data }))
    })
    expect(sequence).toEqual(['user-input', 'scroll'])
    expect(viewport.scrollBy).toHaveBeenCalledExactlyOnceWith({
      top: -80,
      left: 0,
      behavior: 'instant',
    })
  })

  test('discards a stale read when the visualization path changes', async () => {
    let finishFirst: (fragment: string) => void = () => undefined
    desktopHostMock.invokeDesktopHost.mockImplementationOnce(
      () =>
        new Promise(resolve => {
          finishFirst = resolve
        })
    )
    desktopHostMock.invokeDesktopHost.mockResolvedValue('<section>Current document</section>')
    let documentBlob: Blob | undefined
    const createObjectURL = vi.spyOn(URL, 'createObjectURL').mockImplementation(blob => {
      documentBlob = blob
      return 'blob:current-visualization'
    })
    const { rerender } = render(<CodexInlineVisualizationHost file="/workspace/first.html" />)

    rerender(<CodexInlineVisualizationHost file="/workspace/second.html" />)
    await waitFor(() => {
      expect(screen.getByTestId('codex-inline-visualization-frame')).toHaveAttribute(
        'src',
        'blob:current-visualization'
      )
    })
    await act(async () => finishFirst('<section>Stale document</section>'))

    expect(createObjectURL).toHaveBeenCalledTimes(1)
    expect(await documentBlob?.text()).toContain('Current document')
    expect(await documentBlob?.text()).not.toContain('Stale document')
  })
})
