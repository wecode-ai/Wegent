import { mkdtemp, readFile, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test, vi } from 'vitest'
import {
  EmbeddedBrowserBridge,
  embeddedBrowserScreenshotAvailable,
} from './embedded-browser-bridge.js'
import type { EmbeddedBrowserManager } from './embedded-browser-manager.js'

const bridges: EmbeddedBrowserBridge[] = []

afterEach(async () => {
  await Promise.all(bridges.splice(0).map(bridge => bridge.stop()))
})

describe('EmbeddedBrowserBridge', () => {
  test('limits viewport screenshots to macOS', () => {
    expect(embeddedBrowserScreenshotAvailable('darwin')).toBe(true)
    expect(embeddedBrowserScreenshotAvailable('linux')).toBe(false)
    expect(embeddedBrowserScreenshotAvailable('win32')).toBe(false)
  })

  test('publishes an authenticated runtime identity and rejects invalid tokens', async () => {
    const executorHome = await mkdtemp(join(tmpdir(), 'wework-browser-bridge-'))
    const browser = fakeBrowser()
    const bridge = new EmbeddedBrowserBridge(browser.manager, executorHome)
    bridges.push(bridge)

    const runtimePath = await bridge.start()
    const identity = JSON.parse(await readFile(runtimePath, 'utf8')) as {
      schemaVersion: number
      address: string
      token: string
    }
    expect(identity).toMatchObject({
      schemaVersion: 1,
      address: expect.stringMatching(/^127\.0\.0\.1:\d+$/),
      token: expect.any(String),
    })
    expect((await stat(runtimePath)).mode & 0o777).toBe(0o600)

    const unauthorized = await fetch(`http://${identity.address}/browser`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer invalid',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ action: 'status' }),
    })
    expect(unauthorized.status).toBe(401)

    const authorized = await fetch(`http://${identity.address}/browser`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${identity.token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ action: 'status' }),
    })
    await expect(authorized.json()).resolves.toEqual({
      ok: true,
      data: { open: false, label: 'workspace-browser' },
    })
  })

  test('routes opens through the frontend request and active browser label', async () => {
    const executorHome = await mkdtemp(join(tmpdir(), 'wework-browser-bridge-'))
    const browser = fakeBrowser()
    browser.activeLabel.mockReturnValue('workspace-browser-2')
    browser.requestOpen.mockImplementation(() => {
      browser.has.mockReturnValue(true)
      browser.state.mockReturnValue({
        label: 'workspace-browser-2',
        nativeLabel: 'workspace-browser-2',
        title: null,
        url: 'about:blank',
        isLoading: false,
        navigationError: null,
      })
    })
    browser.navigate.mockImplementation(async (_label, url) => {
      browser.state.mockReturnValue({
        label: 'workspace-browser-2',
        nativeLabel: 'workspace-browser-2',
        title: null,
        url,
        isLoading: false,
        navigationError: null,
      })
    })
    const bridge = new EmbeddedBrowserBridge(browser.manager, executorHome)
    bridges.push(bridge)
    const runtimePath = await bridge.start()
    const identity = JSON.parse(await readFile(runtimePath, 'utf8')) as {
      address: string
      token: string
    }

    const response = await fetch(`http://${identity.address}/browser`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${identity.token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        action: 'open',
        label: 'workspace-browser',
        url: 'https://example.test/',
      }),
    })

    await expect(response.json()).resolves.toEqual({
      ok: true,
      data: { ok: true },
    })
    expect(browser.requestOpen).toHaveBeenCalledWith(
      expect.objectContaining({
        baseLabel: 'workspace-browser',
        targetLabel: 'workspace-browser-2',
        source: 'agent',
      })
    )
    expect(browser.navigate).toHaveBeenCalledWith('workspace-browser-2', 'https://example.test/')
  })

  test('waits for the host cursor to arrive before dispatching a click', async () => {
    const executorHome = await mkdtemp(join(tmpdir(), 'wework-browser-bridge-'))
    const browser = fakeBrowser()
    let resolveArrival: (arrived: boolean) => void = () => undefined
    const arrival = new Promise<boolean>(resolve => {
      resolveArrival = resolve
    })
    browser.evaluate.mockImplementation(async (_label, expression) => {
      if (expression.includes('"previewOnly":true')) {
        return {
          ok: true,
          target: { rect: { x: 40, y: 30, width: 120, height: 40 } },
        }
      }
      return { ok: true, action: 'click' }
    })
    browser.waitForAgentCursorArrival.mockReturnValue(arrival)
    const bridge = new EmbeddedBrowserBridge(browser.manager, executorHome)
    bridges.push(bridge)
    const runtimePath = await bridge.start()
    const identity = JSON.parse(await readFile(runtimePath, 'utf8')) as {
      address: string
      token: string
    }

    const responsePromise = fetch(`http://${identity.address}/browser`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${identity.token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        action: 'click',
        label: 'workspace-browser',
        selector: '#run-agent',
      }),
    })

    await vi.waitFor(() => {
      expect(browser.showAgentCursor).toHaveBeenCalledWith('workspace-browser', 100, 50)
    })
    expect(browser.evaluate).toHaveBeenCalledOnce()
    resolveArrival(true)

    const response = await responsePromise
    await expect(response.json()).resolves.toEqual({
      ok: true,
      data: { ok: true, action: 'click' },
    })
    expect(browser.evaluate).toHaveBeenCalledTimes(2)
    expect(browser.hideAgentCursor).not.toHaveBeenCalled()
  })

  test('does not dispatch a click when the host cursor does not arrive', async () => {
    const executorHome = await mkdtemp(join(tmpdir(), 'wework-browser-bridge-'))
    const browser = fakeBrowser()
    browser.evaluate.mockResolvedValue({
      ok: true,
      target: { rect: { x: 40, y: 30, width: 120, height: 40 } },
    })
    browser.waitForAgentCursorArrival.mockResolvedValue(false)
    const bridge = new EmbeddedBrowserBridge(browser.manager, executorHome)
    bridges.push(bridge)
    const runtimePath = await bridge.start()
    const identity = JSON.parse(await readFile(runtimePath, 'utf8')) as {
      address: string
      token: string
    }

    const response = await fetch(`http://${identity.address}/browser`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${identity.token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        action: 'click',
        label: 'workspace-browser',
        selector: '#run-agent',
      }),
    })

    await expect(response.json()).resolves.toEqual({
      ok: false,
      error: 'Timed out waiting for embedded browser agent cursor arrival',
    })
    expect(browser.evaluate).toHaveBeenCalledOnce()
  })

  test('follows an active browser label published after the open request', async () => {
    const executorHome = await mkdtemp(join(tmpdir(), 'wework-browser-bridge-'))
    const browser = fakeBrowser()
    browser.activeLabel
      .mockReturnValueOnce('workspace-browser')
      .mockReturnValue('workspace-browser-blank-0')
    browser.has.mockImplementation(label => label === 'workspace-browser-blank-0')
    browser.state.mockReturnValue({
      label: 'workspace-browser-blank-0',
      nativeLabel: 'workspace-browser-blank-0',
      title: null,
      url: 'about:blank',
      isLoading: false,
      navigationError: null,
    })
    const bridge = new EmbeddedBrowserBridge(browser.manager, executorHome)
    bridges.push(bridge)
    const runtimePath = await bridge.start()
    const identity = JSON.parse(await readFile(runtimePath, 'utf8')) as {
      address: string
      token: string
    }

    const response = await fetch(`http://${identity.address}/browser`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${identity.token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        action: 'open',
        label: 'workspace-browser',
        url: 'https://example.test/',
      }),
    })

    await expect(response.json()).resolves.toEqual({
      ok: true,
      data: { ok: true },
    })
    expect(browser.requestOpen).toHaveBeenCalledWith(
      expect.objectContaining({
        baseLabel: 'workspace-browser',
        targetLabel: 'workspace-browser',
        source: 'agent',
      })
    )
    expect(browser.navigate).toHaveBeenCalledWith(
      'workspace-browser-blank-0',
      'https://example.test/'
    )
  })

  test('accepts the final page URL after navigation redirects', async () => {
    const executorHome = await mkdtemp(join(tmpdir(), 'wework-browser-bridge-'))
    const browser = fakeBrowser()
    browser.has.mockReturnValue(true)
    browser.state.mockReturnValue({
      label: 'workspace-browser',
      nativeLabel: 'workspace-browser',
      title: 'Fixture',
      url: 'https://example.test/fixture',
      isLoading: false,
      navigationError: null,
    })
    const bridge = new EmbeddedBrowserBridge(browser.manager, executorHome)
    bridges.push(bridge)
    const runtimePath = await bridge.start()
    const identity = JSON.parse(await readFile(runtimePath, 'utf8')) as {
      address: string
      token: string
    }

    const response = await fetch(`http://${identity.address}/browser`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${identity.token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        action: 'open',
        url: 'https://example.test/redirect',
      }),
    })

    await expect(response.json()).resolves.toEqual({
      ok: true,
      data: { ok: true },
    })
    expect(browser.navigate).toHaveBeenCalledWith(
      'workspace-browser',
      'https://example.test/redirect'
    )
  })

  test('waits for a browser that is remounting before evaluating its condition', async () => {
    const executorHome = await mkdtemp(join(tmpdir(), 'wework-browser-bridge-'))
    const browser = fakeBrowser()
    browser.has.mockReturnValue(false)
    browser.evaluate.mockImplementation(async () => {
      if (!browser.has()) {
        throw new Error('Embedded browser is unavailable: workspace-browser')
      }
      return { ok: true, kind: 'browser.wait' }
    })
    const bridge = new EmbeddedBrowserBridge(browser.manager, executorHome)
    bridges.push(bridge)
    const runtimePath = await bridge.start()
    const identity = JSON.parse(await readFile(runtimePath, 'utf8')) as {
      address: string
      token: string
    }
    setTimeout(() => browser.has.mockReturnValue(true), 25)

    const response = await fetch(`http://${identity.address}/browser`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${identity.token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        action: 'waitFor',
        text: 'Browser data cache fixture',
        timeoutMs: 1_000,
        options: { pollMs: 50 },
      }),
    })

    await expect(response.json()).resolves.toEqual({
      ok: true,
      data: { ok: true, kind: 'browser.wait' },
    })
    expect(browser.evaluate).toHaveBeenCalledOnce()
  })

  test('routes native clicks through Electron input events', async () => {
    const executorHome = await mkdtemp(join(tmpdir(), 'wework-browser-bridge-'))
    const browser = fakeBrowser()
    browser.has.mockReturnValue(true)
    const bridge = new EmbeddedBrowserBridge(browser.manager, executorHome)
    bridges.push(bridge)
    const runtimePath = await bridge.start()
    const identity = JSON.parse(await readFile(runtimePath, 'utf8')) as {
      address: string
      token: string
    }

    const response = await fetch(`http://${identity.address}/browser`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${identity.token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        action: 'nativeClick',
        x: 120.4,
        y: 48.6,
      }),
    })

    await expect(response.json()).resolves.toEqual({
      ok: true,
      data: {
        ok: true,
        kind: 'browser.action',
        action: 'click',
        backend: 'electron-send-input-event',
        executionKind: 'trusted-event',
        synthetic: false,
      },
    })
    expect(browser.clickAt).toHaveBeenCalledWith('workspace-browser', 120.4, 48.6)
  })
})

