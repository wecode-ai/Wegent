import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import '@/i18n'
import { resetEmbeddedBrowserDownloadStoreForTests } from '@/lib/embedded-browser-download-store'
import type { BrowserAnnotationState } from '@/types/browser-annotation'
import { WorkspaceBrowserPanel } from './WorkspaceBrowserPanel'

const cloudDesktopExtensionMock = vi.hoisted(() => ({
  available: true,
  DeviceAction: vi.fn(),
  isInternalPageUrl: vi.fn((value: string) => {
    try {
      return new URL(value, 'http://localhost').pathname.endsWith('/extension-page.html')
    } catch {
      return false
    }
  }),
  open: vi.fn(),
}))

vi.mock('@extensions/cloud-desktop', () => ({
  cloudDesktopExtension: cloudDesktopExtensionMock,
}))

const embeddedBrowserMocks = vi.hoisted(() => ({
  canUseEmbeddedBrowser: vi.fn(),
  captureEmbeddedBrowserSnapshot: vi.fn(),
  clearEmbeddedBrowserAnnotations: vi.fn(),
  clearEmbeddedBrowserData: vi.fn(),
  closeEmbeddedBrowser: vi.fn(),
  consumeEmbeddedBrowserLabelTransfer: vi.fn(),
  deleteEmbeddedBrowserDownload: vi.fn(),
  evalEmbeddedBrowser: vi.fn(),
  evalEmbeddedBrowserJson: vi.fn(),
  goBackEmbeddedBrowser: vi.fn(),
  goForwardEmbeddedBrowser: vi.fn(),
  isEmbeddedBrowserLabelTransferred: vi.fn(),
  listenEmbeddedBrowserAgentCursor: vi.fn(),
  listenEmbeddedBrowserAgentState: vi.fn(),
  listenEmbeddedBrowserAnnotationState: vi.fn(),
  listenEmbeddedBrowserAnnotationRequests: vi.fn(),
  listenEmbeddedBrowserCloseRequests: vi.fn(),
  listenEmbeddedBrowserDownloads: vi.fn(),
  listenEmbeddedBrowserInvalidTlsCertificates: vi.fn(),
  listenEmbeddedBrowserLocalFilePreview: vi.fn(),
  listenEmbeddedBrowserPageStateChanges: vi.fn(),
  navigateEmbeddedBrowser: vi.fn(),
  notifyEmbeddedBrowserAgentCursorArrived: vi.fn(),
  openEmbeddedBrowser: vi.fn(),
  pauseEmbeddedBrowserDownload: vi.fn(),
  readEmbeddedBrowserPageState: vi.fn(),
  readEmbeddedBrowserAnnotationState: vi.fn(),
  relabelEmbeddedBrowser: vi.fn(),
  reloadEmbeddedBrowser: vi.fn(),
  resumeEmbeddedBrowserDownload: vi.fn(),
  resolveEmbeddedBrowserAgentApproval: vi.fn(),
  setEmbeddedBrowserAgentControlPaused: vi.fn(),
  setEmbeddedBrowserActiveTab: vi.fn(),
  setEmbeddedBrowserBounds: vi.fn(),
  setEmbeddedBrowserDeviceMetrics: vi.fn(),
  setEmbeddedBrowserZoom: vi.fn(),
  setEmbeddedBrowserAnnotationOriginalView: vi.fn(),
  startEmbeddedBrowserAnnotation: vi.fn(),
  stopEmbeddedBrowserAnnotation: vi.fn(),
  EMBEDDED_BROWSER_DEBUG_PANEL_VISIBILITY_EVENT: 'wework:debug-panel-visibility-change',
  EMBEDDED_BROWSER_OCCLUSION_EVENT: 'wework:embedded-browser-occlusion-change',
}))

vi.mock('@/lib/embedded-browser', () => embeddedBrowserMocks)

vi.mock('@/lib/external-links', () => ({
  openExternalUrl: vi.fn(),
}))

const navigationMocks = vi.hoisted(() => ({
  navigateTo: vi.fn(),
}))

vi.mock('@/lib/navigation', () => navigationMocks)

const localTerminalMocks = vi.hoisted(() => ({
  revealLocalFile: vi.fn(),
}))

vi.mock('@/lib/local-terminal', () => localTerminalMocks)

class ResizeObserverMock {
  observe = vi.fn()
  unobserve = vi.fn()
  disconnect = vi.fn()
}

function annotationState(
  comments: Array<{
    id: string
    number: number
    comment: string
    designChanges?: Array<{
      property: string
      previousValue: string
      value: string
    }>
  }>,
  options: {
    mode?: 'off' | 'quick' | 'batch'
    revision?: number
    runtimeRevision?: number
    pageSessionId?: string
    originalView?: boolean
  } = {}
): BrowserAnnotationState {
  return {
    label: 'workspace-browser',
    mode: options.mode ?? 'batch',
    scope: {
      browserTabId: 'workspace-browser',
      pageSessionId: options.pageSessionId ?? 'page-session-1',
      url: 'https://example.com/',
    },
    revision: options.revision ?? 1,
    runtimeRevision: options.runtimeRevision ?? 1,
    comments: comments.map(comment => ({
      ...comment,
      anchor: {
        kind: 'element' as const,
        pageUrl: 'https://example.com/',
        frameUrl: 'https://example.com/',
        framePath: [],
        selector: '#example-target',
        elementPath: ['html', 'body', 'button#example-target'],
        tagName: 'button',
        role: 'button',
        name: 'Example target',
        immediateText: 'Example target',
        rect: { x: 20, y: 30, width: 140, height: 120 },
        fixedPosition: false,
        scrollContainers: [],
      },
      designChanges: comment.designChanges ?? [],
      textChange: null,
      screenshotDataUrl: 'data:image/png;base64,aW1hZ2U=',
      createdAt: '2026-08-11T00:00:00.000Z',
      updatedAt: '2026-08-11T00:00:00.000Z',
    })),
    originalView: options.originalView ?? false,
    unresolvedIds: [],
  }
}

