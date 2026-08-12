import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import '@/i18n'
import { resetEmbeddedBrowserDownloadStoreForTests } from '@/lib/embedded-browser-download-store'
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
  clearEmbeddedBrowserData: vi.fn(),
  closeEmbeddedBrowser: vi.fn(),
  consumeEmbeddedBrowserLabelTransfer: vi.fn(),
  deleteEmbeddedBrowserDownload: vi.fn(),
  evalEmbeddedBrowser: vi.fn(),
  evalEmbeddedBrowserJson: vi.fn(),
  goBackEmbeddedBrowser: vi.fn(),
  goForwardEmbeddedBrowser: vi.fn(),
  isEmbeddedBrowserLabelTransferred: vi.fn(),
  listenEmbeddedBrowserAgentState: vi.fn(),
  listenEmbeddedBrowserCloseRequests: vi.fn(),
  listenEmbeddedBrowserDownloads: vi.fn(),
  listenEmbeddedBrowserInvalidTlsCertificates: vi.fn(),
  listenEmbeddedBrowserLocalFilePreview: vi.fn(),
  listenEmbeddedBrowserPageStateChanges: vi.fn(),
  navigateEmbeddedBrowser: vi.fn(),
  openEmbeddedBrowser: vi.fn(),
  pauseEmbeddedBrowserDownload: vi.fn(),
  readEmbeddedBrowserPageState: vi.fn(),
  relabelEmbeddedBrowser: vi.fn(),
  reloadEmbeddedBrowser: vi.fn(),
  resumeEmbeddedBrowserDownload: vi.fn(),
  resolveEmbeddedBrowserAgentApproval: vi.fn(),
  setEmbeddedBrowserAgentControlPaused: vi.fn(),
  setEmbeddedBrowserActiveTab: vi.fn(),
  setEmbeddedBrowserBounds: vi.fn(),
  EMBEDDED_BROWSER_DEBUG_PANEL_VISIBILITY_EVENT: 'wework:debug-panel-visibility-change',
  EMBEDDED_BROWSER_OCCLUSION_EVENT: 'wework:embedded-browser-occlusion-change',
}))

vi.mock('@/lib/embedded-browser', () => embeddedBrowserMocks)

vi.mock('@/lib/external-links', () => ({
  openExternalUrl: vi.fn(),
}))

const localTerminalMocks = vi.hoisted(() => ({
  revealLocalFile: vi.fn(),
}))

