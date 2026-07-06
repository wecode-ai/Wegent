import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import '@/i18n'
import { WorkspaceBrowserPanel } from './WorkspaceBrowserPanel'

const embeddedBrowserMocks = vi.hoisted(() => ({
  canUseEmbeddedBrowser: vi.fn(),
  closeEmbeddedBrowser: vi.fn(),
  consumeEmbeddedBrowserLabelTransfer: vi.fn(),
  evalEmbeddedBrowser: vi.fn(),
  evalEmbeddedBrowserJson: vi.fn(),
  goBackEmbeddedBrowser: vi.fn(),
  goForwardEmbeddedBrowser: vi.fn(),
  navigateEmbeddedBrowser: vi.fn(),
  openEmbeddedBrowser: vi.fn(),
  readEmbeddedBrowserPageState: vi.fn(),
  reloadEmbeddedBrowser: vi.fn(),
  setEmbeddedBrowserBounds: vi.fn(),
  EMBEDDED_BROWSER_DEBUG_PANEL_VISIBILITY_EVENT: 'wework:debug-panel-visibility-change',
}))

vi.mock('@/lib/embedded-browser', () => embeddedBrowserMocks)

vi.mock('@/lib/external-links', () => ({
  openExternalUrl: vi.fn(),
}))

class ResizeObserverMock {
  observe = vi.fn()
  unobserve = vi.fn()
  disconnect = vi.fn()
}

function mockBrowserHostRect() {
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
    bottom: 420,
    height: 300,
    left: 500,
    right: 900,
    top: 120,
    width: 400,
    x: 500,
    y: 120,
    toJSON: () => ({}),
  })
}

