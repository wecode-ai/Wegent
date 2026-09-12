import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, test, vi } from 'vitest'

import { VncViewer } from './VncViewer'

const invokeDesktopHostMock = vi.hoisted(() => vi.fn())
const runtimeState = vi.hoisted(() => ({ electron: true }))
const rfbState = vi.hoisted(() => ({
  instances: [] as Array<
    EventTarget & {
      clipViewport: boolean
      compressionLevel: number
      focus: ReturnType<typeof vi.fn>
      focusOnClick: boolean
      qualityLevel: number
      resizeSession: boolean
      scaleViewport: boolean
      viewOnly: boolean
      clipboardPasteFrom: ReturnType<typeof vi.fn>
      disconnect: ReturnType<typeof vi.fn>
      sendCtrlAltDel: ReturnType<typeof vi.fn>
      url: string
    }
  >,
}))

vi.mock('@novnc/novnc', () => ({
  default: class MockRfb extends EventTarget {
    clipViewport = false
    compressionLevel = 0
    focus = vi.fn()
    focusOnClick = false
    qualityLevel = 0
    resizeSession = false
    scaleViewport = false
    viewOnly = false
    clipboardPasteFrom = vi.fn()
    disconnect = vi.fn()
    sendCtrlAltDel = vi.fn()

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

describe('VncViewer', () => {
  beforeEach(() => {
    runtimeState.electron = true
    invokeDesktopHostMock.mockReset()
    rfbState.instances.length = 0
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
      rfb.dispatchEvent(new CustomEvent('clipboard', { detail: { text: 'remote text' } }))
    })

    await waitFor(() =>
      expect(invokeDesktopHostMock).toHaveBeenCalledWith('vncClipboard.writeText', {
        leaseId: expect.any(String),
        text: 'remote text',
      })
    )
    expect(await screen.findByTestId('vnc-viewer-clipboard-notice')).toHaveTextContent(
      'workbench.device_desktop_clipboard_copied'
    )

    fireEvent.click(screen.getByTestId('vnc-viewer-paste-button'))

    await waitFor(() => expect(rfb.clipboardPasteFrom).toHaveBeenCalledWith('native clipboard'))
    expect(invokeDesktopHostMock).toHaveBeenCalledWith('vncClipboard.readText', {
      leaseId: expect.any(String),
    })
    expect(screen.getByTestId('vnc-viewer-clipboard-notice')).toHaveTextContent(
      'workbench.device_desktop_clipboard_synced'
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

  test('handles a real paste event and Ctrl Alt Del controls', async () => {
    render(<VncViewer websocketUrl="ws://127.0.0.1/session/websockify?token=secret" />)
    const rfb = rfbState.instances[0]
    await waitFor(() =>
      expect(invokeDesktopHostMock).toHaveBeenCalledWith('vncClipboard.activate', {
        leaseId: expect.any(String),
      })
    )

    fireEvent.paste(screen.getByTestId('vnc-viewer'), {
      clipboardData: {
        getData: (type: string) => (type === 'text/plain' ? 'keyboard paste' : ''),
      },
    })
    fireEvent.click(screen.getByTestId('vnc-viewer-ctrl-alt-del-button'))

    expect(rfb.clipboardPasteFrom).toHaveBeenCalledWith('keyboard paste')
    expect(rfb.sendCtrlAltDel).toHaveBeenCalledOnce()
  })
})
