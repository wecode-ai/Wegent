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
    evaluate: vi.fn(),
    isAgentControlPaused: vi.fn(() => false),
    consumeApprovedAgentRisk: vi.fn(() => false),
    registerAgentApproval: vi.fn(() => null),
    emitAgentState: vi.fn(),
  } as unknown as EmbeddedBrowserManager
  return {
    activeLabel,
    has,
    manager,
    navigate,
    requestOpen,
    state,
  }
}
