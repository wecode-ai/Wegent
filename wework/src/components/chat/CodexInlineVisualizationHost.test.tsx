import { act, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { CodexInlineVisualizationHost } from './CodexInlineVisualizationHost'

vi.mock('@tauri-apps/api/core', () => ({
  convertFileSrc: (path: string) => `asset://localhost/${path.replace(/^\/+/, '')}`,
}))

afterEach(() => {
  vi.restoreAllMocks()
})

describe('CodexInlineVisualizationHost', () => {
  test('loads the unique nested fragment as a UTF-8 sandbox document and resizes safely', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('<h2>月度趋势</h2><svg style="stroke:var(--viz-series-1)"></svg>')
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
      '<base href="asset://localhost/workspace/.codex/visualizations/2026/07/23/thread/">'
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
