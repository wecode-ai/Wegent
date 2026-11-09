import '@/i18n'
import type { EmbeddedBrowserAgentStateEvent } from '@/lib/embedded-browser'
import { resetEmbeddedBrowserDownloadStoreForTests } from '@/lib/embedded-browser-download-store'
import type { BrowserAnnotationState } from '@/types/browser-annotation'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import { WorkspaceBrowserPanel } from './WorkspaceBrowserPanel'
import { openInExternalBrowser } from '@/lib/external-links'

const deviceSurfaceExtensionMock = vi.hoisted(() => ({
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

vi.mock('@extensions/device-surface', () => ({
  deviceSurfaceExtension: deviceSurfaceExtensionMock,
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
  openInExternalBrowser: vi.fn(async () => undefined),
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
    vi.resetAllMocks()
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
      canGoBack: true,
      canGoForward: true,
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

  test.each(['file:///Users/', 'file:///Users/mowei/readme.txt', 'https://example.com/'])(
    'opens the visible address %s explicitly in an external browser',
    async url => {
      embeddedBrowserMocks.openEmbeddedBrowser.mockResolvedValue({
        nativeLabel: 'workspace-browser-native-1',
        title: 'Browser fixture',
        url,
        isLoading: false,
      })
      mockBrowserHostRect()
      render(<WorkspaceBrowserPanel active />)
      const input = screen.getByTestId('workspace-browser-url-input')
      fireEvent.change(input, { target: { value: url } })
      fireEvent.submit(input.closest('form')!)
      const button = screen.getByTestId('workspace-browser-open-external-button')
      await waitFor(() => expect(button).toBeEnabled())
      fireEvent.click(button)
      await waitFor(() => expect(openInExternalBrowser).toHaveBeenCalledWith(url))
    }
  )

  test('shows external browser failures and clears the error when retrying successfully', async () => {
    vi.mocked(openInExternalBrowser).mockRejectedValueOnce(new Error('No browser configured'))
    mockBrowserHostRect()
    render(<WorkspaceBrowserPanel active />)
    const input = screen.getByTestId('workspace-browser-url-input')
    fireEvent.change(input, { target: { value: 'https://example.com/' } })
    fireEvent.submit(input.closest('form')!)
    const button = screen.getByTestId('workspace-browser-open-external-button')
    await waitFor(() => expect(button).toBeEnabled())
    fireEvent.click(button)
    expect(await screen.findByTestId('workspace-browser-error')).toHaveTextContent(
      '无法在外部浏览器中打开'
    )
    fireEvent.click(button)
    await waitFor(() =>
      expect(screen.queryByTestId('workspace-browser-error')).not.toBeInTheDocument()
    )
    expect(openInExternalBrowser).toHaveBeenCalledTimes(2)
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

  test.each([
    { status: 'error', code: 'operation_failed', text: 'AI 浏览器操作遇到问题' },
    { status: 'needs_user', code: 'wait_timeout', text: 'AI 需要你处理当前页面' },
  ] as const)(
    'shows $code without removing pending approval controls',
    ({ status, code, text }) => {
      let handleAgentState!: (event: EmbeddedBrowserAgentStateEvent) => void
      embeddedBrowserMocks.listenEmbeddedBrowserAgentState.mockImplementation(handler => {
        handleAgentState = handler
        return null
      })
      render(<WorkspaceBrowserPanel active />)
      act(() => {
        handleAgentState({
          label: 'workspace-browser',
          status,
          action: 'inspect',
          target: null,
          message: 'Inspection failed',
          errorCode: code,
          createdAtUnixMs: Date.now(),
          approval: {
            approvalId: 'pending-editor',
            risk: 'high',
            actionKind: 'fill',
            reason: 'Confirm editing this field.',
            target: null,
            expiresAtUnixMs: Date.now() + 60_000,
          },
        })
      })
      expect(screen.getByTestId('workspace-browser-agent-status')).toHaveTextContent(text)
      expect(screen.getByTestId('workspace-browser-agent-approval-approve-button')).toBeVisible()
      expect(screen.getByTestId('workspace-browser-agent-approval-reject-button')).toBeVisible()
    }
  )

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

  test.each(['success', 'failure'] as const)(
    'redacts sensitive URL details from browser open %s diagnostics',
    async outcome => {
      mockBrowserHostRect()
      const url =
        'https://alice:private-password@example.test/private-document?token=private-token#private-section'
      const infoLog = vi.spyOn(console, 'info').mockImplementation(() => {})
      const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {})
      if (outcome === 'failure') {
        embeddedBrowserMocks.openEmbeddedBrowser.mockRejectedValueOnce(
          new Error(`Failed to open ${url}`)
        )
        embeddedBrowserMocks.readEmbeddedBrowserPageState.mockRejectedValue(
          new Error('Browser unavailable')
        )
      } else {
        embeddedBrowserMocks.openEmbeddedBrowser.mockResolvedValueOnce({
          nativeLabel: 'workspace-browser-native-1',
          title: null,
          url,
          isLoading: false,
        })
      }
      const view = render(
        <WorkspaceBrowserPanel
          active
          openRequest={{
            id: 'private-link',
            baseLabel: 'workspace-browser',
            label: 'workspace-browser',
            source: 'user',
            disposition: 'new-tab',
            url,
          }}
        />
      )
      try {
        if (outcome === 'failure') {
          await screen.findByTestId('workspace-browser-error', {}, { timeout: 2000 })
        }
        const stage = outcome === 'failure' ? 'native_open_failed' : 'native_open_succeeded'
        await waitFor(() =>
          expect(infoLog).toHaveBeenCalledWith(
            '[Wework] Embedded browser open diagnostic',
            expect.stringContaining(`"stage":"${stage}"`)
          )
        )
        const diagnostics = JSON.stringify(
          [...infoLog.mock.calls, ...errorLog.mock.calls],
          (_key, value) => (value instanceof Error ? `${value.name}: ${value.message}` : value)
        )
        for (const sensitiveValue of [
          'alice',
          'private-password',
          'private-document',
          'private-token',
          'private-section',
        ]) {
          expect(diagnostics).not.toContain(sensitiveValue)
        }
        expect(infoLog).toHaveBeenCalledWith(
          '[Wework] Embedded browser open diagnostic',
          expect.stringContaining('"url":"https://example.test"')
        )
        if (outcome === 'failure') {
          expect(errorLog).toHaveBeenCalledWith(
            '[Wework] Embedded browser open failed',
            expect.stringContaining('"error":"Error"')
          )
        }
      } finally {
        view.unmount()
        infoLog.mockRestore()
        errorLog.mockRestore()
      }
    }
  )

  test.each(
    (['user', 'popup', 'restore', 'agent'] as const).flatMap(initialSource =>
      (['user', 'popup', 'restore'] as const).map(source => ({ initialSource, source }))
    )
  )(
    'navigates to the latest $source request received while a $initialSource browser is opening',
    async ({ initialSource, source }) => {
      mockBrowserHostRect()
      const opening = createDeferred<{
        nativeLabel: string
        title: null
        url: string
        isLoading: boolean
      }>()
      const nativeState = {
        nativeLabel: 'workspace-browser-native-1',
        title: null,
        url: initialSource === 'agent' ? 'about:blank' : 'https://first.example.test/',
        isLoading: false,
      }
      embeddedBrowserMocks.openEmbeddedBrowser.mockReturnValueOnce(opening.promise)
      embeddedBrowserMocks.readEmbeddedBrowserPageState.mockImplementation(async () => ({
        ...nativeState,
      }))
      embeddedBrowserMocks.navigateEmbeddedBrowser.mockImplementation(async (url: string) => {
        nativeState.url = url
      })
      const request = {
        id: 'first-link',
        baseLabel: 'workspace-browser',
        label: 'workspace-browser',
        source: initialSource,
        disposition: 'new-tab' as const,
        url: 'https://first.example.test/',
      }
      const view = render(<WorkspaceBrowserPanel active openRequest={request} />)
      await waitFor(() => expect(embeddedBrowserMocks.openEmbeddedBrowser).toHaveBeenCalledOnce())
      const bounds = { x: 500, y: 120, width: 400, height: 300 }
      if (initialSource === 'agent') {
        expect(embeddedBrowserMocks.openEmbeddedBrowser).toHaveBeenCalledWith(
          'about:blank',
          bounds,
          'workspace-browser',
          true,
          true,
          false
        )
      } else {
        expect(embeddedBrowserMocks.openEmbeddedBrowser).toHaveBeenCalledWith(
          request.url,
          bounds,
          'workspace-browser'
        )
      }

      view.rerender(
        <WorkspaceBrowserPanel
          active
          openRequest={{
            ...request,
            id: 'second-link',
            source,
            url: 'https://second.example.test/',
          }}
        />
      )
      await act(async () => opening.resolve({ ...nativeState }))

      await waitFor(() => {
        expect(embeddedBrowserMocks.navigateEmbeddedBrowser).toHaveBeenCalledWith(
          'https://second.example.test/',
          'workspace-browser'
        )
      })
      expect(nativeState.url).toBe('https://second.example.test/')
      expect(screen.getByTestId('workspace-browser-url-input')).toHaveValue(nativeState.url)
      expect(embeddedBrowserMocks.openEmbeddedBrowser).toHaveBeenCalledOnce()
    }
  )

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

  test('consumes a close request while its task pane is inactive', async () => {
    let handleClose!: (event: { label: string; nativeLabel: string }) => void
    embeddedBrowserMocks.listenEmbeddedBrowserCloseRequests.mockImplementation(handler => {
      handleClose = handler
      return Promise.resolve(vi.fn())
    })
    const view = render(<WorkspaceBrowserPanel active label="workspace-browser-runtime-1" />)
    await screen.findByTestId('workspace-browser-native-view')
    view.rerender(<WorkspaceBrowserPanel active={false} label="workspace-browser-runtime-1" />)

    act(() => {
      handleClose({
        label: 'workspace-browser-runtime-1',
        nativeLabel: 'workspace-browser-native-1',
      })
    })

    expect(screen.queryByTestId('workspace-browser-native-view')).not.toBeInTheDocument()
    expect(screen.getByTestId('workspace-browser-url-input')).toHaveValue('')
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

  test('preserves the address draft when the window deactivates with the input still focused', async () => {
    mockBrowserHostRect()
    const committedUrl = 'https://example.com/'
    embeddedBrowserMocks.readEmbeddedBrowserPageState.mockResolvedValue({
      nativeLabel: 'workspace-browser-native-1',
      title: 'Current page',
      url: committedUrl,
    })
    render(<WorkspaceBrowserPanel active />)
    const input = screen.getByTestId('workspace-browser-url-input') as HTMLInputElement
    fireEvent.change(input, { target: { value: committedUrl } })
    fireEvent.submit(input.closest('form')!)
    await waitFor(() => expect(embeddedBrowserMocks.openEmbeddedBrowser).toHaveBeenCalled())

    act(() => input.focus())
    fireEvent.change(input, { target: { value: 'localhost:6060/next' } })
    // Native window deactivation emits blur without changing the focused DOM node.
    fireEvent.blur(input)
    expect(document.activeElement).toBe(input)
    expect(input).toHaveValue('localhost:6060/next')

    act(() => input.blur())
    expect(document.activeElement).not.toBe(input)
    expect(input).toHaveValue(committedUrl)
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

  test('discards a pending page read after the browser panel unmounts', async () => {
    let handlePageStateChange!: (pageState: {
      label: string
      nativeLabel: string
      title: string | null
      url: string | null
      isLoading: boolean
      canGoBack?: boolean
      canGoForward?: boolean
    }) => void
    embeddedBrowserMocks.listenEmbeddedBrowserPageStateChanges.mockImplementation(handler => {
      handlePageStateChange = handler
      return Promise.resolve(() => undefined)
    })
    mockBrowserHostRect()
    const staleTitleChange = vi.fn()
    const firstView = render(<WorkspaceBrowserPanel active onTitleChange={staleTitleChange} />)

    const input = screen.getByTestId('workspace-browser-url-input')
    fireEvent.change(input, { target: { value: 'example.com' } })
    fireEvent.submit(input.closest('form')!)
    await waitFor(() => expect(embeddedBrowserMocks.openEmbeddedBrowser).toHaveBeenCalled())

    act(() => {
      handlePageStateChange({
        label: 'workspace-browser',
        nativeLabel: 'workspace-browser-native-1',
        title: 'Example Domain',
        url: 'https://example.com/',
        isLoading: false,
        canGoBack: true,
        canGoForward: false,
      })
    })

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
})
