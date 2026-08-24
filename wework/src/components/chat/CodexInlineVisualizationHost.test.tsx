import { act, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { CodexInlineVisualizationHost } from './CodexInlineVisualizationHost'

const runtimeMock = vi.hoisted(() => ({
  electron: false,
}))
const desktopHostMock = vi.hoisted(() => ({
  invokeDesktopHost: vi.fn(),
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
  desktopHostMock.invokeDesktopHost.mockReset()
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('CodexInlineVisualizationHost', () => {
  test('loads an absolute ChatGPT visualize path without file change metadata', async () => {
    desktopHostMock.invokeDesktopHost.mockResolvedValue('<div>可视化内容</div>')
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:absolute-visualization')
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined)

    render(
      <CodexInlineVisualizationHost
        file="/tmp/codex/visualizations/latency.html"
        mode="wide"
        title="Latency"
      />
    )

    const host = screen.getByTestId('codex-inline-visualization')
    const frame = screen.getByTestId('codex-inline-visualization-frame')
    expect(host).toHaveAttribute('data-visualization-mode', 'wide')
    expect(frame).toHaveAttribute('title', 'Latency')
    await waitFor(() => expect(frame).toHaveAttribute('src', 'blob:absolute-visualization'))
    expect(desktopHostMock.invokeDesktopHost).toHaveBeenCalledWith(
      '/tmp/codex/visualizations/latency.html'
    )
  })

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
    expect(document).toContain('<h2>月度趋势</h2>')
    expect(document).toContain('--viz-series-1: var(--primary)')
    expect(document).toContain(
      '<base href="file:///workspace/.codex/visualizations/2026/07/23/thread/">'
    )
    const token = document?.match(/token:(?:&quot;|")([^&"]+)/)?.[1]
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

  test('loads an Electron visualization through the declared local file capability', async () => {
    runtimeMock.electron = true
    const fragment = '<div>Electron 可视化</div>'
    desktopHostMock.invokeDesktopHost.mockResolvedValue({
      chunkBase64: Buffer.from(fragment).toString('base64'),
      bytesRead: Buffer.byteLength(fragment),
      eof: true,
      size: Buffer.byteLength(fragment),
    })
    let documentBlob: Blob | undefined
    vi.spyOn(URL, 'createObjectURL').mockImplementation(blob => {
      documentBlob = blob
      return 'blob:electron-visualization'
    })

    render(
      <CodexInlineVisualizationHost
        file="/tmp/codex/visualizations/electron chart.html"
        title="Electron chart"
      />
    )

    const frame = screen.getByTestId('codex-inline-visualization-frame')
    await waitFor(() => expect(frame).toHaveAttribute('src', 'blob:electron-visualization'))
    expect(desktopHostMock.invokeDesktopHost).toHaveBeenCalledWith(
      '/tmp/codex/visualizations/electron chart.html'
    )
    expect(await documentBlob?.text()).toContain('<base href="file:///tmp/codex/visualizations/">')
  })

  test('does not render an ambiguous basename match', () => {
    render(
      <CodexInlineVisualizationHost
        file="chart.html"
        fileChanges={{
          version: 1,
          status: 'active',
          artifact_id: 'artifact-2',
          device_id: 'device-1',
          workspace_path: '/workspace',
          file_count: 2,
          additions: 2,
          deletions: 0,
          files: [
            {
              path: 'one/chart.html',
              change_type: 'created',
              additions: 1,
              deletions: 0,
              binary: false,
            },
            {
              path: 'two/chart.html',
              change_type: 'created',
              additions: 1,
              deletions: 0,
              binary: false,
            },
          ],
        }}
      />
    )

    expect(screen.queryByTestId('codex-inline-visualization')).not.toBeInTheDocument()
  })
})