function fakeBrowser() {
  const activeLabel = vi.fn((label: string) => label)
  const has = vi.fn(() => false)
  const requestOpen = vi.fn()
  const state = vi.fn(() => ({
    label: 'workspace-browser',
    nativeLabel: 'workspace-browser',
    title: null,
    url: null,
    isLoading: false,
    navigationError: null,
  }))
  const navigate = vi.fn(async () => undefined)
  const evaluate = vi.fn()
  const clickAt = vi.fn()
  const hideAgentCursor = vi.fn()
  const showAgentCursor = vi.fn(() => 1)
  const waitForAgentCursorArrival = vi.fn(async () => true)
  const manager = {
    activeLabel,
    has,
    requestOpen,
    state,
    navigate,
    reload: vi.fn(),
    requestClose: vi.fn(),
    goBack: vi.fn(),
    goForward: vi.fn(),
    evaluate,
    clickAt,
    isAgentControlPaused: vi.fn(() => false),
    consumeApprovedAgentRisk: vi.fn(() => false),
    registerAgentApproval: vi.fn(() => null),
    emitAgentState: vi.fn(),
    hideAgentCursor,
    showAgentCursor,
    waitForAgentCursorArrival,
  } as unknown as EmbeddedBrowserManager
  return {
    activeLabel,
    clickAt,
    evaluate,
    has,
    hideAgentCursor,
    manager,
    navigate,
    requestOpen,
    showAgentCursor,
    state,
    waitForAgentCursorArrival,
  }
}