describe('WorkspaceBrowserPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.stubGlobal('ResizeObserver', ResizeObserverMock)
    embeddedBrowserMocks.canUseEmbeddedBrowser.mockReturnValue(true)
    embeddedBrowserMocks.consumeEmbeddedBrowserLabelTransfer.mockReturnValue(false)
    embeddedBrowserMocks.openEmbeddedBrowser.mockResolvedValue({
      title: null,
      url: 'https://example.com/',
    })
    embeddedBrowserMocks.readEmbeddedBrowserPageState.mockResolvedValue({
      title: 'Example Domain',
      url: 'https://example.com/',
    })
    embeddedBrowserMocks.closeEmbeddedBrowser.mockResolvedValue(undefined)
    embeddedBrowserMocks.evalEmbeddedBrowser.mockResolvedValue(undefined)
    embeddedBrowserMocks.evalEmbeddedBrowserJson.mockResolvedValue([])
    embeddedBrowserMocks.goBackEmbeddedBrowser.mockResolvedValue(undefined)
    embeddedBrowserMocks.goForwardEmbeddedBrowser.mockResolvedValue(undefined)
    embeddedBrowserMocks.navigateEmbeddedBrowser.mockResolvedValue(undefined)
    embeddedBrowserMocks.reloadEmbeddedBrowser.mockResolvedValue(undefined)
    embeddedBrowserMocks.setEmbeddedBrowserBounds.mockResolvedValue(undefined)
  })

  test('embeds a native browser webview and syncs its bounds', async () => {
    mockBrowserHostRect()
    render(<WorkspaceBrowserPanel active />)

    const input = screen.getByTestId('workspace-browser-url-input')
    fireEvent.change(input, { target: { value: 'example.com' } })
    fireEvent.submit(input.closest('form')!)

    await screen.findByTestId('workspace-browser-native-view')

    await waitFor(() => {
      expect(embeddedBrowserMocks.openEmbeddedBrowser).toHaveBeenCalledWith(
        'https://example.com/',
        {
          x: 500,
          y: 120,
          width: 400,
          height: 300,
        },
        'workspace-browser'
      )
    })

    await waitFor(() => {
      expect(embeddedBrowserMocks.setEmbeddedBrowserBounds).toHaveBeenCalledWith(
        {
          x: 500,
          y: 120,
          width: 400,
          height: 300,
        },
        true,
        'workspace-browser'
      )
    })
  })

  test('controls the embedded native browser from the toolbar and address bar', async () => {
    mockBrowserHostRect()
    render(<WorkspaceBrowserPanel active />)

    const input = screen.getByTestId('workspace-browser-url-input')
    fireEvent.change(input, { target: { value: 'example.com' } })
    fireEvent.submit(input.closest('form')!)

    await screen.findByTestId('workspace-browser-native-view')

    await waitFor(() => {
      expect(embeddedBrowserMocks.openEmbeddedBrowser).toHaveBeenCalled()
    })

    fireEvent.click(screen.getByTestId('workspace-browser-back-button'))
    fireEvent.click(screen.getByTestId('workspace-browser-forward-button'))
    fireEvent.click(screen.getByTestId('workspace-browser-reload-button'))

    fireEvent.change(input, { target: { value: 'https://openai.com' } })
    fireEvent.submit(input.closest('form')!)

    await waitFor(() => {
      expect(embeddedBrowserMocks.goBackEmbeddedBrowser).toHaveBeenCalled()
      expect(embeddedBrowserMocks.goForwardEmbeddedBrowser).toHaveBeenCalled()
      expect(embeddedBrowserMocks.reloadEmbeddedBrowser).toHaveBeenCalledWith('workspace-browser')
      expect(embeddedBrowserMocks.navigateEmbeddedBrowser).toHaveBeenCalledWith(
        'https://openai.com/',
        'workspace-browser'
      )
    })
  })

  test('opens the embedded browser from an external open request', async () => {
    mockBrowserHostRect()
    embeddedBrowserMocks.openEmbeddedBrowser.mockResolvedValueOnce({
      title: null,
      url: 'https://example.test/',
    })
    render(
      <WorkspaceBrowserPanel
        active
        openRequest={{ id: 1, label: 'workspace-browser', url: 'https://example.test/' }}
      />
    )

    await screen.findByTestId('workspace-browser-native-view')

    await waitFor(() => {
      expect(embeddedBrowserMocks.openEmbeddedBrowser).toHaveBeenCalledWith(
        'https://example.test/',
        {
          x: 500,
          y: 120,
          width: 400,
          height: 300,
        },
        'workspace-browser'
      )
    })
    expect(screen.getByTestId('workspace-browser-url-input')).toHaveValue('https://example.test/')
  })

  test('hides the native browser when the browser panel becomes inactive', async () => {
    mockBrowserHostRect()
    const { rerender } = render(<WorkspaceBrowserPanel active />)

    const input = screen.getByTestId('workspace-browser-url-input')
    fireEvent.change(input, { target: { value: 'example.com' } })
    fireEvent.submit(input.closest('form')!)

    await waitFor(() => {
      expect(embeddedBrowserMocks.openEmbeddedBrowser).toHaveBeenCalled()
    })

    embeddedBrowserMocks.setEmbeddedBrowserBounds.mockClear()
    rerender(<WorkspaceBrowserPanel active={false} />)

    await waitFor(() => {
      expect(embeddedBrowserMocks.setEmbeddedBrowserBounds).toHaveBeenCalledWith(
        {
          x: 0,
          y: 0,
          width: 1,
          height: 1,
        },
        false,
        'workspace-browser'
      )
    })
  })

  test('creates only a code comment context from a browser annotation', async () => {
    mockBrowserHostRect()
    const onAddCodeComment = vi.fn()
    embeddedBrowserMocks.evalEmbeddedBrowserJson.mockResolvedValueOnce([
      {
        id: 'browser-annotation-1',
        number: 1,
        comment: '这里导航太抢眼',
        x: 20,
        y: 30,
        width: 140,
        height: 120,
      },
    ])
    render(<WorkspaceBrowserPanel active onAddCodeComment={onAddCodeComment} />)

    const input = screen.getByTestId('workspace-browser-url-input')
    fireEvent.change(input, { target: { value: 'example.com' } })
    fireEvent.submit(input.closest('form')!)

    await waitFor(() => {
      expect(embeddedBrowserMocks.openEmbeddedBrowser).toHaveBeenCalled()
    })

    fireEvent.click(screen.getByTestId('workspace-browser-annotate-button'))

    await waitFor(() => {
      expect(embeddedBrowserMocks.evalEmbeddedBrowser).toHaveBeenCalledWith(
        expect.stringContaining('__wework_browser_annotation_layer__'),
        'workspace-browser'
      )
    })

    await waitFor(() => {
      expect(onAddCodeComment).toHaveBeenCalledWith(
        expect.objectContaining({
          filePath: 'browser:https://example.com/',
          fileName: 'example.com',
          comment: '这里导航太抢眼',
        })
      )
    })
    expect(screen.getByTestId('workspace-browser-annotation-count')).toHaveTextContent('1')
  })
})
