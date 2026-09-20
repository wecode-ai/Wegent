import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

import { VncClipboardWriteTooLargeError } from './vnc-device-clipboard'
import { VncViewer } from './VncViewer'

const invokeDesktopHostMock = vi.hoisted(() => vi.fn())
const runtimeState = vi.hoisted(() => ({ electron: true }))
const rfbState = vi.hoisted(() => ({
  instances: [] as Array<
    EventTarget & {
      clipViewport: boolean
      compressionLevel: number
      enableH264: boolean
      focus: ReturnType<typeof vi.fn>
      focusOnClick: boolean
      qualityLevel: number
      remoteResizeDebounce: number
      remoteResizePixelRatio: number
      resizeSession: boolean
      scaleViewport: boolean
      viewOnly: boolean
      clipboardPasteFrom: ReturnType<typeof vi.fn>
      disconnect: ReturnType<typeof vi.fn>
      sendKey: ReturnType<typeof vi.fn>
      url: string
    }
  >,
}))

vi.mock('@novnc/novnc', () => ({
  default: class MockRfb extends EventTarget {
    clipViewport = false
    compressionLevel = 0
    enableH264 = true
    focus = vi.fn()
    focusOnClick = false
    qualityLevel = 0
    remoteResizeDebounce = 0
    remoteResizePixelRatio = 0
    resizeSession = false
    scaleViewport = false
    viewOnly = false
    clipboardPasteFrom = vi.fn()
    disconnect = vi.fn()
    sendKey = vi.fn()

    constructor(
      readonly target: HTMLElement,
      readonly url: string
    ) {
      super()
      rfbState.instances.push(this)
    }
  },
}))

vi.mock('@/api/dsh/desktopHost', () => ({
  invokeDesktopHost: invokeDesktopHostMock,
}))

vi.mock('@/lib/runtime-environment', () => ({
  isElectronRuntime: () => runtimeState.electron,
}))

const i18nState = vi.hoisted(() => ({ revision: 0 }))

// Stands in for react-i18next, which returns a new `t` on every language change.
const translations = new Map<number, (key: string) => string>()
vi.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => {
    const revision = i18nState.revision
    let t = translations.get(revision)
    if (!t) {
      t = (key: string) => key
      translations.set(revision, t)
    }
    return { t }
  },
}))

// The remote is a full Linux desktop, so copy and paste use plain Control.
const REMOTE_COPY_KEYS = [
  [0xffe3, 'ControlLeft', true],
  [0x0063, 'KeyC', true],
  [0x0063, 'KeyC', false],
  [0xffe3, 'ControlLeft', false],
]
const REMOTE_PASTE_KEYS = [
  [0xffe3, 'ControlLeft', true],
  [0x0076, 'KeyV', true],
  [0x0076, 'KeyV', false],
  [0xffe3, 'ControlLeft', false],
]
// macOS Command keys map to remote Alt/Super and are released first.
const REMOTE_MAC_COPY_KEYS = [
  [0xffe9, 'MetaLeft', false],
  [0xffeb, 'MetaRight', false],
  ...REMOTE_COPY_KEYS,
]