// The downloads list only opens from the toolbar; download events surface a
// transient peek instead.
function openDownloadsPanel(container?: HTMLElement) {
  const scope = container ? within(container) : screen
  fireEvent.click(scope.getByTestId('workspace-browser-downloads-button'))
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

function createDeferred<T>() {
  let resolve: (value: T) => void = () => undefined
  const promise = new Promise<T>(nextResolve => {
    resolve = nextResolve
  })
  return { promise, resolve }
}

function dispatchBrowserOcclusionChange(id: string, occluded: boolean) {
  act(() => {
    window.dispatchEvent(
      new CustomEvent('wework:embedded-browser-occlusion-change', {
        detail: { id, occluded },
      })
    )
  })
}

describe('WorkspaceBrowserPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resetEmbeddedBrowserDownloadStoreForTests()
    vi.stubGlobal('ResizeObserver', ResizeObserverMock)
    embeddedBrowserMocks.canUseEmbeddedBrowser.mockReturnValue(true)
    embeddedBrowserMocks.captureEmbeddedBrowserSnapshot.mockResolvedValue(
      'data:image/png;base64,aW1hZ2U='
    )
    embeddedBrowserMocks.consumeEmbeddedBrowserLabelTransfer.mockReturnValue(false)
    embeddedBrowserMocks.isEmbeddedBrowserLabelTransferred.mockReturnValue(false)
    embeddedBrowserMocks.listenEmbeddedBrowserAgentState.mockReturnValue(null)
    embeddedBrowserMocks.listenEmbeddedBrowserAnnotationState.mockReturnValue(null)
    embeddedBrowserMocks.listenEmbeddedBrowserAnnotationRequests.mockReturnValue(null)
    embeddedBrowserMocks.listenEmbeddedBrowserAgentCursor.mockReturnValue(null)
    embeddedBrowserMocks.listenEmbeddedBrowserCloseRequests.mockReturnValue(null)
    embeddedBrowserMocks.listenEmbeddedBrowserDownloads.mockReturnValue(null)
    embeddedBrowserMocks.listenEmbeddedBrowserInvalidTlsCertificates.mockReturnValue(null)
    embeddedBrowserMocks.listenEmbeddedBrowserLocalFilePreview.mockReturnValue(null)
    embeddedBrowserMocks.listenEmbeddedBrowserPageStateChanges.mockReturnValue(null)
    localTerminalMocks.revealLocalFile.mockResolvedValue(undefined)
    embeddedBrowserMocks.openEmbeddedBrowser.mockResolvedValue({
      nativeLabel: 'workspace-browser-native-1',
      title: null,
      url: 'https://example.com/',
      isLoading: false,
    })
    embeddedBrowserMocks.readEmbeddedBrowserPageState.mockResolvedValue({
      nativeLabel: 'workspace-browser-native-1',
      title: 'Example Domain',
      url: 'https://example.com/',
      isLoading: false,
    })
    embeddedBrowserMocks.readEmbeddedBrowserAnnotationState.mockResolvedValue({
      label: 'workspace-browser',
      mode: 'off',
      scope: null,
      revision: 0,
      runtimeRevision: 0,
      comments: [],
      originalView: false,
      unresolvedIds: [],
    })
    embeddedBrowserMocks.clearEmbeddedBrowserAnnotations.mockResolvedValue(undefined)
    embeddedBrowserMocks.closeEmbeddedBrowser.mockResolvedValue(undefined)
    embeddedBrowserMocks.clearEmbeddedBrowserData.mockResolvedValue(1)
    embeddedBrowserMocks.evalEmbeddedBrowser.mockResolvedValue(undefined)
    embeddedBrowserMocks.evalEmbeddedBrowserJson.mockResolvedValue(null)
    embeddedBrowserMocks.goBackEmbeddedBrowser.mockResolvedValue(undefined)
    embeddedBrowserMocks.goForwardEmbeddedBrowser.mockResolvedValue(undefined)
    embeddedBrowserMocks.navigateEmbeddedBrowser.mockResolvedValue(undefined)
    embeddedBrowserMocks.reloadEmbeddedBrowser.mockResolvedValue(undefined)
    embeddedBrowserMocks.resumeEmbeddedBrowserDownload.mockResolvedValue(undefined)
    embeddedBrowserMocks.resolveEmbeddedBrowserAgentApproval.mockResolvedValue(undefined)
    embeddedBrowserMocks.setEmbeddedBrowserAgentControlPaused.mockResolvedValue(undefined)
    embeddedBrowserMocks.setEmbeddedBrowserBounds.mockResolvedValue(undefined)
    embeddedBrowserMocks.setEmbeddedBrowserZoom.mockResolvedValue(undefined)
    embeddedBrowserMocks.setEmbeddedBrowserAnnotationOriginalView.mockResolvedValue(undefined)
    embeddedBrowserMocks.startEmbeddedBrowserAnnotation.mockResolvedValue(undefined)
    embeddedBrowserMocks.stopEmbeddedBrowserAnnotation.mockResolvedValue(undefined)
  })

  test('disables text correction in the browser address bar', () => {
    render(<WorkspaceBrowserPanel active />)

    expect(screen.getByTestId('workspace-browser-url-input')).toHaveAttribute(
      'autocapitalize',
      'none'
    )
    expect(screen.getByTestId('workspace-browser-url-input')).toHaveAttribute('autocomplete', 'off')
    expect(screen.getByTestId('workspace-browser-url-input')).toHaveAttribute('autocorrect', 'off')
    expect(screen.getByTestId('workspace-browser-url-input')).toHaveAttribute('spellcheck', 'false')
  })

  test('renders a transferred page on the first frame without reopening the browser', async () => {
    render(
      <WorkspaceBrowserPanel
        active
        label="workspace-browser-runtime-1"
        transferFromLabel="workspace-browser-blank-0"
        transferredNativeLabel="workspace-browser-native-1"
        transferredUrl="https://www.baidu.com/"
      />
    )

    expect(screen.getByTestId('workspace-browser-url-input')).toHaveValue('https://www.baidu.com/')
    expect(screen.getByTestId('workspace-browser-native-view')).toBeInTheDocument()

    await act(async () => {
      await Promise.resolve()
    })
    expect(embeddedBrowserMocks.openEmbeddedBrowser).not.toHaveBeenCalled()
  })

  test('clears cookies from the browser actions submenu and reports completion', async () => {
    render(<WorkspaceBrowserPanel active />)

    fireEvent.click(screen.getByTestId('workspace-browser-more-button'))
    fireEvent.click(screen.getByTestId('workspace-browser-clear-data-item'))
    fireEvent.click(screen.getByTestId('workspace-browser-clear-cookies-item'))

    expect(screen.getByTestId('transient-notice')).toHaveTextContent('开始清除浏览数据')
    await waitFor(() => {
      expect(embeddedBrowserMocks.clearEmbeddedBrowserData).toHaveBeenCalledWith(['cookies'])
    })

    await waitFor(() => {
      expect(screen.getByTestId('transient-notice')).toHaveTextContent('浏览数据已清除')
    })
  })

  test('clears cache and storage from the browser actions submenu and reports completion', async () => {
    render(<WorkspaceBrowserPanel active />)

    fireEvent.click(screen.getByTestId('workspace-browser-more-button'))
    fireEvent.click(screen.getByTestId('workspace-browser-clear-data-item'))
    fireEvent.click(screen.getByTestId('workspace-browser-clear-cache-item'))

    expect(screen.getByTestId('transient-notice')).toHaveTextContent('开始清除浏览数据')
    await waitFor(() => {
      expect(embeddedBrowserMocks.clearEmbeddedBrowserData).toHaveBeenCalledWith([
        'cache',
        'storage',
      ])
    })

    await waitFor(() => {
      expect(screen.getByTestId('transient-notice')).toHaveTextContent('浏览数据已清除')
    })
  })

  test('hides the clear-data notice while the browser panel is inactive', async () => {
    vi.useFakeTimers()
    const clearData = createDeferred<number>()
    embeddedBrowserMocks.clearEmbeddedBrowserData.mockReturnValueOnce(clearData.promise)
    const view = render(<WorkspaceBrowserPanel active />)

    try {
      fireEvent.click(screen.getByTestId('workspace-browser-more-button'))
      fireEvent.click(screen.getByTestId('workspace-browser-clear-data-item'))
      fireEvent.click(screen.getByTestId('workspace-browser-clear-cache-item'))
      expect(screen.getByTestId('transient-notice')).toHaveTextContent('开始清除浏览数据')

      view.rerender(<WorkspaceBrowserPanel active={false} />)
      expect(screen.queryByTestId('transient-notice')).not.toBeInTheDocument()

      await act(async () => {
        await vi.advanceTimersByTimeAsync(600)
      })
      expect(embeddedBrowserMocks.clearEmbeddedBrowserData).toHaveBeenCalledWith([
        'cache',
        'storage',
      ])

      await act(async () => {
        clearData.resolve(1)
        await clearData.promise
        await Promise.resolve()
      })
      expect(screen.queryByTestId('transient-notice')).not.toBeInTheDocument()
    } finally {
      vi.useRealTimers()
    }
  })

  test('reports a failed browser data clear', async () => {
    embeddedBrowserMocks.clearEmbeddedBrowserData.mockRejectedValueOnce(new Error('failed'))
    render(<WorkspaceBrowserPanel active />)

    fireEvent.click(screen.getByTestId('workspace-browser-more-button'))
    fireEvent.click(screen.getByTestId('workspace-browser-clear-data-item'))
    fireEvent.click(screen.getByTestId('workspace-browser-clear-cache-item'))

    await waitFor(() => {
      expect(embeddedBrowserMocks.clearEmbeddedBrowserData).toHaveBeenCalledWith([
        'cache',
        'storage',
      ])
    })
    await waitFor(() => {
      expect(screen.getByTestId('transient-notice')).toHaveTextContent('清除失败，请重试')
    })
  })

  test('embeds a native browser webview and syncs its bounds', async () => {
    mockBrowserHostRect()
    render(<WorkspaceBrowserPanel active />)

    expect(screen.getByTestId('workspace-browser-panel')).toHaveAttribute(
      'data-embedded-browser-label',
      'workspace-browser'
    )
    const input = screen.getByTestId('workspace-browser-url-input')
    fireEvent.change(input, { target: { value: 'example.com' } })
    fireEvent.submit(input.closest('form')!)

    await screen.findByTestId('workspace-browser-native-view')

    await waitFor(() => {
      expect(embeddedBrowserMocks.openEmbeddedBrowser).toHaveBeenCalledWith(
        'http://example.com/',
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

  test('stops stale bounds updates after the browser label transfers to another pane', async () => {
    mockBrowserHostRect()
    render(<WorkspaceBrowserPanel active />)

    const input = screen.getByTestId('workspace-browser-url-input')
    fireEvent.change(input, { target: { value: 'example.com' } })
    fireEvent.submit(input.closest('form')!)

    await waitFor(() => {
      expect(embeddedBrowserMocks.setEmbeddedBrowserBounds).toHaveBeenCalled()
    })
    embeddedBrowserMocks.setEmbeddedBrowserBounds.mockClear()
    embeddedBrowserMocks.isEmbeddedBrowserLabelTransferred.mockReturnValue(true)

    fireEvent(window, new Event('resize'))
    await act(async () => {
      await new Promise(resolve => window.setTimeout(resolve, 120))
    })

    expect(embeddedBrowserMocks.setEmbeddedBrowserBounds).not.toHaveBeenCalled()
  })

  test('opens local filesystem paths from the address bar as file URLs', async () => {
    mockBrowserHostRect()
    embeddedBrowserMocks.openEmbeddedBrowser.mockResolvedValueOnce({
      nativeLabel: 'workspace-browser-native-1',
      title: 'Local report',
      url: 'file:///Users/me/test%20file.html',
    })
    render(<WorkspaceBrowserPanel active />)

    const input = screen.getByTestId('workspace-browser-url-input')
    fireEvent.change(input, { target: { value: '/Users/me/test file.html' } })
    fireEvent.submit(input.closest('form')!)

    await screen.findByTestId('workspace-browser-native-view')

    await waitFor(() => {
      expect(embeddedBrowserMocks.openEmbeddedBrowser).toHaveBeenCalledWith(
        'file:///Users/me/test%20file.html',
        {
          x: 500,
          y: 120,
          width: 400,
          height: 300,
        },
        'workspace-browser'
      )
    })
  })

  test('uses concise tab titles for local files and directories', async () => {
    const onTitleChange = vi.fn()
    mockBrowserHostRect()
    embeddedBrowserMocks.openEmbeddedBrowser.mockResolvedValueOnce({
      nativeLabel: 'workspace-browser-native-1',
      title: null,
      url: 'file:///Users/me/test%20file.md',
    })
    const { rerender } = render(<WorkspaceBrowserPanel active onTitleChange={onTitleChange} />)

    const input = screen.getByTestId('workspace-browser-url-input')
    fireEvent.change(input, { target: { value: '/Users/me/test file.md' } })
    fireEvent.submit(input.closest('form')!)

    await waitFor(() => expect(onTitleChange).toHaveBeenCalledWith('test file.md'))
    expect(onTitleChange).not.toHaveBeenCalledWith('file:///Users/me/test%20file.md')

    onTitleChange.mockClear()
    embeddedBrowserMocks.openEmbeddedBrowser.mockResolvedValueOnce({
      nativeLabel: 'workspace-browser-native-1',
      title: null,
      url: 'file:///Users/me/',
    })
    rerender(<WorkspaceBrowserPanel active={false} onTitleChange={onTitleChange} />)
    rerender(<WorkspaceBrowserPanel active onTitleChange={onTitleChange} />)

    fireEvent.change(input, { target: { value: '/Users/me/' } })
    fireEvent.submit(input.closest('form')!)

    await waitFor(() => expect(onTitleChange).toHaveBeenCalledWith('Index of /Users/me'))
    expect(onTitleChange).not.toHaveBeenCalledWith('file:///Users/me/')
  })

  test('syncs the address bar when native browser navigation changes the page URL', async () => {
    let handlePageStateChange!: (pageState: {
      label: string
      nativeLabel: string
      title: string | null
      url: string | null
      isLoading: boolean
      invalidTlsCertificate?: null
    }) => void
    embeddedBrowserMocks.listenEmbeddedBrowserPageStateChanges.mockImplementation(handler => {
      handlePageStateChange = handler
      return Promise.resolve(() => undefined)
    })
    mockBrowserHostRect()
    embeddedBrowserMocks.openEmbeddedBrowser.mockResolvedValueOnce({
      nativeLabel: 'workspace-browser-native-1',
      title: 'Users',
      url: 'file:///Users/',
      isLoading: false,
    })
    render(<WorkspaceBrowserPanel active />)

    const input = screen.getByTestId('workspace-browser-url-input')
    fireEvent.focus(input)
    fireEvent.change(input, { target: { value: '/Users' } })
    fireEvent.submit(input.closest('form')!)
    await waitFor(() => expect(embeddedBrowserMocks.openEmbeddedBrowser).toHaveBeenCalled())

    act(() => {
      handlePageStateChange({
        label: 'workspace-browser',
        nativeLabel: 'workspace-browser-native-1',
        title: 'mowei',
        url: 'file:///Users/mowei/',
        isLoading: false,
        invalidTlsCertificate: null,
      })
    })

    expect(input).toHaveValue('file:///Users/mowei/')
  })

  test('keeps annotation mode when a delayed page state is no longer authoritative', async () => {
    let handlePageStateChange!: (pageState: {
      label: string
      nativeLabel: string
      title: string | null
      url: string | null
      isLoading: boolean
    }) => void
    embeddedBrowserMocks.listenEmbeddedBrowserPageStateChanges.mockImplementation(handler => {
      handlePageStateChange = handler
      return Promise.resolve(() => undefined)
    })
    mockBrowserHostRect()
    render(<WorkspaceBrowserPanel active />)

    const input = screen.getByTestId('workspace-browser-url-input')
    fireEvent.change(input, { target: { value: 'https://example.com/' } })
    fireEvent.submit(input.closest('form')!)
    await screen.findByTestId('workspace-browser-native-view')
    fireEvent.click(screen.getByTestId('workspace-browser-annotate-button'))
    await screen.findByTestId('workspace-browser-annotation-close-button')

    embeddedBrowserMocks.readEmbeddedBrowserPageState.mockClear()
    act(() => {
      handlePageStateChange({
        label: 'workspace-browser',
        nativeLabel: 'workspace-browser-native-1',
        title: 'Previous page',
        url: 'https://previous.example/',
        isLoading: false,
      })
    })

    await waitFor(() =>
      expect(embeddedBrowserMocks.readEmbeddedBrowserPageState).toHaveBeenCalled()
    )
    expect(screen.getByTestId('workspace-browser-annotation-close-button')).toBeInTheDocument()
    expect(input).toHaveValue('https://example.com/')
  })

  test('reports native page loading for the owning browser tab', () => {
    let handlePageStateChange!: (pageState: {
      label: string
      nativeLabel: string
      title: string | null
      url: string | null
      isLoading: boolean
    }) => void
    const onLoadingChange = vi.fn()
    embeddedBrowserMocks.listenEmbeddedBrowserPageStateChanges.mockImplementation(handler => {
      handlePageStateChange = handler
      return Promise.resolve(() => undefined)
    })

    render(<WorkspaceBrowserPanel active={false} onLoadingChange={onLoadingChange} />)

    act(() => {
      handlePageStateChange({
        label: 'workspace-browser',
        nativeLabel: 'workspace-browser-native-1',
        title: null,
        url: 'https://example.com/',
        isLoading: true,
      })
    })
    expect(onLoadingChange).toHaveBeenLastCalledWith(true)

    act(() => {
      handlePageStateChange({
        label: 'workspace-browser',
        nativeLabel: 'workspace-browser-native-1',
        title: 'Example Domain',
        url: 'https://example.com/',
        isLoading: false,
      })
    })
    expect(onLoadingChange).toHaveBeenLastCalledWith(false)
  })

  test('reports loading immediately when reloading an open native browser', async () => {
    const reload = createDeferred<void>()
    const onLoadingChange = vi.fn()
    embeddedBrowserMocks.reloadEmbeddedBrowser.mockReturnValueOnce(reload.promise)
    mockBrowserHostRect()
    render(<WorkspaceBrowserPanel active onLoadingChange={onLoadingChange} />)

    const input = screen.getByTestId('workspace-browser-url-input')
    fireEvent.change(input, { target: { value: 'https://example.com' } })
    fireEvent.submit(input.closest('form')!)
    await waitFor(() => expect(embeddedBrowserMocks.openEmbeddedBrowser).toHaveBeenCalled())
    await waitFor(() => expect(onLoadingChange).toHaveBeenLastCalledWith(false))

    fireEvent.click(screen.getByTestId('workspace-browser-reload-button'))

    await waitFor(() => expect(onLoadingChange).toHaveBeenLastCalledWith(true))
    expect(embeddedBrowserMocks.reloadEmbeddedBrowser).toHaveBeenCalledWith('workspace-browser')

    reload.resolve()
    await waitFor(() => expect(onLoadingChange).toHaveBeenLastCalledWith(false))
  })

  test('replaces a failed native page with a clear error state and stops loading', async () => {
    let handlePageStateChange!: (pageState: {
      label: string
      nativeLabel: string
      title: string | null
      url: string | null
      isLoading: boolean
      navigationError?: {
        code: number
        message: string
        url: string | null
      } | null
    }) => void
    const onLoadingChange = vi.fn()
    embeddedBrowserMocks.listenEmbeddedBrowserPageStateChanges.mockImplementation(handler => {
      handlePageStateChange = handler
      return Promise.resolve(() => undefined)
    })
    mockBrowserHostRect()
    render(<WorkspaceBrowserPanel active onLoadingChange={onLoadingChange} />)

    const input = screen.getByTestId('workspace-browser-url-input')
    fireEvent.change(input, { target: { value: 'http://localhost:3000' } })
    fireEvent.submit(input.closest('form')!)
    await waitFor(() => expect(embeddedBrowserMocks.openEmbeddedBrowser).toHaveBeenCalled())

    act(() => {
      handlePageStateChange({
        label: 'workspace-browser',
        nativeLabel: 'workspace-browser-native-1',
        title: null,
        url: 'http://localhost:3000/',
        isLoading: true,
        navigationError: null,
      })
    })
    expect(onLoadingChange).toHaveBeenLastCalledWith(true)

    act(() => {
      handlePageStateChange({
        label: 'workspace-browser',
        nativeLabel: 'workspace-browser-native-1',
        title: null,
        url: 'http://localhost:3000/',
        isLoading: false,
        navigationError: {
          code: -1004,
          message: 'Could not connect to the server.',
          url: 'http://localhost:3000/',
        },
      })
    })

    const failure = screen.getByTestId('workspace-browser-navigation-error')
    expect(failure).toHaveTextContent('页面无法打开')
    expect(failure).toHaveTextContent('请检查地址或网络连接，然后重新加载。')
    expect(screen.queryByTestId('workspace-browser-loading')).not.toBeInTheDocument()
    expect(onLoadingChange).toHaveBeenLastCalledWith(false)
    await waitFor(() => {
      expect(embeddedBrowserMocks.setEmbeddedBrowserBounds).toHaveBeenLastCalledWith(
        {
          x: 500,
          y: 120,
          width: 400,
          height: 300,
        },
        false,
        'workspace-browser'
      )
    })
  })

  test('warns when the native browser accepts an invalid TLS certificate', async () => {
    let handleInvalidCertificate!: (certificate: {
      nativeLabel: string
      url: string
      host: string
      port: number
    }) => void
    embeddedBrowserMocks.listenEmbeddedBrowserInvalidTlsCertificates.mockImplementation(handler => {
      handleInvalidCertificate = handler
      return null
    })
    mockBrowserHostRect()
    render(<WorkspaceBrowserPanel active />)

    const input = screen.getByTestId('workspace-browser-url-input')
    fireEvent.change(input, { target: { value: 'https://self-signed.example.test' } })
    fireEvent.submit(input.closest('form')!)
    await waitFor(() => expect(embeddedBrowserMocks.openEmbeddedBrowser).toHaveBeenCalled())

    act(() => {
      handleInvalidCertificate({
        nativeLabel: 'workspace-browser-native-1',
        url: 'https://self-signed.example.test/',
        host: 'self-signed.example.test',
        port: 443,
      })
    })

    expect(screen.getByTestId('workspace-browser-invalid-tls-warning')).toHaveTextContent(
      '此连接的证书无效'
    )
    expect(screen.getByTestId('workspace-browser-invalid-tls-warning')).toHaveTextContent(
      'self-signed.example.test'
    )
  })

  test('shows a transient toast when a local file cannot be previewed', async () => {
    let handleLocalFilePreview!: (event: {
      label: string
      nativeLabel: string
      url: string
    }) => void
    embeddedBrowserMocks.listenEmbeddedBrowserLocalFilePreview.mockImplementation(handler => {
      handleLocalFilePreview = handler
      return null
    })
    mockBrowserHostRect()
    render(<WorkspaceBrowserPanel active />)

    const input = screen.getByTestId('workspace-browser-url-input')
    fireEvent.change(input, { target: { value: 'file:///Users/me/archive.zip' } })
    fireEvent.submit(input.closest('form')!)
    await waitFor(() => expect(embeddedBrowserMocks.openEmbeddedBrowser).toHaveBeenCalled())

    act(() => {
      handleLocalFilePreview({
        label: 'workspace-browser',
        nativeLabel: 'workspace-browser-native-1',
        url: 'file:///Users/me/archive.zip',
      })
    })

    const notice = screen.getByTestId('transient-notice')
    expect(notice).toHaveTextContent('此文件无法预览')

    await waitFor(
      () => {
        expect(screen.queryByTestId('transient-notice')).not.toBeInTheDocument()
      },
      { timeout: 3000 }
    )
  })

  test('shows an invalid TLS warning returned during the initial browser open', async () => {
    embeddedBrowserMocks.openEmbeddedBrowser.mockResolvedValueOnce({
      nativeLabel: 'workspace-browser-native-1',
      title: 'Internal service',
      url: 'https://internal.example.test/',
      invalidTlsCertificate: {
        nativeLabel: 'workspace-browser-native-1',
        url: 'https://internal.example.test/',
        host: 'internal.example.test',
        port: 443,
      },
    })
    mockBrowserHostRect()
    render(<WorkspaceBrowserPanel active />)

    const input = screen.getByTestId('workspace-browser-url-input')
    fireEvent.change(input, { target: { value: 'https://internal.example.test' } })
    fireEvent.submit(input.closest('form')!)

    expect(await screen.findByTestId('workspace-browser-invalid-tls-warning')).toHaveTextContent(
      'internal.example.test'
    )
  })

  test('preserves an invalid TLS warning during same-origin navigation', async () => {
    const invalidTlsCertificate = {
      nativeLabel: 'workspace-browser-native-1',
      url: 'https://internal.example.test/start',
      host: 'internal.example.test',
      port: 443,
    }
    embeddedBrowserMocks.openEmbeddedBrowser.mockResolvedValueOnce({
      nativeLabel: 'workspace-browser-native-1',
      title: 'Internal service',
      url: invalidTlsCertificate.url,
      invalidTlsCertificate,
    })
    embeddedBrowserMocks.readEmbeddedBrowserPageState.mockResolvedValue({
      nativeLabel: 'workspace-browser-native-1',
      title: 'Internal service',
      url: 'https://internal.example.test/next',
      invalidTlsCertificate,
    })
    mockBrowserHostRect()
    render(<WorkspaceBrowserPanel active />)

    const input = screen.getByTestId('workspace-browser-url-input')
    fireEvent.change(input, { target: { value: invalidTlsCertificate.url } })
    fireEvent.submit(input.closest('form')!)
    await screen.findByTestId('workspace-browser-invalid-tls-warning')

    fireEvent.change(input, { target: { value: 'https://internal.example.test/next' } })
    fireEvent.submit(input.closest('form')!)

    await waitFor(() => {
      expect(embeddedBrowserMocks.navigateEmbeddedBrowser).toHaveBeenCalledWith(
        'https://internal.example.test/next',
        'workspace-browser'
      )
    })
    expect(screen.getByTestId('workspace-browser-invalid-tls-warning')).toHaveTextContent(
      'internal.example.test'
    )
  })

  test('hides the native browser webview before the main page reloads', async () => {
    mockBrowserHostRect()
    render(<WorkspaceBrowserPanel active />)

    const input = screen.getByTestId('workspace-browser-url-input')
    fireEvent.change(input, { target: { value: 'example.com' } })
    fireEvent.submit(input.closest('form')!)
    await waitFor(() => expect(embeddedBrowserMocks.openEmbeddedBrowser).toHaveBeenCalled())

    window.dispatchEvent(new PageTransitionEvent('pagehide'))

    await waitFor(() => {
      expect(embeddedBrowserMocks.setEmbeddedBrowserBounds).toHaveBeenCalledWith(
        { x: 0, y: 0, width: 1, height: 1 },
        false,
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

  test('opens the native browser again when the first open fails', async () => {
    embeddedBrowserMocks.openEmbeddedBrowser.mockRejectedValueOnce(
      new Error('Timed out waiting for embedded browser host bounds')
    )
    embeddedBrowserMocks.readEmbeddedBrowserPageState.mockRejectedValue(
      new Error('No embedded browser is open')
    )
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    mockBrowserHostRect()
    render(<WorkspaceBrowserPanel active />)

    const input = screen.getByTestId('workspace-browser-url-input')
    fireEvent.change(input, { target: { value: 'example.com' } })
    fireEvent.submit(input.closest('form')!)

    expect(
      await screen.findByTestId('workspace-browser-error', {}, { timeout: 2000 })
    ).toHaveTextContent('无法打开应用内浏览器')
    expect(embeddedBrowserMocks.openEmbeddedBrowser).toHaveBeenCalledTimes(1)

    fireEvent.submit(input.closest('form')!)

    await waitFor(() => {
      expect(embeddedBrowserMocks.openEmbeddedBrowser).toHaveBeenCalledTimes(2)
    })
    expect(embeddedBrowserMocks.reloadEmbeddedBrowser).not.toHaveBeenCalled()
    await waitFor(() => {
      expect(screen.queryByTestId('workspace-browser-error')).not.toBeInTheDocument()
    })
    consoleError.mockRestore()
  })

  test('reports active agent control without adding a running status bar', () => {
    let handleAgentState!: (event: {
      label: string
      status: string
      action: string | null
      target: string | null
      message: string | null
      errorCode: string | null
      createdAtUnixMs: number
    }) => void
    embeddedBrowserMocks.listenEmbeddedBrowserAgentState.mockImplementation(handler => {
      handleAgentState = handler
      return null
    })

    const onAgentActiveChange = vi.fn()
    render(<WorkspaceBrowserPanel active onAgentActiveChange={onAgentActiveChange} />)

    act(() => {
      handleAgentState({
        label: 'workspace-browser',
        status: 'running',
        action: 'click',
        target: 'index 2',
        message: null,
        errorCode: null,
        approval: null,
        createdAtUnixMs: Date.now(),
      })
    })

    expect(screen.queryByTestId('workspace-browser-agent-status')).not.toBeInTheDocument()
    expect(onAgentActiveChange).toHaveBeenLastCalledWith(true)
  })

  test('keeps the tab agent icon active while the cursor remains visible', () => {
    let handleAgentState!: (event: {
      label: string
      status: string
      action: string | null
      target: string | null
      message: string | null
      errorCode: string | null
      createdAtUnixMs: number
    }) => void
    let handleAgentCursor!: (event: {
      label: string
      visible: boolean
      x: number
      y: number
      animateMovement: boolean
      moveSequence: number
      createdAtUnixMs: number
    }) => void
    embeddedBrowserMocks.listenEmbeddedBrowserAgentState.mockImplementation(handler => {
      handleAgentState = handler
      return null
    })
    embeddedBrowserMocks.listenEmbeddedBrowserAgentCursor.mockImplementation(handler => {
      handleAgentCursor = handler
      return null
    })

    const onAgentActiveChange = vi.fn()
    render(<WorkspaceBrowserPanel active onAgentActiveChange={onAgentActiveChange} />)

    act(() => {
      handleAgentCursor({
        label: 'workspace-browser',
        visible: true,
        x: 100,
        y: 50,
        animateMovement: true,
        moveSequence: 1,
        createdAtUnixMs: Date.now(),
      })
      handleAgentState({
        label: 'workspace-browser',
        status: 'idle',
        action: 'click',
        target: 'index 2',
        message: null,
        errorCode: null,
        approval: null,
        createdAtUnixMs: Date.now(),
      })
    })

    expect(onAgentActiveChange).toHaveBeenLastCalledWith(true)

    act(() => {
      handleAgentCursor({
        label: 'workspace-browser',
        visible: false,
        x: 100,
        y: 50,
        animateMovement: false,
        moveSequence: 1,
        createdAtUnixMs: Date.now(),
      })
    })

    expect(onAgentActiveChange).toHaveBeenLastCalledWith(false)
  })

  test('clears visible agent cursor activity when the browser closes', async () => {
    let handleAgentCursor!: (event: {
      label: string
      visible: boolean
      x: number
      y: number
      animateMovement: boolean
      moveSequence: number
      createdAtUnixMs: number
    }) => void
    let handleClose!: (event: { label: string; nativeLabel: string }) => void
    embeddedBrowserMocks.listenEmbeddedBrowserAgentCursor.mockImplementation(handler => {
      handleAgentCursor = handler
      return null
    })
    embeddedBrowserMocks.listenEmbeddedBrowserCloseRequests.mockImplementation(handler => {
      handleClose = handler
      return Promise.resolve(vi.fn())
    })
    const onAgentActiveChange = vi.fn()
    render(<WorkspaceBrowserPanel active onAgentActiveChange={onAgentActiveChange} />)
    await screen.findByTestId('workspace-browser-native-view')

    act(() => {
      handleAgentCursor({
        label: 'workspace-browser',
        visible: true,
        x: 100,
        y: 50,
        animateMovement: true,
        moveSequence: 1,
        createdAtUnixMs: Date.now(),
      })
    })
    expect(onAgentActiveChange).toHaveBeenLastCalledWith(true)

    act(() => {
      handleClose({
        label: 'workspace-browser',
        nativeLabel: 'workspace-browser-native-1',
      })
    })

    expect(onAgentActiveChange).toHaveBeenLastCalledWith(false)
  })

  test('keeps agent control paused until the user returns it to AI', async () => {
    let handleAgentState!: (event: {
      label: string
      status: string
      action: string | null
      target: string | null
      message: string | null
      errorCode: string | null
      createdAtUnixMs: number
    }) => void
    embeddedBrowserMocks.listenEmbeddedBrowserAgentState.mockImplementation(handler => {
      handleAgentState = handler
      return null
    })

    render(<WorkspaceBrowserPanel active />)

    act(() => {
      handleAgentState({
        label: 'workspace-browser',
        status: 'paused',
        action: null,
        target: null,
        message: null,
        errorCode: null,
        approval: null,
        createdAtUnixMs: Date.now(),
      })
    })

    expect(screen.getByTestId('workspace-browser-agent-status')).toHaveTextContent(
      '你正在接管浏览器'
    )
    fireEvent.click(screen.getByTestId('workspace-browser-agent-resume-button'))
    expect(embeddedBrowserMocks.setEmbeddedBrowserAgentControlPaused).toHaveBeenCalledWith(
      false,
      'workspace-browser'
    )
  })

  test('shows high-risk agent approval controls', async () => {
    let handleAgentState!: (event: {
      label: string
      status: string
      action: string | null
      target: string | null
      message: string | null
      errorCode: string | null
      approval: {
        approvalId: string
        risk: string
        actionKind: string
        reason: string
        target: unknown | null
        expiresAtUnixMs: number
      } | null
      createdAtUnixMs: number
    }) => void
    embeddedBrowserMocks.listenEmbeddedBrowserAgentState.mockImplementation(handler => {
      handleAgentState = handler
      return null
    })

    render(<WorkspaceBrowserPanel active />)

    act(() => {
      handleAgentState({
        label: 'workspace-browser',
        status: 'needs_user',
        action: 'click',
        target: 'index 3',
        message: 'This button submits the form.',
        errorCode: 'approval_required',
        approval: {
          approvalId: 'browser-approval-1',
          risk: 'high',
          actionKind: 'click',
          reason: 'This button submits the form.',
          target: { role: 'button', name: 'Submit' },
          expiresAtUnixMs: Date.now() + 60_000,
        },
        createdAtUnixMs: Date.now(),
      })
    })

    expect(screen.getByTestId('workspace-browser-agent-status')).toHaveTextContent('确认 AI 点击')
    expect(screen.getByTestId('workspace-browser-agent-status')).toHaveTextContent(
      'This button submits the form.'
    )
    fireEvent.click(screen.getByTestId('workspace-browser-agent-approval-approve-button'))
    fireEvent.click(screen.getByTestId('workspace-browser-agent-approval-reject-button'))

    expect(embeddedBrowserMocks.resolveEmbeddedBrowserAgentApproval).toHaveBeenCalledWith(
      'browser-approval-1',
      true,
      'workspace-browser'
    )
    expect(embeddedBrowserMocks.resolveEmbeddedBrowserAgentApproval).toHaveBeenCalledWith(
      'browser-approval-1',
      false,
      'workspace-browser'
    )
  })

  test('ignores agent browser state from a different label', () => {
    let handleAgentState!: (event: {
      label: string
      status: string
      action: string | null
      target: string | null
      message: string | null
      errorCode: string | null
      createdAtUnixMs: number
    }) => void
    embeddedBrowserMocks.listenEmbeddedBrowserAgentState.mockImplementation(handler => {
      handleAgentState = handler
      return null
    })

    render(<WorkspaceBrowserPanel active label="workspace-browser-current" />)

    act(() => {
      handleAgentState({
        label: 'workspace-browser-other',
        status: 'running',
        action: 'click',
        target: null,
        message: null,
        errorCode: null,
        approval: null,
        createdAtUnixMs: Date.now(),
      })
    })

    expect(screen.queryByTestId('workspace-browser-agent-status')).not.toBeInTheDocument()
  })

  test('shows completed downloads with their saved file path', async () => {
    let handleDownload!: (download: {
      id: string
      label: string
      nativeLabel: string
      url: string
      path: string | null
      status: string
      receivedBytes: number | null
      totalBytes: number | null
    }) => void
    embeddedBrowserMocks.listenEmbeddedBrowserDownloads.mockImplementation(handler => {
      handleDownload = handler
      return null
    })

    render(<WorkspaceBrowserPanel active />)
    await waitFor(() =>
      expect(embeddedBrowserMocks.readEmbeddedBrowserPageState).toHaveBeenCalled()
    )

    act(() => {
      handleDownload({
        id: 'download-1',
        label: 'workspace-browser',
        nativeLabel: 'workspace-browser-native-1',
        url: 'https://example.com/app.dmg',
        path: '/Users/test/Downloads/app.dmg',
        status: 'finished',
        receivedBytes: 1024,
        totalBytes: 1024,
      })
    })

    // The list stays closed; a transient peek announces the completion.
    expect(await screen.findByTestId('workspace-browser-download-peek')).toHaveTextContent(
      'app.dmg'
    )
    expect(screen.queryByTestId('workspace-browser-downloads-panel')).not.toBeInTheDocument()

    fireEvent.click(screen.getByTestId('workspace-browser-download-peek-view-downloads'))
    expect(screen.queryByTestId('workspace-browser-download-peek')).not.toBeInTheDocument()
    expect(await screen.findByTestId('workspace-browser-downloads-panel')).toBeInTheDocument()
    expect(screen.getByTestId('workspace-browser-download-item')).toHaveTextContent('app.dmg')
    expect(screen.getByTestId('workspace-browser-download-item')).toHaveTextContent('下载完成')
    expect(screen.getByTestId('workspace-browser-download-reveal-button')).toBeInTheDocument()
  })

  test('shows download percentage and byte progress', async () => {
    embeddedBrowserMocks.listenEmbeddedBrowserDownloads.mockImplementation(handler => {
      handler({
        id: 'download-1',
        label: 'workspace-browser',
        nativeLabel: 'workspace-browser-native-1',
        url: 'https://example.com/app.dmg',
        path: '/Users/test/Downloads/app.dmg',
        status: 'progress',
        receivedBytes: 5 * 1024 * 1024,
        totalBytes: 10 * 1024 * 1024,
      })
      return null
    })

    render(<WorkspaceBrowserPanel active />)

    fireEvent.click(screen.getByTestId('workspace-browser-downloads-button'))
    expect(await screen.findByTestId('workspace-browser-download-item')).toHaveTextContent(
      '50% · 5.0 MB / 10.0 MB'
    )
    expect(screen.getByTestId('workspace-browser-download-progress').firstChild).toHaveStyle({
      width: '50%',
    })
  })

  test('never auto-opens the downloads panel and shows a dismissible peek on completion', async () => {
    let handleDownload!: (download: {
      id: string
      label: string
      nativeLabel: string
      url: string
      path: string | null
      status: string
      receivedBytes: number | null
      totalBytes: number | null
    }) => void
    embeddedBrowserMocks.listenEmbeddedBrowserDownloads.mockImplementation(handler => {
      handleDownload = handler
      return Promise.resolve(vi.fn())
    })

    render(<WorkspaceBrowserPanel active />)

    const emit = (status: string, id = 'download-1') =>
      act(() => {
        handleDownload({
          id,
          label: 'workspace-browser',
          nativeLabel: 'workspace-browser-native-1',
          url: 'https://example.com/app.dmg',
          path: '/Users/test/Downloads/app.dmg',
          status,
          receivedBytes: 512,
          totalBytes: 1024,
        })
      })

    await waitFor(() =>
      expect(embeddedBrowserMocks.readEmbeddedBrowserPageState).toHaveBeenCalled()
    )
    emit('started')
    expect(screen.queryByTestId('workspace-browser-downloads-panel')).not.toBeInTheDocument()
    expect(screen.queryByTestId('workspace-browser-download-peek')).not.toBeInTheDocument()

    emit('progress')
    expect(screen.queryByTestId('workspace-browser-downloads-panel')).not.toBeInTheDocument()
    expect(screen.queryByTestId('workspace-browser-download-peek')).not.toBeInTheDocument()

    emit('finished')
    expect(await screen.findByTestId('workspace-browser-download-peek')).toHaveTextContent(
      'app.dmg'
    )
    expect(screen.queryByTestId('workspace-browser-downloads-panel')).not.toBeInTheDocument()

    fireEvent.click(screen.getByTestId('workspace-browser-download-peek-dismiss'))
    expect(screen.queryByTestId('workspace-browser-download-peek')).not.toBeInTheDocument()

    // A second download gets its own peek without reviving the first record.
    emit('finished', 'download-2')
    expect(await screen.findByTestId('workspace-browser-download-peek')).toBeInTheDocument()
    expect(screen.getAllByTestId('workspace-browser-download-peek')).toHaveLength(1)
  })

  test('allows paused downloads to resume or be deleted', async () => {
    embeddedBrowserMocks.listenEmbeddedBrowserDownloads.mockImplementation(handler => {
      handler({
        id: 'download-paused',
        label: 'workspace-browser',
        nativeLabel: 'workspace-browser-native-1',
        url: 'https://example.com/app.dmg',
        path: '/Users/test/Downloads/app.dmg',
        status: 'paused',
        receivedBytes: 5 * 1024 * 1024,
        totalBytes: 10 * 1024 * 1024,
      })
      return null
    })

    render(<WorkspaceBrowserPanel active />)

    openDownloadsPanel()
    fireEvent.click(await screen.findByTestId('workspace-browser-download-resume-button'))
    fireEvent.click(screen.getByTestId('workspace-browser-download-delete-button'))
    expect(embeddedBrowserMocks.resumeEmbeddedBrowserDownload).toHaveBeenCalledWith(
      'download-paused'
    )
    expect(embeddedBrowserMocks.deleteEmbeddedBrowserDownload).toHaveBeenCalledWith(
      'download-paused'
    )
  })

  test('keeps terminal download events across a logical label handoff for the same native browser', async () => {
    mockBrowserHostRect()
    let handleDownload!: (download: {
      id: string
      label: string
      nativeLabel: string
      url: string
      path: string | null
      status: string
      receivedBytes: number | null
      totalBytes: number | null
    }) => void
    embeddedBrowserMocks.listenEmbeddedBrowserDownloads.mockImplementation(handler => {
      handleDownload = handler
      return null
    })

    const view = render(<WorkspaceBrowserPanel active label="workspace-browser" />)
    await waitFor(() =>
      expect(embeddedBrowserMocks.readEmbeddedBrowserPageState).toHaveBeenCalled()
    )

    embeddedBrowserMocks.consumeEmbeddedBrowserLabelTransfer.mockReturnValueOnce(true)
    view.rerender(<WorkspaceBrowserPanel active label="workspace-browser-owner" />)
    await waitFor(() =>
      expect(embeddedBrowserMocks.openEmbeddedBrowser).toHaveBeenCalledWith(
        'https://example.com/',
        expect.any(Object),
        'workspace-browser-owner'
      )
    )

    act(() => {
      handleDownload({
        id: 'download-after-handoff',
        label: 'workspace-browser-owner',
        nativeLabel: 'workspace-browser-native-1',
        url: 'https://example.com/handoff.dmg',
        path: '/Users/test/Downloads/handoff.dmg',
        status: 'finished',
        receivedBytes: 1024,
        totalBytes: 1024,
      })
    })

    openDownloadsPanel()
    expect(await screen.findByTestId('workspace-browser-download-item')).toHaveTextContent(
      'handoff.dmg'
    )
  })

  test('accepts a native-matching event emitted before the label prop changes', async () => {
    mockBrowserHostRect()
    let handleDownload!: (download: {
      id: string
      label: string
      nativeLabel: string
      url: string
      path: string | null
      status: string
      receivedBytes: number | null
      totalBytes: number | null
    }) => void
    embeddedBrowserMocks.listenEmbeddedBrowserDownloads.mockImplementation(handler => {
      handleDownload = handler
      return null
    })

    const view = render(<WorkspaceBrowserPanel active label="workspace-browser" />)
    await waitFor(() =>
      expect(embeddedBrowserMocks.readEmbeddedBrowserPageState).toHaveBeenCalledWith(
        'workspace-browser'
      )
    )

    act(() => {
      handleDownload({
        id: 'download-during-relabel',
        label: 'workspace-browser-owner',
        nativeLabel: 'workspace-browser-native-1',
        url: 'https://example.com/relabel.dmg',
        path: '/Users/test/Downloads/relabel.dmg',
        status: 'finished',
        receivedBytes: 1024,
        totalBytes: 1024,
      })
    })

    openDownloadsPanel()
    expect(await screen.findByTestId('workspace-browser-download-item')).toHaveTextContent(
      'relabel.dmg'
    )

    embeddedBrowserMocks.consumeEmbeddedBrowserLabelTransfer.mockReturnValueOnce(true)
    view.rerender(<WorkspaceBrowserPanel active label="workspace-browser-owner" />)

    expect(await screen.findByTestId('workspace-browser-download-item')).toHaveTextContent(
      'relabel.dmg'
    )
  })

  test('restores download state when ownership moves to a separately mounted panel', async () => {
    let handleDownload!: (download: {
      id: string
      label: string
      nativeLabel: string
      url: string
      path: string | null
      status: string
      receivedBytes: number | null
      totalBytes: number | null
    }) => void
    embeddedBrowserMocks.listenEmbeddedBrowserDownloads.mockImplementation(handler => {
      handleDownload = handler
      return Promise.resolve(vi.fn())
    })

    const source = render(<WorkspaceBrowserPanel active label="workspace-browser-blank-0" />)
    await waitFor(() =>
      expect(embeddedBrowserMocks.readEmbeddedBrowserPageState).toHaveBeenCalledWith(
        'workspace-browser-blank-0'
      )
    )

    act(() => {
      handleDownload({
        id: 'download-before-handoff',
        label: 'workspace-browser-blank-0',
        nativeLabel: 'workspace-browser-native-1',
        url: 'https://example.com/handoff.dmg',
        path: '/Users/test/Downloads/handoff.dmg',
        status: 'progress',
        receivedBytes: 512,
        totalBytes: 1024,
      })
    })

    openDownloadsPanel(source.container)
    expect(
      await within(source.container).findByTestId('workspace-browser-download-item')
    ).toHaveTextContent('handoff.dmg')
    embeddedBrowserMocks.consumeEmbeddedBrowserLabelTransfer.mockReturnValueOnce(true)
    source.unmount()

    act(() => {
      handleDownload({
        id: 'download-before-handoff',
        label: 'workspace-browser-task-1',
        nativeLabel: 'workspace-browser-native-1',
        url: 'https://example.com/handoff.dmg',
        path: '/Users/test/Downloads/handoff.dmg',
        status: 'finished',
        receivedBytes: 1024,
        totalBytes: 1024,
      })
    })

    const destination = render(<WorkspaceBrowserPanel active label="workspace-browser-task-1" />)
    await waitFor(() =>
      expect(embeddedBrowserMocks.readEmbeddedBrowserPageState).toHaveBeenCalledWith(
        'workspace-browser-task-1'
      )
    )

    openDownloadsPanel(destination.container)
    expect(
      await within(destination.container).findByTestId('workspace-browser-download-item')
    ).toHaveTextContent('下载完成')
  })

  test('only the current logical owner processes live events for a shared native browser', async () => {
    const handlers: Array<
      (download: {
        id: string
        label: string
        nativeLabel: string
        url: string
        path: string | null
        status: string
        receivedBytes: number | null
        totalBytes: number | null
      }) => void
    > = []
    embeddedBrowserMocks.listenEmbeddedBrowserDownloads.mockImplementation(handler => {
      handlers.push(handler)
      return null
    })

    const source = render(<WorkspaceBrowserPanel active label="workspace-browser-blank-0" />)
    await waitFor(() =>
      expect(embeddedBrowserMocks.readEmbeddedBrowserPageState).toHaveBeenCalledWith(
        'workspace-browser-blank-0'
      )
    )
    source.rerender(<WorkspaceBrowserPanel active={false} label="workspace-browser-blank-0" />)
    const destination = render(<WorkspaceBrowserPanel active label="workspace-browser-task-1" />)
    await waitFor(() =>
      expect(embeddedBrowserMocks.readEmbeddedBrowserPageState).toHaveBeenCalledWith(
        'workspace-browser-task-1'
      )
    )

    act(() => {
      handlers.forEach(handler =>
        handler({
          id: 'download-after-handoff',
          label: 'workspace-browser-task-1',
          nativeLabel: 'workspace-browser-native-1',
          url: 'https://example.com/current-owner.dmg',
          path: '/Users/test/Downloads/current-owner.dmg',
          status: 'progress',
          receivedBytes: 512,
          totalBytes: 1024,
        })
      )
    })

    openDownloadsPanel(source.container)
    openDownloadsPanel(destination.container)
    expect(
      within(source.container).queryByTestId('workspace-browser-download-item')
    ).not.toBeInTheDocument()
    expect(
      await within(destination.container).findByTestId('workspace-browser-download-item')
    ).toHaveTextContent('current-owner.dmg')
  })

  test('routes a stale-label terminal event to the active native-browser owner', async () => {
    const handlers: Array<
      (download: {
        id: string
        label: string
        nativeLabel: string
        url: string
        path: string | null
        status: string
        receivedBytes: number | null
        totalBytes: number | null
      }) => void
    > = []
    embeddedBrowserMocks.listenEmbeddedBrowserDownloads.mockImplementation(handler => {
      handlers.push(handler)
      return null
    })

    const source = render(<WorkspaceBrowserPanel active label="workspace-browser-source" />)
    await waitFor(() =>
      expect(embeddedBrowserMocks.readEmbeddedBrowserPageState).toHaveBeenCalledWith(
        'workspace-browser-source'
      )
    )
    source.rerender(<WorkspaceBrowserPanel active={false} label="workspace-browser-source" />)
    const destination = render(
      <WorkspaceBrowserPanel active label="workspace-browser-destination" />
    )
    await waitFor(() =>
      expect(embeddedBrowserMocks.readEmbeddedBrowserPageState).toHaveBeenCalledWith(
        'workspace-browser-destination'
      )
    )

    act(() => {
      handlers.forEach(handler =>
        handler({
          id: 'download-after-stale-owner-resolution',
          label: 'workspace-browser-source',
          nativeLabel: 'workspace-browser-native-1',
          url: 'https://example.com/stale-owner.dmg',
          path: '/Users/test/Downloads/stale-owner.dmg',
          status: 'finished',
          receivedBytes: 1024,
          totalBytes: 1024,
        })
      )
    })

    openDownloadsPanel(destination.container)
    expect(
      await within(destination.container).findByTestId('workspace-browser-download-item')
    ).toHaveTextContent('下载完成')
    openDownloadsPanel(source.container)
    expect(
      within(source.container).queryByTestId('workspace-browser-download-item')
    ).not.toBeInTheDocument()
  })

  test('discards buffered events when a logical label resolves to a different native browser', async () => {
    mockBrowserHostRect()
    let handleDownload!: (download: {
      id: string
      label: string
      nativeLabel: string
      url: string
      path: string | null
      status: string
      receivedBytes: number | null
      totalBytes: number | null
    }) => void
    let resolvePageState!: (state: { nativeLabel: string; title: string; url: string }) => void
    embeddedBrowserMocks.listenEmbeddedBrowserDownloads.mockImplementation(handler => {
      handleDownload = handler
      return null
    })
    embeddedBrowserMocks.readEmbeddedBrowserPageState.mockReturnValueOnce(
      new Promise(resolve => {
        resolvePageState = resolve
      })
    )

    render(<WorkspaceBrowserPanel active label="workspace-browser" />)
    await waitFor(() =>
      expect(embeddedBrowserMocks.readEmbeddedBrowserPageState).toHaveBeenCalled()
    )

    act(() => {
      handleDownload({
        id: 'stale-download',
        label: 'workspace-browser',
        nativeLabel: 'workspace-browser-native-old',
        url: 'https://example.com/stale.dmg',
        path: '/Users/test/Downloads/stale.dmg',
        status: 'finished',
        receivedBytes: 1024,
        totalBytes: 1024,
      })
    })
    expect(screen.queryByTestId('workspace-browser-download-item')).not.toBeInTheDocument()

    await act(async () => {
      resolvePageState({
        nativeLabel: 'workspace-browser-native-replacement',
        title: 'Replacement browser',
        url: 'https://replacement.example/',
      })
    })

    expect(screen.queryByTestId('workspace-browser-downloads-panel')).not.toBeInTheDocument()
  })

  test('retains a terminal event when another browser emits repeated progress before adoption', async () => {
    let handleDownload!: (download: {
      id: string
      label: string
      nativeLabel: string
      url: string
      path: string | null
      status: string
      receivedBytes: number | null
      totalBytes: number | null
    }) => void
    let resolvePageState!: (state: { nativeLabel: string; title: string; url: string }) => void
    embeddedBrowserMocks.listenEmbeddedBrowserDownloads.mockImplementation(handler => {
      handleDownload = handler
      return null
    })
    embeddedBrowserMocks.readEmbeddedBrowserPageState.mockReturnValueOnce(
      new Promise(resolve => {
        resolvePageState = resolve
      })
    )

    render(<WorkspaceBrowserPanel active label="workspace-browser" />)
    await waitFor(() =>
      expect(embeddedBrowserMocks.readEmbeddedBrowserPageState).toHaveBeenCalled()
    )

    act(() => {
      handleDownload({
        id: 'target-finished',
        label: 'workspace-browser',
        nativeLabel: 'workspace-browser-native-1',
        url: 'https://example.com/target.dmg',
        path: '/Users/test/Downloads/target.dmg',
        status: 'finished',
        receivedBytes: 1024,
        totalBytes: 1024,
      })
      Array.from({ length: 20 }, (_, index) => index).forEach(index => {
        handleDownload({
          id: `noise-${index}`,
          label: 'workspace-browser-other',
          nativeLabel: 'workspace-browser-native-other',
          url: `https://example.com/noise-${index}.dmg`,
          path: `/Users/test/Downloads/noise-${index}.dmg`,
          status: 'progress',
          receivedBytes: index,
          totalBytes: 1024,
        })
      })
    })

    await act(async () => {
      resolvePageState({
        nativeLabel: 'workspace-browser-native-1',
        title: 'Target browser',
        url: 'https://example.com/',
      })
    })

    openDownloadsPanel()
    expect(await screen.findByTestId('workspace-browser-download-item')).toHaveTextContent(
      'target.dmg'
    )
  })

  test('opens the embedded browser from an external open request', async () => {
    mockBrowserHostRect()
    embeddedBrowserMocks.openEmbeddedBrowser.mockResolvedValueOnce({
      nativeLabel: 'workspace-browser-native-1',
      title: null,
      url: 'about:blank',
    })
    render(
      <WorkspaceBrowserPanel
        active
        openRequest={{
          id: 'test-1',
          baseLabel: 'workspace-browser',
          source: 'agent',
          disposition: 'current-tab',
          label: 'workspace-browser',
          url: 'https://example.test/',
        }}
      />
    )

    await screen.findByTestId('workspace-browser-native-view')

    await waitFor(() => {
      expect(embeddedBrowserMocks.openEmbeddedBrowser).toHaveBeenCalledWith(
        'about:blank',
        {
          x: 500,
          y: 120,
          width: 400,
          height: 300,
        },
        'workspace-browser',
        true,
        true,
        false
      )
    })
    expect(screen.getByTestId('workspace-browser-url-input')).toHaveValue('https://example.test/')
  })

  test('accepts later bridge navigation after an external open settles', async () => {
    let handlePageStateChange!: (pageState: {
      label: string
      nativeLabel: string
      title: string | null
      url: string | null
      isLoading: boolean
    }) => void
    embeddedBrowserMocks.listenEmbeddedBrowserPageStateChanges.mockImplementation(handler => {
      handlePageStateChange = handler
      return Promise.resolve(() => undefined)
    })
    mockBrowserHostRect()
    embeddedBrowserMocks.openEmbeddedBrowser.mockResolvedValueOnce({
      nativeLabel: 'workspace-browser-native-1',
      title: null,
      url: 'about:blank',
    })
    render(
      <WorkspaceBrowserPanel
        active
        openRequest={{
          id: 'test-bridge-navigation',
          baseLabel: 'workspace-browser',
          source: 'agent',
          disposition: 'current-tab',
          label: 'workspace-browser',
          url: 'https://first.example.test/',
        }}
      />
    )

    await waitFor(() => expect(embeddedBrowserMocks.openEmbeddedBrowser).toHaveBeenCalled())
    act(() => {
      handlePageStateChange({
        label: 'workspace-browser',
        nativeLabel: 'workspace-browser-native-1',
        title: 'First',
        url: 'https://first.example.test/',
        isLoading: false,
      })
    })
    act(() => {
      handlePageStateChange({
        label: 'workspace-browser',
        nativeLabel: 'workspace-browser-native-1',
        title: 'Second',
        url: 'https://second.example.test/',
        isLoading: false,
      })
    })

    expect(screen.getByTestId('workspace-browser-url-input')).toHaveValue(
      'https://second.example.test/'
    )
  })

  test('uses the submitted URL when reopening after an external open request', async () => {
    mockBrowserHostRect()
    let handleClose!: (event: { label: string; nativeLabel: string }) => void
    embeddedBrowserMocks.listenEmbeddedBrowserCloseRequests.mockImplementation(handler => {
      handleClose = handler
      return Promise.resolve(vi.fn())
    })
    embeddedBrowserMocks.openEmbeddedBrowser
      .mockResolvedValueOnce({
        nativeLabel: 'workspace-browser-native-1',
        title: null,
        url: 'about:blank',
      })
      .mockResolvedValueOnce({
        nativeLabel: 'workspace-browser-native-2',
        title: null,
        url: 'https://reopened.example.test/',
      })
    render(
      <WorkspaceBrowserPanel
        active
        openRequest={{
          id: 'test-1',
          baseLabel: 'workspace-browser',
          source: 'agent',
          disposition: 'current-tab',
          label: 'workspace-browser',
          url: 'https://example.test/',
        }}
      />
    )

    await waitFor(() => expect(embeddedBrowserMocks.openEmbeddedBrowser).toHaveBeenCalledTimes(1))
    act(() => {
      handleClose({
        label: 'workspace-browser',
        nativeLabel: 'workspace-browser-native-1',
      })
    })

    const input = screen.getByTestId('workspace-browser-url-input')
    fireEvent.change(input, { target: { value: 'https://reopened.example.test/' } })
    fireEvent.submit(input.closest('form')!)

    await waitFor(() => {
      expect(embeddedBrowserMocks.openEmbeddedBrowser).toHaveBeenLastCalledWith(
        'https://reopened.example.test/',
        {
          x: 500,
          y: 120,
          width: 400,
          height: 300,
        },
        'workspace-browser'
      )
    })
  })

  test('opens hidden immediately when the active browser host is not measurable yet', async () => {
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect')
      .mockReturnValueOnce({
        bottom: 0,
        height: 0,
        left: 0,
        right: 0,
        top: 0,
        width: 0,
        x: 0,
        y: 0,
        toJSON: () => ({}),
      })
      .mockReturnValue({
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
    render(
      <WorkspaceBrowserPanel
        active
        openRequest={{
          id: 'test-1',
          baseLabel: 'workspace-browser',
          source: 'agent',
          disposition: 'current-tab',
          label: 'workspace-browser',
          url: 'https://example.test/',
        }}
      />
    )

    await waitFor(() => {
      expect(embeddedBrowserMocks.openEmbeddedBrowser).toHaveBeenCalledWith(
        'about:blank',
        {
          x: 0,
          y: 0,
          width: 1,
          height: 1,
        },
        'workspace-browser',
        false,
        false,
        false
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

  test('binds the target URL directly for user open requests', async () => {
    mockBrowserHostRect()
    embeddedBrowserMocks.openEmbeddedBrowser.mockResolvedValueOnce({
      nativeLabel: 'workspace-browser-native-1',
      title: null,
      url: 'https://example.test/',
    })
    render(
      <WorkspaceBrowserPanel
        active
        openRequest={{
          id: 'test-user-1',
          baseLabel: 'workspace-browser',
          source: 'user',
          disposition: 'new-tab',
          label: 'workspace-browser',
          url: 'https://example.test/',
        }}
      />
    )

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

  test('opens an external request in a hidden browser while the panel is inactive', async () => {
    mockBrowserHostRect()
    const openRequest = {
      id: 'test-2',
      baseLabel: 'workspace-browser',
      source: 'agent' as const,
      disposition: 'current-tab' as const,
      label: 'workspace-browser',
      url: 'https://example.test/',
    }
    const view = render(<WorkspaceBrowserPanel active={false} openRequest={openRequest} />)

    await waitFor(() => {
      expect(embeddedBrowserMocks.openEmbeddedBrowser).toHaveBeenCalledWith(
        'about:blank',
        {
          x: 0,
          y: 0,
          width: 1,
          height: 1,
        },
        'workspace-browser',
        false,
        true,
        false
      )
    })
    expect(embeddedBrowserMocks.openEmbeddedBrowser).toHaveBeenCalledTimes(1)

    view.rerender(<WorkspaceBrowserPanel active openRequest={openRequest} />)

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

  test('keeps an in-flight external open alive when panel activity changes', async () => {
    mockBrowserHostRect()
    let resolveOpen:
      | ((value: { nativeLabel: string; title: null; url: string }) => void)
      | undefined
    embeddedBrowserMocks.openEmbeddedBrowser.mockImplementationOnce(
      () =>
        new Promise(resolve => {
          resolveOpen = resolve
        })
    )
    const openRequest = {
      id: 'test-3',
      baseLabel: 'workspace-browser',
      source: 'agent' as const,
      disposition: 'current-tab' as const,
      label: 'workspace-browser',
      url: 'https://example.test/',
    }
    const view = render(<WorkspaceBrowserPanel active openRequest={openRequest} />)

    await waitFor(() => {
      expect(embeddedBrowserMocks.openEmbeddedBrowser).toHaveBeenCalledTimes(1)
    })

    view.rerender(<WorkspaceBrowserPanel active={false} openRequest={openRequest} />)
    view.rerender(<WorkspaceBrowserPanel active openRequest={openRequest} />)

    await act(async () => {
      resolveOpen?.({
        nativeLabel: 'workspace-browser-native-1',
        title: null,
        url: 'https://example.test/',
      })
    })

    await waitFor(() => {
      expect(screen.getByTestId('workspace-browser-url-input')).toHaveValue('https://example.test/')
    })
    expect(embeddedBrowserMocks.openEmbeddedBrowser).toHaveBeenCalledTimes(1)
    expect(embeddedBrowserMocks.closeEmbeddedBrowser).not.toHaveBeenCalled()
  })

  test('does not close a reused logical label when an uninitialized panel unmounts', () => {
    const view = render(
      <WorkspaceBrowserPanel active={false} label="workspace-browser-runtime-1" />
    )

    view.unmount()

    expect(embeddedBrowserMocks.closeEmbeddedBrowser).not.toHaveBeenCalled()
  })

  test('does not close an owned native browser when the panel unmounts', async () => {
    const view = render(<WorkspaceBrowserPanel active label="workspace-browser-runtime-1" />)
    await screen.findByTestId('workspace-browser-native-view')

    view.unmount()

    expect(embeddedBrowserMocks.closeEmbeddedBrowser).not.toHaveBeenCalled()
  })

  test('ignores a stale close event for a replacement native browser', async () => {
    let handleClose!: (event: { label: string; nativeLabel: string }) => void
    embeddedBrowserMocks.listenEmbeddedBrowserCloseRequests.mockImplementation(handler => {
      handleClose = handler
      return Promise.resolve(vi.fn())
    })
    render(<WorkspaceBrowserPanel active label="workspace-browser-runtime-1" />)
    await screen.findByTestId('workspace-browser-native-view')

    act(() => {
      handleClose({
        label: 'workspace-browser-runtime-1',
        nativeLabel: 'embedded-browser-native-stale',
      })
    })

    expect(screen.getByTestId('workspace-browser-native-view')).toBeInTheDocument()
    expect(screen.getByTestId('workspace-browser-url-input')).toHaveValue('https://example.com/')
  })

  test('does not overwrite the address draft while page-state polling continues', async () => {
    mockBrowserHostRect()
    render(<WorkspaceBrowserPanel active />)

    const input = screen.getByTestId('workspace-browser-url-input')
    fireEvent.change(input, { target: { value: 'bad.invalid' } })
    fireEvent.submit(input.closest('form')!)
    await waitFor(() => expect(embeddedBrowserMocks.openEmbeddedBrowser).toHaveBeenCalled())

    embeddedBrowserMocks.readEmbeddedBrowserPageState.mockClear()
    embeddedBrowserMocks.readEmbeddedBrowserPageState.mockResolvedValue({
      nativeLabel: 'workspace-browser-native-1',
      title: 'Invalid address',
      url: 'https://bad.invalid/',
    })
    fireEvent.focus(input)
    fireEvent.change(input, { target: { value: 'https://replacement.test/' } })

    await waitFor(
      () => expect(embeddedBrowserMocks.readEmbeddedBrowserPageState).toHaveBeenCalled(),
      { timeout: 2500 }
    )
    expect(input).toHaveValue('https://replacement.test/')

    fireEvent.blur(input)
    expect(input).toHaveValue('https://bad.invalid/')
  })

  test('preserves an unsubmitted address draft when focus leaves before navigation', () => {
    render(<WorkspaceBrowserPanel active />)

    const input = screen.getByTestId('workspace-browser-url-input')
    fireEvent.focus(input)
    fireEvent.change(input, { target: { value: 'https://example.com/session-state' } })
    fireEvent.blur(input)

    expect(input).toHaveValue('https://example.com/session-state')
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

  test('hides the native browser after the occlusion snapshot loads', async () => {
    mockBrowserHostRect()
    render(<WorkspaceBrowserPanel active />)

    const input = screen.getByTestId('workspace-browser-url-input')
    fireEvent.change(input, { target: { value: 'example.com' } })
    fireEvent.submit(input.closest('form')!)

    await waitFor(() => {
      expect(embeddedBrowserMocks.openEmbeddedBrowser).toHaveBeenCalled()
    })

    embeddedBrowserMocks.setEmbeddedBrowserBounds.mockClear()
    dispatchBrowserOcclusionChange('workspace-add-menu', true)

    const snapshot = await screen.findByTestId('workspace-browser-occlusion-snapshot')
    expect(embeddedBrowserMocks.setEmbeddedBrowserBounds).not.toHaveBeenCalledWith(
      {
        x: 500,
        y: 120,
        width: 400,
        height: 300,
      },
      false,
      'workspace-browser'
    )

    fireEvent.load(snapshot)
    await waitFor(() => {
      expect(embeddedBrowserMocks.setEmbeddedBrowserBounds).toHaveBeenCalledWith(
        {
          x: 500,
          y: 120,
          width: 400,
          height: 300,
        },
        false,
        'workspace-browser'
      )
    })

    embeddedBrowserMocks.setEmbeddedBrowserBounds.mockClear()
    dispatchBrowserOcclusionChange('workspace-add-menu', false)

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

  test('keeps the Electron webview painted while blocking interaction behind an overlay', async () => {
    window.__WEWORK_RUNTIME_CONFIG__ = {
      ...window.__WEWORK_RUNTIME_CONFIG__,
      desktopHost: 'electron',
    }
    mockBrowserHostRect()
    render(<WorkspaceBrowserPanel active />)

    const input = screen.getByTestId('workspace-browser-url-input')
    fireEvent.change(input, { target: { value: 'example.com' } })
    fireEvent.submit(input.closest('form')!)

    await waitFor(() => {
      expect(embeddedBrowserMocks.openEmbeddedBrowser).toHaveBeenCalled()
    })
    const webviewHost = await screen.findByTestId('workspace-browser-electron-webview')
    expect(webviewHost.querySelector('webview')).toHaveAttribute('allowpopups', 'true')
    expect(webviewHost).toHaveStyle({ pointerEvents: 'auto', visibility: 'visible' })
    expect(webviewHost.parentElement).toHaveStyle({ zIndex: '10' })

    embeddedBrowserMocks.captureEmbeddedBrowserSnapshot.mockClear()
    dispatchBrowserOcclusionChange('workspace-add-menu', true)

    await waitFor(() => {
      expect(webviewHost).toHaveStyle({ pointerEvents: 'none', visibility: 'visible' })
    })
    expect(embeddedBrowserMocks.captureEmbeddedBrowserSnapshot).not.toHaveBeenCalled()

    dispatchBrowserOcclusionChange('workspace-add-menu', false)
    await waitFor(() => {
      expect(webviewHost).toHaveStyle({ pointerEvents: 'auto', visibility: 'visible' })
    })
  })

  test('does not capture a snapshot for an inactive browser tab', async () => {
    mockBrowserHostRect()
    const { rerender } = render(<WorkspaceBrowserPanel active />)

    const input = screen.getByTestId('workspace-browser-url-input')
    fireEvent.change(input, { target: { value: 'example.com' } })
    fireEvent.submit(input.closest('form')!)

    await waitFor(() => {
      expect(embeddedBrowserMocks.openEmbeddedBrowser).toHaveBeenCalled()
    })

    rerender(<WorkspaceBrowserPanel active={false} />)
    embeddedBrowserMocks.captureEmbeddedBrowserSnapshot.mockClear()
    dispatchBrowserOcclusionChange('workspace-add-menu', true)

    await act(async () => {
      await Promise.resolve()
    })
    expect(embeddedBrowserMocks.captureEmbeddedBrowserSnapshot).not.toHaveBeenCalled()
  })

  test('uses a fresh snapshot for every occlusion', async () => {
    mockBrowserHostRect()
    render(<WorkspaceBrowserPanel active />)

    const input = screen.getByTestId('workspace-browser-url-input')
    fireEvent.change(input, { target: { value: 'example.com' } })
    fireEvent.submit(input.closest('form')!)

    await waitFor(() => {
      expect(embeddedBrowserMocks.openEmbeddedBrowser).toHaveBeenCalled()
    })

    dispatchBrowserOcclusionChange('workspace-add-menu', true)

    const snapshot = await screen.findByTestId('workspace-browser-occlusion-snapshot')
    expect(embeddedBrowserMocks.captureEmbeddedBrowserSnapshot).toHaveBeenCalledWith(
      'workspace-browser'
    )
    expect(snapshot).toHaveAttribute('src', 'data:image/png;base64,aW1hZ2U=')
    fireEvent.load(snapshot)

    dispatchBrowserOcclusionChange('workspace-add-menu', false)

    await waitFor(() => {
      expect(screen.queryByTestId('workspace-browser-occlusion-snapshot')).not.toBeInTheDocument()
    })

    const nextSnapshot = createDeferred<string>()
    embeddedBrowserMocks.captureEmbeddedBrowserSnapshot.mockImplementationOnce(
      () => nextSnapshot.promise
    )
    dispatchBrowserOcclusionChange('workspace-add-menu', true)

    await waitFor(() => {
      expect(embeddedBrowserMocks.captureEmbeddedBrowserSnapshot).toHaveBeenCalledTimes(2)
    })
    expect(screen.queryByTestId('workspace-browser-occlusion-snapshot')).not.toBeInTheDocument()

    await act(async () => {
      nextSnapshot.resolve('data:image/png;base64,bmV3LWltYWdl')
    })

    const freshSnapshot = await screen.findByTestId('workspace-browser-occlusion-snapshot')
    expect(freshSnapshot).toHaveAttribute('src', 'data:image/png;base64,bmV3LWltYWdl')
  })

  test('does not hide the browser after an in-flight occlusion capture is released', async () => {
    mockBrowserHostRect()
    const pendingSnapshot = createDeferred<string>()
    embeddedBrowserMocks.captureEmbeddedBrowserSnapshot.mockImplementationOnce(
      () => pendingSnapshot.promise
    )
    render(<WorkspaceBrowserPanel active />)

    const input = screen.getByTestId('workspace-browser-url-input')
    fireEvent.change(input, { target: { value: 'example.com' } })
    fireEvent.submit(input.closest('form')!)

    await waitFor(() => {
      expect(embeddedBrowserMocks.openEmbeddedBrowser).toHaveBeenCalled()
    })

    embeddedBrowserMocks.setEmbeddedBrowserBounds.mockClear()
    dispatchBrowserOcclusionChange('workspace-add-menu', true)
    await waitFor(() => {
      expect(embeddedBrowserMocks.captureEmbeddedBrowserSnapshot).toHaveBeenCalled()
    })

    dispatchBrowserOcclusionChange('workspace-add-menu', false)
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

    embeddedBrowserMocks.setEmbeddedBrowserBounds.mockClear()
    await act(async () => {
      pendingSnapshot.resolve('data:image/png;base64,bGF0ZS1pbWFnZQ==')
    })

    await Promise.resolve()
    expect(embeddedBrowserMocks.setEmbeddedBrowserBounds).not.toHaveBeenCalledWith(
      {
        x: 500,
        y: 120,
        width: 400,
        height: 300,
      },
      false,
      'workspace-browser'
    )
  })

  test('automatically hides the native browser while an intersecting dialog is open', async () => {
    mockBrowserHostRect()
    render(<WorkspaceBrowserPanel active />)

    const input = screen.getByTestId('workspace-browser-url-input')
    fireEvent.change(input, { target: { value: 'example.com' } })
    fireEvent.submit(input.closest('form')!)

    await waitFor(() => {
      expect(embeddedBrowserMocks.openEmbeddedBrowser).toHaveBeenCalled()
    })

    embeddedBrowserMocks.setEmbeddedBrowserBounds.mockClear()
    const dialogOverlay = document.createElement('div')
    dialogOverlay.className = 'fixed inset-0 z-modal'
    await act(async () => {
      document.body.append(dialogOverlay)
      await Promise.resolve()
    })

    const snapshot = await screen.findByTestId('workspace-browser-occlusion-snapshot')
    fireEvent.load(snapshot)
    await waitFor(() => {
      expect(embeddedBrowserMocks.setEmbeddedBrowserBounds).toHaveBeenCalledWith(
        {
          x: 500,
          y: 120,
          width: 400,
          height: 300,
        },
        false,
        'workspace-browser'
      )
    })

    embeddedBrowserMocks.setEmbeddedBrowserBounds.mockClear()
    await act(async () => {
      dialogOverlay.remove()
      await Promise.resolve()
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

  test('creates only a code comment context from a browser annotation', async () => {
    mockBrowserHostRect()
    const onAddCodeComment = vi.fn()
    embeddedBrowserMocks.readEmbeddedBrowserAnnotationState.mockResolvedValueOnce(
      annotationState([
        {
          id: 'browser-annotation-1',
          number: 1,
          comment: '这里导航太抢眼',
        },
      ])
    )
    render(<WorkspaceBrowserPanel active onAddCodeComment={onAddCodeComment} />)

    const input = screen.getByTestId('workspace-browser-url-input')
    fireEvent.change(input, { target: { value: 'example.com' } })
    fireEvent.submit(input.closest('form')!)

    await waitFor(() => {
      expect(embeddedBrowserMocks.openEmbeddedBrowser).toHaveBeenCalled()
    })

    fireEvent.click(screen.getByTestId('workspace-browser-annotate-button'))

    await waitFor(() => {
      expect(embeddedBrowserMocks.startEmbeddedBrowserAnnotation).toHaveBeenCalledWith(
        'batch',
        'workspace-browser',
        undefined
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
    const context = onAddCodeComment.mock.calls[0][0]
    const selectedText = JSON.parse(context.selectedText)
    expect(selectedText.type).toBe('browser_annotation')
    expect(selectedText.anchor.kind).toBe('element')
    expect(selectedText.target.tagName).toBe('button')
    expect(selectedText.screenshotDataUrl).toBe('data:image/png;base64,aW1hZ2U=')
    expect(screen.getByTestId('workspace-browser-annotation-count')).toHaveTextContent('1')
  })

  test('keeps one annotation-state subscription while the active page URL changes', async () => {
    mockBrowserHostRect()
    let handlePageStateChange!: Parameters<
      typeof embeddedBrowserMocks.listenEmbeddedBrowserPageStateChanges
    >[0]
    embeddedBrowserMocks.listenEmbeddedBrowserPageStateChanges.mockImplementation(handler => {
      handlePageStateChange = handler
      return Promise.resolve(() => undefined)
    })
    embeddedBrowserMocks.listenEmbeddedBrowserAnnotationState.mockImplementation(() =>
      Promise.resolve(() => undefined)
    )
    render(<WorkspaceBrowserPanel active />)

    const input = screen.getByTestId('workspace-browser-url-input')
    fireEvent.change(input, { target: { value: 'example.com' } })
    fireEvent.submit(input.closest('form')!)
    await waitFor(() => expect(embeddedBrowserMocks.openEmbeddedBrowser).toHaveBeenCalled())

    act(() => {
      handlePageStateChange({
        label: 'workspace-browser',
        nativeLabel: 'workspace-browser-native-1',
        title: 'Next page',
        url: 'https://example.com/next',
        isLoading: false,
        invalidTlsCertificate: null,
      })
    })
    await waitFor(() => expect(input).toHaveValue('https://example.com/next'))

    expect(embeddedBrowserMocks.listenEmbeddedBrowserAnnotationState).toHaveBeenCalledTimes(1)
  })

  test('ignores an annotation state response from an older page runtime', async () => {
    mockBrowserHostRect()
    const onAddCodeComment = vi.fn()
    let handleAnnotationState: ((state: BrowserAnnotationState) => void) | undefined
    embeddedBrowserMocks.listenEmbeddedBrowserAnnotationState.mockImplementation(handler => {
      handleAnnotationState = handler
      return null
    })
    embeddedBrowserMocks.readEmbeddedBrowserAnnotationState.mockResolvedValue(
      annotationState([{ id: 'new-comment', number: 1, comment: 'Current page comment' }], {
        pageSessionId: 'page-session-2',
        revision: 3,
        runtimeRevision: 2,
      })
    )
    render(<WorkspaceBrowserPanel active onAddCodeComment={onAddCodeComment} />)

    const input = screen.getByTestId('workspace-browser-url-input')
    fireEvent.change(input, { target: { value: 'example.com' } })
    fireEvent.submit(input.closest('form')!)
    await waitFor(() =>
      expect(screen.getByTestId('workspace-browser-annotate-button')).toBeEnabled()
    )
    fireEvent.click(screen.getByTestId('workspace-browser-annotate-button'))

    await waitFor(() => expect(onAddCodeComment).toHaveBeenCalledOnce())
    act(() => {
      handleAnnotationState?.(
        annotationState([{ id: 'old-comment', number: 1, comment: 'Stale page comment' }], {
          pageSessionId: 'page-session-1',
          revision: 99,
          runtimeRevision: 1,
        })
      )
    })

    expect(onAddCodeComment).toHaveBeenCalledOnce()
    expect(screen.getByTestId('workspace-browser-annotation-count')).toHaveTextContent('1')
  })

  test('opens batch annotation at the browser context-menu point', async () => {
    mockBrowserHostRect()
    let handleAnnotationRequest:
      | ((request: {
          label: string
          nativeLabel: string
          mode: 'quick' | 'batch'
          x: number
          y: number
        }) => void)
      | undefined
    embeddedBrowserMocks.listenEmbeddedBrowserAnnotationRequests.mockImplementation(handler => {
      handleAnnotationRequest = handler
      return null
    })
    render(<WorkspaceBrowserPanel active />)

    const input = screen.getByTestId('workspace-browser-url-input')
    fireEvent.change(input, { target: { value: 'example.com' } })
    fireEvent.submit(input.closest('form')!)
    await waitFor(() =>
      expect(screen.getByTestId('workspace-browser-annotate-button')).toBeEnabled()
    )

    act(() => {
      handleAnnotationRequest?.({
        label: 'workspace-browser',
        nativeLabel: 'workspace-browser-native-1',
        mode: 'batch',
        x: 20,
        y: 30,
      })
    })

    await waitFor(() => {
      expect(embeddedBrowserMocks.startEmbeddedBrowserAnnotation).toHaveBeenCalledWith(
        'batch',
        'workspace-browser',
        { x: 20, y: 30 }
      )
    })
    expect(screen.getByTestId('workspace-browser-annotation-close-button')).toBeInTheDocument()
  })

  test('exits quick annotation after publishing one context-menu annotation', async () => {
    mockBrowserHostRect()
    const onAddCodeComment = vi.fn()
    let handleAnnotationState: ((state: ReturnType<typeof annotationState>) => void) | undefined
    embeddedBrowserMocks.listenEmbeddedBrowserAnnotationState.mockImplementation(handler => {
      handleAnnotationState = handler
      return null
    })
    let handleAnnotationRequest:
      | ((request: {
          label: string
          nativeLabel: string
          mode: 'quick' | 'batch'
          x: number
          y: number
        }) => void)
      | undefined
    embeddedBrowserMocks.listenEmbeddedBrowserAnnotationRequests.mockImplementation(handler => {
      handleAnnotationRequest = handler
      return null
    })
    embeddedBrowserMocks.readEmbeddedBrowserAnnotationState.mockResolvedValue(
      annotationState([], { mode: 'quick', revision: 0 })
    )
    render(<WorkspaceBrowserPanel active onAddCodeComment={onAddCodeComment} />)

    const input = screen.getByTestId('workspace-browser-url-input')
    fireEvent.change(input, { target: { value: 'example.com' } })
    fireEvent.submit(input.closest('form')!)
    await waitFor(() =>
      expect(screen.getByTestId('workspace-browser-annotate-button')).toBeEnabled()
    )

    act(() => {
      handleAnnotationRequest?.({
        label: 'workspace-browser',
        nativeLabel: 'workspace-browser-native-1',
        mode: 'quick',
        x: 20,
        y: 30,
      })
    })

    await waitFor(() => {
      expect(embeddedBrowserMocks.startEmbeddedBrowserAnnotation).toHaveBeenCalledWith(
        'quick',
        'workspace-browser',
        { x: 20, y: 30 }
      )
    })
    act(() => {
      handleAnnotationState?.(
        annotationState(
          [
            {
              id: 'browser-annotation-1',
              number: 1,
              comment: 'Quick note',
            },
          ],
          { mode: 'off', revision: 1 }
        )
      )
    })
    await waitFor(() => expect(onAddCodeComment).toHaveBeenCalledOnce())
    await waitFor(() =>
      expect(
        screen.queryByTestId('workspace-browser-annotation-close-button')
      ).not.toBeInTheDocument()
    )
  })

  test('does not enter quick annotation without a matching baseline', async () => {
    mockBrowserHostRect()
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    embeddedBrowserMocks.startEmbeddedBrowserAnnotation.mockRejectedValueOnce(
      new Error('Annotation target is unavailable')
    )
    let handleAnnotationRequest:
      | ((request: {
          label: string
          nativeLabel: string
          mode: 'quick' | 'batch'
          x: number
          y: number
        }) => void)
      | undefined
    embeddedBrowserMocks.listenEmbeddedBrowserAnnotationRequests.mockImplementation(handler => {
      handleAnnotationRequest = handler
      return null
    })
    render(<WorkspaceBrowserPanel active />)

    const input = screen.getByTestId('workspace-browser-url-input')
    fireEvent.change(input, { target: { value: 'example.com' } })
    fireEvent.submit(input.closest('form')!)
    await waitFor(() =>
      expect(screen.getByTestId('workspace-browser-annotate-button')).toBeEnabled()
    )

    act(() => {
      handleAnnotationRequest?.({
        label: 'workspace-browser',
        nativeLabel: 'workspace-browser-native-1',
        mode: 'quick',
        x: 20,
        y: 30,
      })
    })

    await waitFor(() =>
      expect(screen.getByTestId('workspace-browser-error')).toHaveTextContent('无法进入批注模式')
    )
    expect(embeddedBrowserMocks.readEmbeddedBrowserAnnotationState).not.toHaveBeenCalled()
    expect(
      screen.queryByTestId('workspace-browser-annotation-close-button')
    ).not.toBeInTheDocument()
    consoleError.mockRestore()
  })

  test('hold-to-view-original button is enabled for queued tweaks and toggles the original page runtime', async () => {
    mockBrowserHostRect()
    const state = annotationState([
      {
        id: 'browser-annotation-1',
        number: 1,
        comment: 'Make the button blue',
        designChanges: [{ property: 'color', previousValue: '#000000', value: '#1683ff' }],
      },
    ])
    let handleAnnotationState: ((state: BrowserAnnotationState) => void) | undefined
    embeddedBrowserMocks.listenEmbeddedBrowserAnnotationState.mockImplementation(handler => {
      handleAnnotationState = handler
      return null
    })
    embeddedBrowserMocks.readEmbeddedBrowserAnnotationState.mockResolvedValue(state)
    render(<WorkspaceBrowserPanel active />)

    const input = screen.getByTestId('workspace-browser-url-input')
    fireEvent.change(input, { target: { value: 'example.com' } })
    fireEvent.submit(input.closest('form')!)

    await waitFor(() => {
      expect(embeddedBrowserMocks.openEmbeddedBrowser).toHaveBeenCalled()
    })

    fireEvent.click(screen.getByTestId('workspace-browser-annotate-button'))

    const button = await screen.findByTestId('workspace-browser-annotation-original-view-button')
    await waitFor(() => {
      expect(button).toBeEnabled()
    })
    expect(
      document.querySelector(
        '[data-testid="workspace-browser-panel"] [class*="browser-annotation-surface"]'
      )
    ).not.toBeNull()
    expect(screen.getByTestId('workspace-browser-annotation-count')).toHaveClass(
      'bg-[var(--color-browser-annotation-chip)]'
    )
    expect(screen.getByText('正在批注 · example.com')).toBeInTheDocument()

    button.setPointerCapture = vi.fn(() => {
      throw new DOMException('No active pointer', 'NotFoundError')
    })
    fireEvent.pointerDown(button)
    await waitFor(() => {
      expect(embeddedBrowserMocks.setEmbeddedBrowserAnnotationOriginalView).toHaveBeenCalledWith(
        true,
        'workspace-browser'
      )
    })
    expect(screen.getByText('原网页 · example.com')).toBeInTheDocument()
    expect(button).toHaveAttribute('aria-pressed', 'true')

    expect(handleAnnotationState).toBeDefined()
    act(() =>
      handleAnnotationState?.({
        ...state,
        runtimeRevision: state.runtimeRevision - 1,
        scope: state.scope ? { ...state.scope, pageSessionId: 'page-session-old' } : null,
        originalView: false,
      })
    )
    expect(button).toHaveAttribute('aria-pressed', 'true')

    act(() => handleAnnotationState?.({ ...state, originalView: false }))
    expect(button).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByTestId('workspace-browser-panel')).toHaveAttribute(
      'data-browser-annotation-original-view',
      'false'
    )

    act(() => handleAnnotationState?.({ ...state, originalView: true }))
    expect(button).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByTestId('workspace-browser-panel')).toHaveAttribute(
      'data-browser-annotation-original-view',
      'true'
    )

    fireEvent.pointerUp(button)
    await waitFor(() => {
      expect(embeddedBrowserMocks.setEmbeddedBrowserAnnotationOriginalView).toHaveBeenCalledWith(
        false,
        'workspace-browser'
      )
    })
    expect(screen.getByText('正在批注 · example.com')).toBeInTheDocument()
    expect(button).toHaveAttribute('aria-pressed', 'false')
  })

  test('hold-to-view-original button is disabled without queued tweaks', async () => {
    mockBrowserHostRect()
    embeddedBrowserMocks.readEmbeddedBrowserAnnotationState.mockResolvedValue(
      annotationState([
        {
          id: 'browser-annotation-1',
          number: 1,
          comment: 'Plain comment without adjustments',
        },
      ])
    )
    render(<WorkspaceBrowserPanel active />)

    const input = screen.getByTestId('workspace-browser-url-input')
    fireEvent.change(input, { target: { value: 'example.com' } })
    fireEvent.submit(input.closest('form')!)

    await waitFor(() => {
      expect(embeddedBrowserMocks.openEmbeddedBrowser).toHaveBeenCalled()
    })

    fireEvent.click(screen.getByTestId('workspace-browser-annotate-button'))

    const button = await screen.findByTestId('workspace-browser-annotation-original-view-button')
    await waitFor(() => {
      expect(button).toBeDisabled()
    })
  })

  test('replays adjustments when the active browser tab is left while viewing the original page', async () => {
    mockBrowserHostRect()
    embeddedBrowserMocks.readEmbeddedBrowserAnnotationState.mockResolvedValue(
      annotationState([
        {
          id: 'browser-annotation-1',
          number: 1,
          comment: 'Make the button blue',
          designChanges: [{ property: 'color', previousValue: '#000000', value: '#1683ff' }],
        },
      ])
    )
    const { rerender } = render(<WorkspaceBrowserPanel active />)

    const input = screen.getByTestId('workspace-browser-url-input')
    fireEvent.change(input, { target: { value: 'example.com' } })
    fireEvent.submit(input.closest('form')!)

    await waitFor(() => {
      expect(embeddedBrowserMocks.openEmbeddedBrowser).toHaveBeenCalled()
    })
    fireEvent.click(screen.getByTestId('workspace-browser-annotate-button'))

    const button = await screen.findByTestId('workspace-browser-annotation-original-view-button')
    await waitFor(() => expect(button).toBeEnabled())
    fireEvent.pointerDown(button)
    await waitFor(() => expect(button).toHaveAttribute('aria-pressed', 'true'))
    embeddedBrowserMocks.setEmbeddedBrowserAnnotationOriginalView.mockClear()

    rerender(<WorkspaceBrowserPanel active={false} />)

    await waitFor(() => {
      expect(button).toHaveAttribute('aria-pressed', 'false')
      expect(embeddedBrowserMocks.setEmbeddedBrowserAnnotationOriginalView).toHaveBeenCalledWith(
        false,
        'workspace-browser'
      )
    })
  })

  test('clear button wipes page annotation boxes while staying in annotation mode', async () => {
    mockBrowserHostRect()
    embeddedBrowserMocks.readEmbeddedBrowserAnnotationState.mockResolvedValueOnce(
      annotationState([
        {
          id: 'browser-annotation-1',
          number: 1,
          comment: '这里要改',
        },
      ])
    )
    embeddedBrowserMocks.readEmbeddedBrowserAnnotationState.mockResolvedValueOnce(
      annotationState([], { revision: 2 })
    )
    render(<WorkspaceBrowserPanel active onAddCodeComment={vi.fn()} />)

    const input = screen.getByTestId('workspace-browser-url-input')
    fireEvent.change(input, { target: { value: 'example.com' } })
    fireEvent.submit(input.closest('form')!)

    await waitFor(() => {
      expect(embeddedBrowserMocks.openEmbeddedBrowser).toHaveBeenCalled()
    })

    fireEvent.click(screen.getByTestId('workspace-browser-annotate-button'))

    await waitFor(() => {
      expect(screen.getByTestId('workspace-browser-annotation-count')).toHaveTextContent('1')
    })

    fireEvent.click(screen.getByTestId('workspace-browser-annotation-clear-button'))
    expect(screen.getByTestId('workspace-browser-annotation-discard-confirm-button')).toBeVisible()
    fireEvent.click(screen.getByTestId('workspace-browser-annotation-discard-confirm-button'))
    await waitFor(() => {
      expect(screen.queryByTestId('workspace-browser-annotation-count')).not.toBeInTheDocument()
    })
    expect(screen.getByTestId('workspace-browser-annotation-close-button')).toBeInTheDocument()
    expect(embeddedBrowserMocks.clearEmbeddedBrowserAnnotations).toHaveBeenCalledWith(
      'workspace-browser'
    )
  })

  test('clears page annotation boxes when code comments are sent and mode exits', async () => {
    mockBrowserHostRect()
    embeddedBrowserMocks.readEmbeddedBrowserAnnotationState.mockResolvedValueOnce(
      annotationState([
        {
          id: 'browser-annotation-1',
          number: 1,
          comment: '第一处问题',
        },
        {
          id: 'browser-annotation-2',
          number: 2,
          comment: '第二处问题',
        },
      ])
    )
    embeddedBrowserMocks.readEmbeddedBrowserAnnotationState.mockResolvedValueOnce(
      annotationState([], { revision: 2 })
    )

    const { rerender } = render(
      <WorkspaceBrowserPanel active codeCommentCount={0} onAddCodeComment={vi.fn()} />
    )

    const input = screen.getByTestId('workspace-browser-url-input')
    fireEvent.change(input, { target: { value: 'example.com' } })
    fireEvent.submit(input.closest('form')!)

    await waitFor(() => {
      expect(embeddedBrowserMocks.openEmbeddedBrowser).toHaveBeenCalled()
    })

    fireEvent.click(screen.getByTestId('workspace-browser-annotate-button'))

    await waitFor(() => {
      expect(screen.getByTestId('workspace-browser-annotation-count')).toHaveTextContent('2')
    })

    // A successful send emits an explicit cleanup command instead of inferring from count.
    rerender(
      <WorkspaceBrowserPanel
        active
        codeCommentCount={0}
        browserAnnotationCommand={{
          sequence: 1,
          type: 'clear_all_and_exit',
          reason: 'send_success',
        }}
        onAddCodeComment={vi.fn()}
      />
    )

    await waitFor(() => {
      expect(
        screen.queryByTestId('workspace-browser-annotation-close-button')
      ).not.toBeInTheDocument()
    })
    expect(screen.getByTestId('workspace-browser-annotate-button')).toBeInTheDocument()
    expect(embeddedBrowserMocks.clearEmbeddedBrowserAnnotations).toHaveBeenCalledWith(
      'workspace-browser'
    )
    expect(embeddedBrowserMocks.stopEmbeddedBrowserAnnotation).toHaveBeenCalledWith(
      'workspace-browser'
    )
  })

  test('discards a pending page read after the browser panel unmounts', async () => {
    mockBrowserHostRect()
    const staleTitleChange = vi.fn()
    const firstView = render(<WorkspaceBrowserPanel active onTitleChange={staleTitleChange} />)

    const input = screen.getByTestId('workspace-browser-url-input')
    fireEvent.change(input, { target: { value: 'example.com' } })
    fireEvent.submit(input.closest('form')!)
    await waitFor(() => expect(embeddedBrowserMocks.openEmbeddedBrowser).toHaveBeenCalled())

    let resolvePageState!: (state: { nativeLabel: string; title: string; url: string }) => void
    const pendingPageState = new Promise<{
      nativeLabel: string
      title: string
      url: string
    }>(resolve => {
      resolvePageState = resolve
    })
    embeddedBrowserMocks.readEmbeddedBrowserPageState.mockClear()
    embeddedBrowserMocks.readEmbeddedBrowserPageState.mockReturnValueOnce(pendingPageState)
    fireEvent.click(screen.getByTestId('workspace-browser-back-button'))
    await waitFor(() =>
      expect(embeddedBrowserMocks.readEmbeddedBrowserPageState).toHaveBeenCalled()
    )

    staleTitleChange.mockClear()
    firstView.unmount()
    render(<WorkspaceBrowserPanel active />)

    const extensionUrl = new URL(
      '/extension-page.html?sessionId=123e4567-e89b-42d3-a456-426614174000&contextId=stale-context',
      window.location.href
    ).toString()
    await act(async () => {
      resolvePageState({
        nativeLabel: 'workspace-browser-native-1',
        title: 'Extension page - stale-context',
        url: extensionUrl,
      })
      await pendingPageState
    })

    expect(staleTitleChange).not.toHaveBeenCalledWith('Extension page - stale-context')
    expect(screen.getByTestId('workspace-browser-url-input')).not.toHaveValue(extensionUrl)
  })

  async function openExamplePage() {
    mockBrowserHostRect()
    render(<WorkspaceBrowserPanel active />)
    const portalHost = document.createElement('div')
    portalHost.id = 'titlebar-actions-portal'
    document.body.append(portalHost)
    const input = screen.getByTestId('workspace-browser-url-input')
    fireEvent.change(input, { target: { value: 'example.com' } })
    fireEvent.submit(input.closest('form')!)
    await screen.findByTestId('workspace-browser-native-view')
    await waitFor(() => {
      expect(embeddedBrowserMocks.openEmbeddedBrowser).toHaveBeenCalled()
    })
  }

  test('opens the find bar from the more menu and searches the page', async () => {
    embeddedBrowserMocks.evalEmbeddedBrowserJson.mockResolvedValue({
      query: 'hello',
      matches: 2,
      active: 1,
    })
    await openExamplePage()

    fireEvent.click(screen.getByTestId('workspace-browser-more-button'))
    fireEvent.click(screen.getByTestId('workspace-browser-find-item'))

    const findInput = screen.getByTestId('workspace-browser-find-input')
    fireEvent.change(findInput, { target: { value: 'hello' } })

    await waitFor(() => {
      expect(embeddedBrowserMocks.evalEmbeddedBrowserJson).toHaveBeenCalledWith(
        expect.stringContaining('search("hello")'),
        'workspace-browser'
      )
    })
    await waitFor(() => {
      expect(screen.getByTestId('workspace-browser-find-count')).toHaveTextContent('1 / 2')
    })

    fireEvent.keyDown(findInput, { key: 'Enter' })
    await waitFor(() => {
      expect(embeddedBrowserMocks.evalEmbeddedBrowserJson).toHaveBeenCalledWith(
        expect.stringContaining('next()'),
        'workspace-browser'
      )
    })

    fireEvent.keyDown(findInput, { key: 'Escape' })
    expect(screen.queryByTestId('workspace-browser-find-bar')).not.toBeInTheDocument()
    await waitFor(() => {
      expect(embeddedBrowserMocks.evalEmbeddedBrowserJson).toHaveBeenCalledWith(
        expect.stringContaining('clear()'),
        'workspace-browser'
      )
    })
  })

  test('re-runs an active find only after navigation completes', async () => {
    let handlePageStateChange!: (pageState: {
      label: string
      nativeLabel: string
      title: string | null
      url: string | null
      isLoading: boolean
    }) => void
    embeddedBrowserMocks.listenEmbeddedBrowserPageStateChanges.mockImplementation(handler => {
      handlePageStateChange = handler
      return Promise.resolve(() => undefined)
    })
    embeddedBrowserMocks.evalEmbeddedBrowserJson.mockResolvedValue({
      query: 'hello',
      matches: 1,
      active: 1,
    })
    await openExamplePage()

    fireEvent.click(screen.getByTestId('workspace-browser-more-button'))
    fireEvent.click(screen.getByTestId('workspace-browser-find-item'))
    fireEvent.change(screen.getByTestId('workspace-browser-find-input'), {
      target: { value: 'hello' },
    })
    await waitFor(() => {
      expect(embeddedBrowserMocks.evalEmbeddedBrowserJson).toHaveBeenCalledWith(
        expect.stringContaining('search("hello")'),
        'workspace-browser'
      )
    })
    embeddedBrowserMocks.evalEmbeddedBrowserJson.mockClear()

    act(() => {
      handlePageStateChange({
        label: 'workspace-browser',
        nativeLabel: 'workspace-browser-native-1',
        title: null,
        url: 'https://example.com/next',
        isLoading: true,
      })
    })
    expect(embeddedBrowserMocks.evalEmbeddedBrowserJson).not.toHaveBeenCalled()

    act(() => {
      handlePageStateChange({
        label: 'workspace-browser',
        nativeLabel: 'workspace-browser-native-1',
        title: 'Next',
        url: 'https://example.com/next',
        isLoading: false,
      })
    })
    await waitFor(() => {
      expect(embeddedBrowserMocks.evalEmbeddedBrowserJson).toHaveBeenCalledWith(
        expect.stringContaining('search("hello")'),
        'workspace-browser'
      )
    })
  })

  test('toggles the device toolbar and emulates the preset viewport', async () => {
    await openExamplePage()

    fireEvent.click(screen.getByTestId('workspace-browser-more-button'))
    fireEvent.click(screen.getByTestId('workspace-browser-device-toolbar-item'))

    await screen.findByTestId('workspace-browser-device-toolbar')

    // Responsive preset is 390x844; the 400x300 host fits by scaling down.
    await waitFor(() => {
      expect(embeddedBrowserMocks.setEmbeddedBrowserBounds).toHaveBeenCalledWith(
        { x: 631, y: 120, width: 139, height: 300 },
        true,
        'workspace-browser'
      )
    })
    await waitFor(() => {
      expect(embeddedBrowserMocks.setEmbeddedBrowserDeviceMetrics).toHaveBeenLastCalledWith(
        expect.objectContaining({ width: 390, height: 844 }),
        'workspace-browser'
      )
    })
    expect(
      embeddedBrowserMocks.setEmbeddedBrowserDeviceMetrics.mock.calls.at(-1)?.[0]?.scale
    ).toBeCloseTo(300 / 844)
    expect(embeddedBrowserMocks.setEmbeddedBrowserZoom).toHaveBeenLastCalledWith(
      1,
      'workspace-browser'
    )
    expect(
      embeddedBrowserMocks.setEmbeddedBrowserBounds.mock.invocationCallOrder.at(-1)
    ).toBeLessThan(embeddedBrowserMocks.setEmbeddedBrowserZoom.mock.invocationCallOrder.at(-1) ?? 0)
    expect(
      embeddedBrowserMocks.setEmbeddedBrowserZoom.mock.invocationCallOrder.at(-1)
    ).toBeLessThan(
      embeddedBrowserMocks.setEmbeddedBrowserDeviceMetrics.mock.invocationCallOrder.at(-1) ?? 0
    )

    fireEvent.click(screen.getByTestId('workspace-browser-device-rotate-button'))
    await waitFor(() => {
      expect(embeddedBrowserMocks.setEmbeddedBrowserBounds).toHaveBeenCalledWith(
        { x: 500, y: 178, width: 400, height: 185 },
        true,
        'workspace-browser'
      )
    })
    await waitFor(() => {
      expect(embeddedBrowserMocks.setEmbeddedBrowserDeviceMetrics).toHaveBeenLastCalledWith(
        expect.objectContaining({ width: 844, height: 390 }),
        'workspace-browser'
      )
    })
    expect(
      embeddedBrowserMocks.setEmbeddedBrowserDeviceMetrics.mock.calls.at(-1)?.[0]?.scale
    ).toBeCloseTo(400 / 844)

    fireEvent.click(screen.getByTestId('workspace-browser-device-close-button'))
    await waitFor(() => {
      expect(screen.queryByTestId('workspace-browser-device-toolbar')).not.toBeInTheDocument()
    })
    await waitFor(() => {
      expect(embeddedBrowserMocks.setEmbeddedBrowserBounds).toHaveBeenCalledWith(
        { x: 500, y: 120, width: 400, height: 300 },
        true,
        'workspace-browser'
      )
    })
  })

  test('restores device metrics after a native page reload resets browser zoom', async () => {
    let handlePageStateChange!: Parameters<
      typeof embeddedBrowserMocks.listenEmbeddedBrowserPageStateChanges
    >[0]
    embeddedBrowserMocks.listenEmbeddedBrowserPageStateChanges.mockImplementation(handler => {
      handlePageStateChange = handler
      return Promise.resolve(() => undefined)
    })
    await openExamplePage()

    fireEvent.click(screen.getByTestId('workspace-browser-more-button'))
    fireEvent.click(screen.getByTestId('workspace-browser-device-toolbar-item'))
    await screen.findByTestId('workspace-browser-device-toolbar')
    await waitFor(() => {
      expect(embeddedBrowserMocks.setEmbeddedBrowserDeviceMetrics).toHaveBeenLastCalledWith(
        expect.objectContaining({ width: 390, height: 844 }),
        'workspace-browser'
      )
    })

    embeddedBrowserMocks.setEmbeddedBrowserBounds.mockClear()
    embeddedBrowserMocks.setEmbeddedBrowserZoom.mockClear()
    embeddedBrowserMocks.setEmbeddedBrowserDeviceMetrics.mockClear()

    act(() => {
      handlePageStateChange({
        label: 'workspace-browser',
        nativeLabel: 'workspace-browser-native-1',
        title: 'Example',
        url: 'https://example.com',
        isLoading: true,
      })
      handlePageStateChange({
        label: 'workspace-browser',
        nativeLabel: 'workspace-browser-native-1',
        title: 'Example',
        url: 'https://example.com',
        isLoading: false,
      })
    })

    await waitFor(() => {
      expect(embeddedBrowserMocks.setEmbeddedBrowserBounds).toHaveBeenCalled()
      expect(embeddedBrowserMocks.setEmbeddedBrowserZoom).toHaveBeenCalled()
      expect(embeddedBrowserMocks.setEmbeddedBrowserDeviceMetrics).toHaveBeenLastCalledWith(
        expect.objectContaining({ width: 390, height: 844 }),
        'workspace-browser'
      )
    })
    expect(
      embeddedBrowserMocks.setEmbeddedBrowserZoom.mock.invocationCallOrder.at(-1)
    ).toBeLessThan(
      embeddedBrowserMocks.setEmbeddedBrowserDeviceMetrics.mock.invocationCallOrder.at(-1) ?? 0
    )
  })

  test('prevents a stale native bounds sync from clearing newer device metrics', async () => {
    await openExamplePage()
    await waitFor(() => {
      expect(embeddedBrowserMocks.setEmbeddedBrowserBounds).toHaveBeenCalled()
    })

    const staleMetricsClear = createDeferred<void>()
    embeddedBrowserMocks.setEmbeddedBrowserDeviceMetrics.mockImplementationOnce(
      () => staleMetricsClear.promise
    )
    fireEvent(window, new Event('resize'))
    await waitFor(() => {
      expect(embeddedBrowserMocks.setEmbeddedBrowserDeviceMetrics).toHaveBeenCalledWith(
        null,
        'workspace-browser'
      )
    })

    fireEvent.click(screen.getByTestId('workspace-browser-more-button'))
    fireEvent.click(screen.getByTestId('workspace-browser-device-toolbar-item'))
    await screen.findByTestId('workspace-browser-device-toolbar')
    await waitFor(() => {
      expect(embeddedBrowserMocks.setEmbeddedBrowserDeviceMetrics).toHaveBeenCalledWith(
        expect.objectContaining({ width: 390, height: 844 }),
        'workspace-browser'
      )
    })

    staleMetricsClear.resolve()
    await act(async () => {
      await staleMetricsClear.promise
      await new Promise(resolve => window.setTimeout(resolve, 120))
    })

    expect(embeddedBrowserMocks.setEmbeddedBrowserDeviceMetrics).toHaveBeenLastCalledWith(
      expect.objectContaining({ width: 390, height: 844 }),
      'workspace-browser'
    )
  })

  test('navigates to the browser settings page from the more menu', async () => {
    await openExamplePage()

    fireEvent.click(screen.getByTestId('workspace-browser-more-button'))
    fireEvent.click(screen.getByTestId('workspace-browser-settings-item'))

    expect(navigationMocks.navigateTo).toHaveBeenCalledWith('/settings/browser')
  })

  test('navigates to the browsing history page from the more menu above clear data', async () => {
    await openExamplePage()

    fireEvent.click(screen.getByTestId('workspace-browser-more-button'))
    const historyItem = screen.getByTestId('workspace-browser-history-item')
    const clearDataItem = screen.getByTestId('workspace-browser-clear-data-item')
    expect(
      historyItem.compareDocumentPosition(clearDataItem) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy()

    fireEvent.click(historyItem)
    expect(navigationMocks.navigateTo).toHaveBeenCalledWith('/settings/browser/history')
  })
})