vi.mock('@/lib/local-terminal', () => localTerminalMocks)

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
    resetEmbeddedBrowserDownloadStoreForTests()
    vi.stubGlobal('ResizeObserver', ResizeObserverMock)
    embeddedBrowserMocks.canUseEmbeddedBrowser.mockReturnValue(true)
    embeddedBrowserMocks.consumeEmbeddedBrowserLabelTransfer.mockReturnValue(false)
    embeddedBrowserMocks.isEmbeddedBrowserLabelTransferred.mockReturnValue(false)
    embeddedBrowserMocks.listenEmbeddedBrowserAgentState.mockReturnValue(null)
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
    })
    embeddedBrowserMocks.readEmbeddedBrowserPageState.mockResolvedValue({
      nativeLabel: 'workspace-browser-native-1',
      title: 'Example Domain',
      url: 'https://example.com/',
    })
    embeddedBrowserMocks.closeEmbeddedBrowser.mockResolvedValue(undefined)
    embeddedBrowserMocks.clearEmbeddedBrowserData.mockResolvedValue(1)
    embeddedBrowserMocks.evalEmbeddedBrowser.mockResolvedValue(undefined)
    embeddedBrowserMocks.evalEmbeddedBrowserJson.mockResolvedValue([])
    embeddedBrowserMocks.goBackEmbeddedBrowser.mockResolvedValue(undefined)
    embeddedBrowserMocks.goForwardEmbeddedBrowser.mockResolvedValue(undefined)
    embeddedBrowserMocks.navigateEmbeddedBrowser.mockResolvedValue(undefined)
    embeddedBrowserMocks.reloadEmbeddedBrowser.mockResolvedValue(undefined)
    embeddedBrowserMocks.resumeEmbeddedBrowserDownload.mockResolvedValue(undefined)
    embeddedBrowserMocks.resolveEmbeddedBrowserAgentApproval.mockResolvedValue(undefined)
    embeddedBrowserMocks.setEmbeddedBrowserAgentControlPaused.mockResolvedValue(undefined)
    embeddedBrowserMocks.setEmbeddedBrowserBounds.mockResolvedValue(undefined)
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
      nativeLabel: string
      title: string | null
      url: string | null
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
    })
    render(<WorkspaceBrowserPanel active />)

    const input = screen.getByTestId('workspace-browser-url-input')
    fireEvent.focus(input)
    fireEvent.change(input, { target: { value: '/Users' } })
    fireEvent.submit(input.closest('form')!)
    await waitFor(() => expect(embeddedBrowserMocks.openEmbeddedBrowser).toHaveBeenCalled())

    act(() => {
      handlePageStateChange({
        nativeLabel: 'workspace-browser-native-1',
        title: 'mowei',
        url: 'file:///Users/mowei/',
        invalidTlsCertificate: null,
      })
    })

    expect(input).toHaveValue('file:///Users/mowei/')
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

  test('shows agent browser state and lets the user take over', async () => {
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
        status: 'running',
        action: 'click',
        target: 'index 2',
        message: null,
        errorCode: null,
        approval: null,
        createdAtUnixMs: Date.now(),
      })
    })

    expect(screen.getByTestId('workspace-browser-agent-status')).toHaveTextContent('AI 正在点击')
    fireEvent.click(screen.getByTestId('workspace-browser-agent-pause-button'))
    expect(embeddedBrowserMocks.setEmbeddedBrowserAgentControlPaused).toHaveBeenCalledWith(
      true,
      'workspace-browser'
    )
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
    embeddedBrowserMocks.listenEmbeddedBrowserDownloads.mockImplementation(handler => {
      handler({
        id: 'download-1',
        label: 'workspace-browser',
        nativeLabel: 'workspace-browser-native-1',
        url: 'https://example.com/app.dmg',
        path: '/Users/test/Downloads/app.dmg',
        status: 'finished',
        receivedBytes: 1024,
        totalBytes: 1024,
      })
      return null
    })

    render(<WorkspaceBrowserPanel active />)

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

    expect(await screen.findByTestId('workspace-browser-download-item')).toHaveTextContent(
      '50% · 5.0 MB / 10.0 MB'
    )
    expect(screen.getByTestId('workspace-browser-download-progress').firstChild).toHaveStyle({
      width: '50%',
    })
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

    expect(
      await within(destination.container).findByTestId('workspace-browser-download-item')
    ).toHaveTextContent('下载完成')
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

    expect(await screen.findByTestId('workspace-browser-download-item')).toHaveTextContent(
      'target.dmg'
    )
  })

  test('opens the embedded browser from an external open request', async () => {
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
        'https://example.test/',
        {
          x: 0,
          y: 0,
          width: 1,
          height: 1,
        },
        'workspace-browser',
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
        'https://example.test/',
        {
          x: 0,
          y: 0,
          width: 1,
          height: 1,
        },
        'workspace-browser',
        false,
        true
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

  test('hides the native browser while a main webview overlay occludes it', async () => {
    mockBrowserHostRect()
    render(<WorkspaceBrowserPanel active />)

    const input = screen.getByTestId('workspace-browser-url-input')
    fireEvent.change(input, { target: { value: 'example.com' } })
    fireEvent.submit(input.closest('form')!)

    await waitFor(() => {
      expect(embeddedBrowserMocks.openEmbeddedBrowser).toHaveBeenCalled()
    })

    embeddedBrowserMocks.setEmbeddedBrowserBounds.mockClear()
    window.dispatchEvent(
      new CustomEvent('wework:embedded-browser-occlusion-change', {
        detail: { id: 'workspace-add-menu', occluded: true },
      })
    )

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
    window.dispatchEvent(
      new CustomEvent('wework:embedded-browser-occlusion-change', {
        detail: { id: 'workspace-add-menu', occluded: false },
      })
    )

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
    document.body.append(dialogOverlay)

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
    dialogOverlay.remove()

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
    embeddedBrowserMocks.evalEmbeddedBrowserJson.mockResolvedValueOnce([
      {
        id: 'browser-annotation-1',
        number: 1,
        comment: '这里导航太抢眼',
        x: 20,
        y: 30,
        width: 140,
        height: 120,
        inspectId: 'wk-inspect-1',
        matchConfidence: 0.96,
        target: {
          inspectId: 'wk-inspect-1',
          ref: 'wk-mvp:wk-inspect-1:main:2:abc',
          index: 2,
          role: 'button',
          name: '审批',
          confidence: 0.96,
        },
        candidates: [
          {
            inspectId: 'wk-inspect-1',
            ref: 'wk-mvp:wk-inspect-1:main:2:abc',
            index: 2,
            role: 'button',
            name: '审批',
            confidence: 0.96,
          },
        ],
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
    const context = onAddCodeComment.mock.calls[0][0]
    const selectedText = JSON.parse(context.selectedText)
    expect(selectedText.inspectId).toBe('wk-inspect-1')
    expect(selectedText.target.ref).toBe('wk-mvp:wk-inspect-1:main:2:abc')
    expect(selectedText.matchConfidence).toBe(0.96)
    expect(screen.getByTestId('workspace-browser-annotation-count')).toHaveTextContent('1')
  })

  test('clear button wipes page annotation boxes while staying in annotation mode', async () => {
    mockBrowserHostRect()
    embeddedBrowserMocks.evalEmbeddedBrowserJson.mockResolvedValueOnce([
      {
        id: 'browser-annotation-1',
        number: 1,
        comment: '这里要改',
        x: 20,
        y: 30,
        width: 140,
        height: 120,
      },
    ])
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

    embeddedBrowserMocks.evalEmbeddedBrowser.mockClear()
    fireEvent.click(screen.getByTestId('workspace-browser-annotation-clear-button'))

    expect(screen.queryByTestId('workspace-browser-annotation-count')).not.toBeInTheDocument()
    expect(screen.getByTestId('workspace-browser-annotation-close-button')).toBeInTheDocument()
    expect(embeddedBrowserMocks.evalEmbeddedBrowser).toHaveBeenCalledWith(
      expect.stringContaining('__weworkBrowserAnnotationClear'),
      'workspace-browser'
    )
    expect(embeddedBrowserMocks.evalEmbeddedBrowser).toHaveBeenCalledWith(
      expect.stringContaining('[data-wework-annotation="box"]'),
      'workspace-browser'
    )
  })

  test('clears page annotation boxes when code comments are sent and mode exits', async () => {
    mockBrowserHostRect()
    embeddedBrowserMocks.evalEmbeddedBrowserJson.mockResolvedValueOnce([
      {
        id: 'browser-annotation-1',
        number: 1,
        comment: '第一处问题',
        x: 20,
        y: 30,
        width: 140,
        height: 120,
      },
      {
        id: 'browser-annotation-2',
        number: 2,
        comment: '第二处问题',
        x: 40,
        y: 80,
        width: 100,
        height: 60,
      },
    ])

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

    // Annotations attached in composer.
    rerender(<WorkspaceBrowserPanel active codeCommentCount={2} onAddCodeComment={vi.fn()} />)
    expect(screen.getByTestId('workspace-browser-annotation-close-button')).toBeInTheDocument()

    embeddedBrowserMocks.evalEmbeddedBrowser.mockClear()

    // Sending the message clears composer code comments and should exit annotation mode.
    rerender(<WorkspaceBrowserPanel active codeCommentCount={0} onAddCodeComment={vi.fn()} />)

    await waitFor(() => {
      expect(
        screen.queryByTestId('workspace-browser-annotation-close-button')
      ).not.toBeInTheDocument()
    })
    expect(screen.getByTestId('workspace-browser-annotate-button')).toBeInTheDocument()
    expect(embeddedBrowserMocks.evalEmbeddedBrowser).toHaveBeenCalledWith(
      expect.stringContaining('__weworkBrowserAnnotationClose'),
      'workspace-browser'
    )
    expect(embeddedBrowserMocks.evalEmbeddedBrowser).toHaveBeenCalledWith(
      expect.stringContaining('[data-wework-annotation]'),
      'workspace-browser'
    )
  })

  test('exits annotation mode before navigating to an internal extension page', async () => {
    mockBrowserHostRect()
    const onAddCodeComment = vi.fn()
    let resolvePendingAnnotations!: (
      annotations: Array<{
        id: string
        number: number
        comment: string
        x: number
        y: number
        width: number
        height: number
      }>
    ) => void
    const pendingAnnotations = new Promise<
      Array<{
        id: string
        number: number
        comment: string
        x: number
        y: number
        width: number
        height: number
      }>
    >(resolve => {
      resolvePendingAnnotations = resolve
    })
    embeddedBrowserMocks.evalEmbeddedBrowserJson.mockReturnValueOnce(pendingAnnotations)
    const { rerender } = render(
      <WorkspaceBrowserPanel active onAddCodeComment={onAddCodeComment} />
    )

    const input = screen.getByTestId('workspace-browser-url-input')
    fireEvent.change(input, { target: { value: 'example.com' } })
    fireEvent.submit(input.closest('form')!)

    await waitFor(() => {
      expect(embeddedBrowserMocks.openEmbeddedBrowser).toHaveBeenCalled()
    })
    fireEvent.click(screen.getByTestId('workspace-browser-annotate-button'))
    await screen.findByTestId('workspace-browser-annotation-close-button')
    await waitFor(() => expect(embeddedBrowserMocks.evalEmbeddedBrowserJson).toHaveBeenCalled())

    embeddedBrowserMocks.evalEmbeddedBrowser.mockClear()
    const extensionUrl = new URL(
      '/extension-page.html?sessionId=123e4567-e89b-42d3-a456-426614174000&contextId=context-1',
      window.location.href
    ).toString()
    embeddedBrowserMocks.readEmbeddedBrowserPageState.mockResolvedValue({
      nativeLabel: 'workspace-browser-native-1',
      title: 'Extension page - context-1',
      url: extensionUrl,
    })
    rerender(
      <WorkspaceBrowserPanel
        active
        openRequest={{
          id: 'test-2',
          baseLabel: 'workspace-browser',
          source: 'agent',
          disposition: 'current-tab',
          label: 'workspace-browser',
          url: extensionUrl,
        }}
        onAddCodeComment={onAddCodeComment}
      />
    )

    await waitFor(() => {
      expect(
        screen.queryByTestId('workspace-browser-annotation-close-button')
      ).not.toBeInTheDocument()
    })
    expect(screen.getByTestId('workspace-browser-url-input')).toHaveValue(extensionUrl)
    expect(screen.getByTestId('workspace-browser-annotate-button')).toBeDisabled()
    expect(screen.getByTestId('workspace-browser-open-external-button')).toBeDisabled()
    resolvePendingAnnotations([
      {
        id: 'stale-annotation',
        number: 1,
        comment: 'must not escape the previous page',
        x: 1,
        y: 2,
        width: 3,
        height: 4,
      },
    ])
    await pendingAnnotations
    await Promise.resolve()
    expect(onAddCodeComment).not.toHaveBeenCalled()
    const consumeCallCount = embeddedBrowserMocks.evalEmbeddedBrowserJson.mock.calls.length
    await new Promise(resolve => window.setTimeout(resolve, 550))
    expect(embeddedBrowserMocks.evalEmbeddedBrowserJson).toHaveBeenCalledTimes(consumeCallCount)
    expect(embeddedBrowserMocks.evalEmbeddedBrowser).toHaveBeenCalledWith(
      expect.stringContaining('__weworkBrowserAnnotationClose'),
      'workspace-browser'
    )
    expect(embeddedBrowserMocks.evalEmbeddedBrowser).toHaveBeenCalledWith(
      expect.stringContaining('[data-wework-annotation]'),
      'workspace-browser'
    )
  })

  test('cleans the annotation layer when browser history reaches an internal extension page', async () => {
    mockBrowserHostRect()
    render(<WorkspaceBrowserPanel active onAddCodeComment={vi.fn()} />)

    const input = screen.getByTestId('workspace-browser-url-input')
    fireEvent.change(input, { target: { value: 'example.com' } })
    fireEvent.submit(input.closest('form')!)
    await waitFor(() => expect(embeddedBrowserMocks.openEmbeddedBrowser).toHaveBeenCalled())

    fireEvent.click(screen.getByTestId('workspace-browser-annotate-button'))
    await screen.findByTestId('workspace-browser-annotation-close-button')
    embeddedBrowserMocks.evalEmbeddedBrowser.mockClear()

    const extensionUrl = new URL(
      '/extension-page.html?sessionId=123e4567-e89b-42d3-a456-426614174000&contextId=context-1',
      window.location.href
    ).toString()
    embeddedBrowserMocks.readEmbeddedBrowserPageState.mockResolvedValue({
      nativeLabel: 'workspace-browser-native-1',
      title: 'Extension page - context-1',
      url: extensionUrl,
    })

    await waitFor(
      () => {
        expect(
          screen.queryByTestId('workspace-browser-annotation-close-button')
        ).not.toBeInTheDocument()
      },
      { timeout: 5_000 }
    )
    expect(screen.getByTestId('workspace-browser-url-input')).toHaveValue(extensionUrl)
    expect(embeddedBrowserMocks.evalEmbeddedBrowser).toHaveBeenCalledWith(
      expect.stringContaining('__weworkBrowserAnnotationClose'),
      'workspace-browser'
    )
    expect(embeddedBrowserMocks.evalEmbeddedBrowser).toHaveBeenCalledWith(
      expect.stringContaining('[data-wework-annotation]'),
      'workspace-browser'
    )
  })

  test('uses the latest annotation mode when a pending page read reaches an extension page', async () => {
    mockBrowserHostRect()
    render(<WorkspaceBrowserPanel active onAddCodeComment={vi.fn()} />)

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

    fireEvent.click(screen.getByTestId('workspace-browser-annotate-button'))
    await screen.findByTestId('workspace-browser-annotation-close-button')
    embeddedBrowserMocks.evalEmbeddedBrowser.mockClear()

    const extensionUrl = new URL(
      '/extension-page.html?sessionId=123e4567-e89b-42d3-a456-426614174000&contextId=context-1',
      window.location.href
    ).toString()
    await act(async () => {
      resolvePageState({
        nativeLabel: 'workspace-browser-native-1',
        title: 'Extension page - context-1',
        url: extensionUrl,
      })
      await pendingPageState
    })

    await waitFor(
      () => {
        expect(
          screen.queryByTestId('workspace-browser-annotation-close-button')
        ).not.toBeInTheDocument()
      },
      { timeout: 250 }
    )
    expect(embeddedBrowserMocks.evalEmbeddedBrowser).toHaveBeenCalledWith(
      expect.stringContaining('__weworkBrowserAnnotationClose'),
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
    embeddedBrowserMocks.evalEmbeddedBrowser.mockClear()
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
    expect(embeddedBrowserMocks.evalEmbeddedBrowser).not.toHaveBeenCalled()
    expect(screen.getByTestId('workspace-browser-url-input')).not.toHaveValue(extensionUrl)
  })

  test('does not let a pending annotation injection clear a remounted browser label', async () => {
    mockBrowserHostRect()
    let resolveInjection!: () => void
    const pendingInjection = new Promise<void>(resolve => {
      resolveInjection = resolve
    })
    embeddedBrowserMocks.evalEmbeddedBrowser.mockReturnValueOnce(pendingInjection)
    const firstView = render(<WorkspaceBrowserPanel active />)

    const input = screen.getByTestId('workspace-browser-url-input')
    fireEvent.change(input, { target: { value: 'example.com' } })
    fireEvent.submit(input.closest('form')!)
    await waitFor(() => expect(embeddedBrowserMocks.openEmbeddedBrowser).toHaveBeenCalled())
    fireEvent.click(screen.getByTestId('workspace-browser-annotate-button'))
    await waitFor(() => expect(embeddedBrowserMocks.evalEmbeddedBrowser).toHaveBeenCalled())

    embeddedBrowserMocks.evalEmbeddedBrowser.mockClear()
    firstView.unmount()
    render(<WorkspaceBrowserPanel active />)
    await act(async () => {
      resolveInjection()
      await pendingInjection
    })

    expect(embeddedBrowserMocks.evalEmbeddedBrowser).not.toHaveBeenCalled()
    expect(
      screen.queryByTestId('workspace-browser-annotation-close-button')
    ).not.toBeInTheDocument()
  })

  test('cleans a pending annotation injection after the browser becomes inactive', async () => {
    mockBrowserHostRect()
    let resolveInjection!: () => void
    const pendingInjection = new Promise<void>(resolve => {
      resolveInjection = resolve
    })
    embeddedBrowserMocks.evalEmbeddedBrowser.mockReturnValueOnce(pendingInjection)
    const view = render(<WorkspaceBrowserPanel active />)

    const input = screen.getByTestId('workspace-browser-url-input')
    fireEvent.change(input, { target: { value: 'example.com' } })
    fireEvent.submit(input.closest('form')!)
    await waitFor(() => expect(embeddedBrowserMocks.openEmbeddedBrowser).toHaveBeenCalled())
    fireEvent.click(screen.getByTestId('workspace-browser-annotate-button'))
    await waitFor(() => expect(embeddedBrowserMocks.evalEmbeddedBrowser).toHaveBeenCalled())

    embeddedBrowserMocks.evalEmbeddedBrowser.mockClear()
    view.rerender(<WorkspaceBrowserPanel active={false} />)
    view.rerender(<WorkspaceBrowserPanel active />)
    await act(async () => {
      resolveInjection()
      await pendingInjection
    })

    expect(embeddedBrowserMocks.evalEmbeddedBrowser).toHaveBeenCalledWith(
      expect.stringContaining('__weworkBrowserAnnotationClose'),
      'workspace-browser'
    )
    expect(
      screen.queryByTestId('workspace-browser-annotation-close-button')
    ).not.toBeInTheDocument()
  })

  test('does not clear a newer annotation injection when an inactive request settles', async () => {
    mockBrowserHostRect()
    let resolveFirstInjection!: () => void
    const firstInjection = new Promise<void>(resolve => {
      resolveFirstInjection = resolve
    })
    embeddedBrowserMocks.evalEmbeddedBrowser.mockReturnValueOnce(firstInjection)
    const view = render(<WorkspaceBrowserPanel active />)

    const input = screen.getByTestId('workspace-browser-url-input')
    fireEvent.change(input, { target: { value: 'example.com' } })
    fireEvent.submit(input.closest('form')!)
    await waitFor(() => expect(embeddedBrowserMocks.openEmbeddedBrowser).toHaveBeenCalled())
    fireEvent.click(screen.getByTestId('workspace-browser-annotate-button'))
    await waitFor(() => expect(embeddedBrowserMocks.evalEmbeddedBrowser).toHaveBeenCalled())

    view.rerender(<WorkspaceBrowserPanel active={false} />)
    view.rerender(<WorkspaceBrowserPanel active />)
    fireEvent.click(screen.getByTestId('workspace-browser-annotate-button'))
    await screen.findByTestId('workspace-browser-annotation-close-button')

    embeddedBrowserMocks.evalEmbeddedBrowser.mockClear()
    await act(async () => {
      resolveFirstInjection()
      await firstInjection
    })

    expect(embeddedBrowserMocks.evalEmbeddedBrowser).not.toHaveBeenCalled()
    expect(screen.getByTestId('workspace-browser-annotation-close-button')).toBeInTheDocument()
  })

  test('ignores a pending annotation injection failure after the browser label changes', async () => {
    mockBrowserHostRect()
    let rejectInjection!: (error: Error) => void
    const pendingInjection = new Promise<void>((_resolve, reject) => {
      rejectInjection = reject
    })
    embeddedBrowserMocks.evalEmbeddedBrowser.mockReturnValueOnce(pendingInjection)
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const view = render(<WorkspaceBrowserPanel active label="workspace-browser" />)

    const input = screen.getByTestId('workspace-browser-url-input')
    fireEvent.change(input, { target: { value: 'example.com' } })
    fireEvent.submit(input.closest('form')!)
    await waitFor(() => expect(embeddedBrowserMocks.openEmbeddedBrowser).toHaveBeenCalled())
    fireEvent.click(screen.getByTestId('workspace-browser-annotate-button'))
    await waitFor(() => expect(embeddedBrowserMocks.evalEmbeddedBrowser).toHaveBeenCalled())

    view.rerender(<WorkspaceBrowserPanel active label="next-browser" />)
    consoleError.mockClear()
    await act(async () => {
      rejectInjection(new Error('stale annotation injection'))
      await pendingInjection.catch(() => undefined)
    })

    expect(consoleError).not.toHaveBeenCalled()
    expect(
      screen.queryByTestId('workspace-browser-annotation-close-button')
    ).not.toBeInTheDocument()
    consoleError.mockRestore()
  })
})
