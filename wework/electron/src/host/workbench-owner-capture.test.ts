import { beforeEach, describe, expect, test, vi } from 'vitest'
import type { BrowserWindow, WebContents } from 'electron'
import { createWorkbenchCapabilityRouter, WEWORK_APP_PRINCIPAL } from './electron-capabilities.js'
import { captureWebContentsDataUrl } from './web-contents-capture.js'

vi.mock('electron', () => ({
  app: { once: vi.fn(), getPath: () => '/tmp', getVersion: () => '0.0.0-test' },
  BrowserWindow: class {},
  clipboard: {},
  dialog: {},
  Notification: class {},
  powerMonitor: {},
  protocol: { handle: vi.fn(), unhandle: vi.fn() },
  shell: {},
}))
vi.mock('./web-contents-capture.js', () => ({ captureWebContentsDataUrl: vi.fn() }))

const owner = 'smart-app:host-capture'
const rect = { x: 0, y: 0, width: 128, height: 96 }

function fixture() {
  const state = {
    visible: true,
    windowVisible: true,
    windowDestroyed: false,
    contentsDestroyed: false,
  }
  const contents = { isDestroyed: () => state.contentsDestroyed } as WebContents
  const window = {
    isDestroyed: () => state.windowDestroyed,
    isVisible: () => state.windowVisible,
  } as BrowserWindow
  const services = {
    invoke: vi.fn(async () => undefined),
    window: vi.fn((): BrowserWindow | null => window),
    contents: vi.fn((): WebContents | null => contents),
    visible: () => state.visible,
  }
  const browser = {
    has: vi.fn(() => true),
    state: vi.fn(() => ({ visible: true })),
    capture: vi.fn(async () => 'data:image/png;base64,legacy'),
  }
  const router = createWorkbenchCapabilityRouter(browser as never, owner, services)
  return {
    state,
    contents,
    services,
    browser,
    router,
    capabilities: () => router.invoke(owner, 'dshCapture.capabilities', {}),
    capture: (params = rect) => router.invoke(owner, 'dshCapture.ownerRect', params),
  }
}

beforeEach(() => {
  vi.mocked(captureWebContentsDataUrl).mockReset()
  vi.mocked(captureWebContentsDataUrl).mockResolvedValue('data:image/png;base64,host')
})

describe('Host-owned workbench capture', () => {
  test('captures the Host contents and normalizes the rectangle without accepting a caller target', async () => {
    const { router, contents, browser, capabilities } = fixture()
    await expect(capabilities()).resolves.toEqual({ available: true })
    await expect(
      router.invoke(owner, 'dshCapture.ownerRect', {
        x: 12.4,
        y: 24.2,
        width: 320.1,
        height: 180.8,
        label: 'smart-app:another',
      })
    ).resolves.toEqual({ dataUrl: 'data:image/png;base64,host' })
    expect(captureWebContentsDataUrl).toHaveBeenCalledWith(contents, {
      rect: { x: 12, y: 24, width: 321, height: 181 },
      preferDebugger: true,
    })
    expect(browser.has).not.toHaveBeenCalled()
    expect(browser.state).not.toHaveBeenCalled()
    expect(browser.capture).not.toHaveBeenCalled()
  })

  test('keeps hidden Host ownership authoritative even when a legacy browser is visible', async () => {
    const { state, browser, capture, capabilities } = fixture()
    state.visible = false
    await expect(capabilities()).resolves.toEqual({ available: false })
    await expect(capture()).rejects.toMatchObject({ code: 'owner_view_hidden' })
    expect(captureWebContentsDataUrl).not.toHaveBeenCalled()
    expect(browser.has).not.toHaveBeenCalled()
    expect(browser.state).not.toHaveBeenCalled()
    expect(browser.capture).not.toHaveBeenCalled()
  })

  test('recovers the same Host contents after visibility is restored', async () => {
    const { state, capture, capabilities, contents, browser } = fixture()
    await capture()
    state.visible = false
    await expect(capabilities()).resolves.toEqual({ available: false })
    await expect(capture()).rejects.toMatchObject({ code: 'owner_view_hidden' })
    state.visible = true
    await expect(capabilities()).resolves.toEqual({ available: true })
    await expect(capture()).resolves.toEqual({ dataUrl: 'data:image/png;base64,host' })
    expect(captureWebContentsDataUrl).toHaveBeenCalledTimes(2)
    expect(captureWebContentsDataUrl).toHaveBeenLastCalledWith(contents, {
      rect,
      preferDebugger: true,
    })
    expect(browser.capture).not.toHaveBeenCalled()
  })

  test('reports a hidden Host owner when no legacy browser exists', async () => {
    const { state, services } = fixture()
    state.visible = false
    const router = createWorkbenchCapabilityRouter(null, owner, services)
    await expect(router.invoke(owner, 'dshCapture.ownerRect', rect)).rejects.toMatchObject({
      code: 'owner_view_hidden',
    })
    expect(captureWebContentsDataUrl).not.toHaveBeenCalled()
  })

  test.each([
    { ...rect, x: -1 },
    { ...rect, y: Number.NaN },
    { ...rect, width: 0 },
    { ...rect, width: 7681 },
  ])('rejects an invalid rectangle before capture: %j', async invalid => {
    const { capture, browser } = fixture()
    await expect(capture(invalid)).rejects.toMatchObject({ code: 'invalid_params' })
    expect(captureWebContentsDataUrl).not.toHaveBeenCalled()
    expect(browser.capture).not.toHaveBeenCalled()
  })

  test.each(['window', 'contents', 'windowDestroyed', 'contentsDestroyed'] as const)(
    'does not fall through to a legacy browser when Host %s is unavailable',
    async unavailable => {
      const { state, services, capture, browser } = fixture()
      if (unavailable === 'window' || unavailable === 'contents')
        services[unavailable].mockReturnValue(null)
      else state[unavailable] = true
      await expect(capture()).rejects.toMatchObject({ code: 'capability_unavailable' })
      expect(captureWebContentsDataUrl).not.toHaveBeenCalled()
      expect(browser.has).not.toHaveBeenCalled()
      expect(browser.capture).not.toHaveBeenCalled()
    }
  )

  test('rejects a window hidden after the Host visibility check', async () => {
    const { state, capture, browser } = fixture()
    state.windowVisible = false
    await expect(capture()).rejects.toMatchObject({ code: 'owner_view_hidden' })
    expect(captureWebContentsDataUrl).not.toHaveBeenCalled()
    expect(browser.capture).not.toHaveBeenCalled()
  })

  test('keeps capture and microphone diagnostics scoped to this owner', async () => {
    const { router } = fixture()
    expect(router.describe(owner)).toContain('deviceDiagnostics.microphone')
    for (const principal of [WEWORK_APP_PRINCIPAL, 'smart-app:another']) {
      expect(router.describe(principal)).toEqual([])
      await expect(router.invoke(principal, 'dshCapture.ownerRect', rect)).rejects.toMatchObject({
        code: 'capability_denied',
      })
    }
    expect(captureWebContentsDataUrl).not.toHaveBeenCalled()
  })
})