describe('VncViewer', () => {
  afterEach(() => vi.restoreAllMocks())

  beforeEach(() => {
    runtimeState.electron = true
    i18nState.revision = 0
    invokeDesktopHostMock.mockReset()
    rfbState.instances.length = 0
    vi.spyOn(document, 'hasFocus').mockReturnValue(true)
    invokeDesktopHostMock.mockImplementation(async capability => {
      if (capability === 'vncClipboard.readText') return 'native clipboard'
      return undefined
    })
  })

  test('connects noVNC with only the websocket URL and configures the viewport', async () => {
    render(<VncViewer websocketUrl="ws://127.0.0.1/session/websockify?token=secret" />)

    expect(rfbState.instances).toHaveLength(1)
    expect(rfbState.instances[0].url).toBe('ws://127.0.0.1/session/websockify?token=secret')
    expect(rfbState.instances[0].scaleViewport).toBe(true)
    expect(rfbState.instances[0].resizeSession).toBe(true)
    expect(rfbState.instances[0].clipViewport).toBe(true)
    expect(rfbState.instances[0].qualityLevel).toBe(8)
    expect(rfbState.instances[0].compressionLevel).toBe(2)
    expect(rfbState.instances[0].remoteResizeDebounce).toBe(250)
    expect(rfbState.instances[0].remoteResizePixelRatio).toBe(1)
    expect(rfbState.instances[0].enableH264).toBe(true)

    act(() => {
      rfbState.instances[0].dispatchEvent(new Event('connect'))
    })

    expect(await screen.findByTestId('vnc-viewer-status')).toHaveTextContent(
      'workbench.device_desktop_connected'
    )
    expect(rfbState.instances[0].focus).toHaveBeenCalledOnce()
    expect(invokeDesktopHostMock).toHaveBeenCalledWith('vncClipboard.activate', {
      leaseId: expect.any(String),
    })
  })

  test('bridges remote and native clipboard text through the active Electron lease', async () => {
    render(<VncViewer websocketUrl="ws://127.0.0.1/session/websockify?token=secret" />)
    const rfb = rfbState.instances[0]

    act(() => {
      rfb.dispatchEvent(new Event('connect'))
    })
    await waitFor(() =>
      expect(invokeDesktopHostMock).toHaveBeenCalledWith('vncClipboard.activate', {
        leaseId: expect.any(String),
      })
    )
    invokeDesktopHostMock.mockClear()

    act(() => {
      rfb.dispatchEvent(new CustomEvent('clipboard', { detail: { text: 'remote text' } }))
    })

    await waitFor(() =>
      expect(invokeDesktopHostMock).toHaveBeenCalledWith('vncClipboard.writeText', {
        leaseId: expect.any(String),
        text: 'remote text',
      })
    )
    expect(invokeDesktopHostMock).toHaveBeenCalledWith('vncClipboard.activate', {
      leaseId: expect.any(String),
    })
    expect(await screen.findByTestId('vnc-viewer-clipboard-notice')).toHaveTextContent(
      'workbench.device_desktop_clipboard_copied'
    )

    fireEvent.click(screen.getByTestId('vnc-viewer-paste-button'))

    await waitFor(() => expect(rfb.clipboardPasteFrom).toHaveBeenCalledWith('native clipboard'))
    expect(rfb.sendKey).not.toHaveBeenCalled()
    await waitFor(() => expect(rfb.sendKey.mock.calls).toEqual(REMOTE_PASTE_KEYS))
    act(() => rfb.dispatchEvent(new CustomEvent('clipboardpastecomplete', { detail: {} })))
    expect(invokeDesktopHostMock).toHaveBeenCalledWith('vncClipboard.readText', {
      leaseId: expect.any(String),
    })
    expect(screen.getByTestId('vnc-viewer-clipboard-notice')).toHaveTextContent(
      'workbench.device_desktop_clipboard_synced'
    )
  })

  test('uses the device command clipboard bridge for a cloud VNC desktop', async () => {
    const clipboardBridge = {
      readText: vi.fn(async () => 'remote command clipboard'),
      writeText: vi.fn(async () => undefined),
    }
    render(
      <VncViewer
        clipboardBridge={clipboardBridge}
        websocketUrl="ws://127.0.0.1/session/websockify?token=secret"
      />
    )
    const rfb = rfbState.instances[0]
    act(() => rfb.dispatchEvent(new Event('connect')))

    fireEvent.click(screen.getByTestId('vnc-viewer-paste-button'))

    await waitFor(() => expect(clipboardBridge.writeText).toHaveBeenCalledWith('native clipboard'))
    expect(rfb.clipboardPasteFrom).not.toHaveBeenCalled()
    await waitFor(() => expect(rfb.sendKey.mock.calls).toEqual(REMOTE_PASTE_KEYS))
    expect(screen.getByTestId('vnc-viewer-clipboard-notice')).toHaveTextContent(
      'workbench.device_desktop_clipboard_synced'
    )

    rfb.sendKey.mockClear()
    invokeDesktopHostMock.mockClear()
    fireEvent.copy(screen.getByTestId('vnc-viewer'))

    await waitFor(() => expect(clipboardBridge.readText).toHaveBeenCalledOnce())
    await waitFor(() =>
      expect(invokeDesktopHostMock).toHaveBeenCalledWith('vncClipboard.writeText', {
        leaseId: expect.any(String),
        text: 'remote command clipboard',
      })
    )
    expect(rfb.sendKey.mock.calls).toEqual(REMOTE_COPY_KEYS)

    invokeDesktopHostMock.mockClear()
    act(() => {
      rfb.dispatchEvent(new CustomEvent('clipboard', { detail: { text: 'stale RFB text' } }))
    })
    expect(invokeDesktopHostMock).not.toHaveBeenCalledWith(
      'vncClipboard.writeText',
      expect.anything()
    )
  })

  test('waits for the remote clipboard owner before sending the cloud paste shortcut', async () => {
    vi.useFakeTimers()
    try {
      const clipboardBridge = {
        readText: vi.fn(async () => ''),
        writeText: vi.fn(async () => undefined),
      }
      render(
        <VncViewer
          clipboardBridge={clipboardBridge}
          websocketUrl="ws://127.0.0.1/session/websockify?token=secret"
        />
      )
      const rfb = rfbState.instances[0]
      act(() => rfb.dispatchEvent(new Event('connect')))

      fireEvent.click(screen.getByTestId('vnc-viewer-paste-button'))
      await act(async () => {
        await Promise.resolve()
        await Promise.resolve()
        await Promise.resolve()
      })

      expect(clipboardBridge.writeText).toHaveBeenCalledWith('native clipboard')
      expect(rfb.sendKey).not.toHaveBeenCalled()

      await act(async () => vi.advanceTimersByTimeAsync(249))
      expect(rfb.sendKey).not.toHaveBeenCalled()

      await act(async () => vi.advanceTimersByTimeAsync(1))
      expect(rfb.sendKey.mock.calls).toEqual(REMOTE_PASTE_KEYS)
    } finally {
      vi.useRealTimers()
    }
  })

  test('surfaces the clipboard size limit instead of a generic failure', async () => {
    const clipboardBridge = {
      readText: vi.fn(async () => ''),
      writeText: vi.fn(async () => {
        throw new VncClipboardWriteTooLargeError()
      }),
    }
    render(
      <VncViewer
        clipboardBridge={clipboardBridge}
        websocketUrl="ws://127.0.0.1/session/websockify?token=secret"
      />
    )
    const rfb = rfbState.instances[0]
    act(() => rfb.dispatchEvent(new Event('connect')))

    fireEvent.click(screen.getByTestId('vnc-viewer-paste-button'))

    expect(await screen.findByTestId('vnc-viewer-clipboard-error')).toHaveTextContent(
      'workbench.device_desktop_clipboard_too_large'
    )
  })

  test('retries the Electron clipboard lease when the window regains focus', async () => {
    let activationAttempts = 0
    invokeDesktopHostMock.mockImplementation(async capability => {
      if (capability === 'vncClipboard.activate') {
        activationAttempts += 1
        if (activationAttempts === 1) throw new Error('window_not_focused')
      }
      return undefined
    })
    render(<VncViewer websocketUrl="ws://127.0.0.1/session/websockify?token=secret" />)

    await waitFor(() => expect(activationAttempts).toBe(1))
    act(() => window.dispatchEvent(new Event('focus')))

    await waitFor(() => expect(activationAttempts).toBe(2))
  })

  test('retries the Electron clipboard lease from the toolbar action', async () => {
    let activationAttempts = 0
    invokeDesktopHostMock.mockImplementation(async capability => {
      if (capability === 'vncClipboard.activate') {
        activationAttempts += 1
        if (activationAttempts < 3) throw new Error('window_not_focused')
      }
      if (capability === 'vncClipboard.readText') return 'clipboard after focus'
      return undefined
    })
    render(<VncViewer websocketUrl="ws://127.0.0.1/session/websockify?token=secret" />)
    const rfb = rfbState.instances[0]

    act(() => rfb.dispatchEvent(new Event('connect')))
    fireEvent.click(screen.getByTestId('vnc-viewer-paste-button'))

    await waitFor(() =>
      expect(rfb.clipboardPasteFrom).toHaveBeenCalledWith('clipboard after focus')
    )
    expect(activationAttempts).toBe(3)
  })

  test('uses the browser Clipboard API outside Electron', async () => {
    runtimeState.electron = false
    const readText = vi.fn(async () => 'browser clipboard')
    const writeText = vi.fn(async () => undefined)
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { readText, writeText },
    })
    render(<VncViewer websocketUrl="ws://127.0.0.1/session/websockify?token=secret" />)
    const rfb = rfbState.instances[0]

    act(() => {
      rfb.dispatchEvent(new Event('connect'))
      rfb.dispatchEvent(new CustomEvent('clipboard', { detail: { text: 'remote browser text' } }))
    })

    await waitFor(() => expect(writeText).toHaveBeenCalledWith('remote browser text'))
    fireEvent.click(screen.getByTestId('vnc-viewer-paste-button'))
    await waitFor(() => expect(rfb.clipboardPasteFrom).toHaveBeenCalledWith('browser clipboard'))
    expect(invokeDesktopHostMock).not.toHaveBeenCalled()
  })

  test('uses the fixed smooth rendering profile without optional toolbar controls', () => {
    render(<VncViewer websocketUrl="wss://cloud.example.com/vnc?ticket=single-use" />)
    const rfb = rfbState.instances[0]

    expect(rfb.qualityLevel).toBe(8)
    expect(rfb.compressionLevel).toBe(2)
    expect(rfb.remoteResizePixelRatio).toBe(1)
    expect(rfb.enableH264).toBe(true)
    expect(screen.queryByTestId('vnc-viewer-quality-profile')).not.toBeInTheDocument()
    expect(screen.queryByTestId('vnc-viewer-ctrl-alt-del-button')).not.toBeInTheDocument()
    expect(screen.queryByTestId('vnc-viewer-view-only-button')).not.toBeInTheDocument()
    expect(rfbState.instances).toHaveLength(1)
  })

  test('reports the selected server encoding without including the websocket URL', () => {
    const metricListener = vi.fn()
    window.addEventListener('wework:vnc-metric', metricListener)
    try {
      render(<VncViewer websocketUrl="wss://cloud.example.com/vnc?ticket=secret" />)

      act(() => {
        rfbState.instances[0].dispatchEvent(
          new CustomEvent('encodingchange', { detail: { encoding: 7, name: 'Tight' } })
        )
      })

      expect(metricListener).toHaveBeenCalledOnce()
      const event = metricListener.mock.calls[0][0] as CustomEvent<Record<string, unknown>>
      expect(event.detail).toEqual({
        metric: 'encoding',
        name: 'Tight',
        encoding: 7,
        profile: 'smooth',
      })
      expect(JSON.stringify(event.detail)).not.toContain('secret')
    } finally {
      window.removeEventListener('wework:vnc-metric', metricListener)
    }
  })

  test('reports time to first framebuffer update without including the websocket URL', () => {
    const metricListener = vi.fn()
    window.addEventListener('wework:vnc-metric', metricListener)
    try {
      render(<VncViewer websocketUrl="wss://cloud.example.com/vnc?ticket=secret" />)

      act(() => {
        rfbState.instances[0].dispatchEvent(new CustomEvent('framebufferupdate', { detail: {} }))
      })

      expect(screen.getByTestId('vnc-viewer')).toHaveAttribute('data-vnc-first-frame', 'true')
      expect(metricListener).toHaveBeenCalledOnce()
      const event = metricListener.mock.calls[0][0] as CustomEvent<Record<string, unknown>>
      expect(event.detail).toMatchObject({
        metric: 'first-frame',
        profile: 'smooth',
        durationMs: expect.any(Number),
      })
      expect(JSON.stringify(event.detail)).not.toContain('secret')
    } finally {
      window.removeEventListener('wework:vnc-metric', metricListener)
    }
  })

  test('handles a real paste event with the Linux terminal shortcut', async () => {
    render(<VncViewer websocketUrl="ws://127.0.0.1/session/websockify?token=secret" />)
    const rfb = rfbState.instances[0]
    await waitFor(() =>
      expect(invokeDesktopHostMock).toHaveBeenCalledWith('vncClipboard.activate', {
        leaseId: expect.any(String),
      })
    )
    act(() => rfb.dispatchEvent(new Event('connect')))

    fireEvent.paste(screen.getByTestId('vnc-viewer'), {
      clipboardData: {
        getData: (type: string) => (type === 'text/plain' ? 'keyboard paste' : ''),
      },
    })
    expect(rfb.clipboardPasteFrom).toHaveBeenCalledWith('keyboard paste')
    expect(rfb.sendKey).not.toHaveBeenCalled()
    await waitFor(() => expect(rfb.sendKey.mock.calls).toEqual(REMOTE_PASTE_KEYS))
    act(() => rfb.dispatchEvent(new CustomEvent('clipboardpastecomplete', { detail: {} })))
  })

  test('maps macOS Command+C to remote terminal copy without leaving Command pressed', () => {
    Object.defineProperty(navigator, 'platform', {
      configurable: true,
      value: 'MacIntel',
    })
    render(<VncViewer websocketUrl="ws://127.0.0.1/session/websockify?token=secret" />)
    const rfb = rfbState.instances[0]
    act(() => rfb.dispatchEvent(new Event('connect')))

    fireEvent.keyDown(screen.getByTestId('vnc-viewer-canvas'), {
      code: 'KeyC',
      key: 'c',
      metaKey: true,
    })

    expect(rfb.sendKey.mock.calls).toEqual(REMOTE_MAC_COPY_KEYS)
  })

  test('requests a fresh one-time session after disconnect', () => {
    const onReconnectRequired = vi.fn()
    render(
      <VncViewer
        websocketUrl="ws://127.0.0.1/session/websockify?ticket=single-use"
        onReconnectRequired={onReconnectRequired}
      />
    )

    act(() => {
      rfbState.instances[0].dispatchEvent(
        new CustomEvent('disconnect', { detail: { clean: false } })
      )
    })
    fireEvent.click(screen.getByTestId('vnc-viewer-disconnect-button'))

    expect(onReconnectRequired).toHaveBeenCalledOnce()
  })

  test('keeps the live connection when the translation function changes', () => {
    const { rerender } = render(
      <VncViewer websocketUrl="ws://127.0.0.1/session/websockify?ticket=single-use" />
    )
    const rfb = rfbState.instances[0]
    act(() => rfb.dispatchEvent(new Event('connect')))

    i18nState.revision += 1
    rerender(<VncViewer websocketUrl="ws://127.0.0.1/session/websockify?ticket=single-use" />)

    expect(rfb.disconnect).not.toHaveBeenCalled()
    expect(rfbState.instances).toHaveLength(1)
  })
})
