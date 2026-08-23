import { describe, expect, test, vi } from 'vitest'
import type { WebContents } from 'electron'
import { captureWebContentsDataUrl } from './electron-capabilities.js'

function createWebContents(input: {
  captureDataUrl?: string
  captureEmpty?: boolean
  debuggerData?: string
}) {
  let debuggerAttached = false
  const debuggerSession = {
    attach: vi.fn(() => {
      debuggerAttached = true
    }),
    detach: vi.fn(() => {
      debuggerAttached = false
    }),
    isAttached: vi.fn(() => debuggerAttached),
    sendCommand: vi.fn(async () => ({ data: input.debuggerData })),
  }
  const contents = {
    capturePage: vi.fn(async () => ({
      isEmpty: () => input.captureEmpty ?? false,
      toDataURL: () => input.captureDataUrl ?? '',
    })),
    debugger: debuggerSession,
  } as unknown as WebContents
  return { contents, debuggerSession }
}

describe('captureWebContentsDataUrl', () => {
  test('uses Electron native capturePage for the visible composed surface', async () => {
    const { contents, debuggerSession } = createWebContents({
      captureDataUrl: 'data:image/png;base64,native-capture',
    })

    await expect(captureWebContentsDataUrl(contents)).resolves.toBe(
      'data:image/png;base64,native-capture'
    )
    expect(debuggerSession.attach).not.toHaveBeenCalled()
    expect(debuggerSession.sendCommand).not.toHaveBeenCalled()
  })

  test('falls back to the debugger when capturePage returns an empty image', async () => {
    const { contents, debuggerSession } = createWebContents({
      captureEmpty: true,
      debuggerData: 'debugger-capture',
    })

    await expect(captureWebContentsDataUrl(contents)).resolves.toBe(
      'data:image/png;base64,debugger-capture'
    )
    expect(debuggerSession.attach).toHaveBeenCalledOnce()
    expect(debuggerSession.detach).toHaveBeenCalledOnce()
  })
})
