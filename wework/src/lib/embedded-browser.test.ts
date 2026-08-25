import { beforeEach, describe, expect, test, vi } from 'vitest'
import {
  browserDiagnosticUrl,
  clearEmbeddedBrowserData,
  closeEmbeddedBrowser,
  evalEmbeddedBrowserJson,
  listenEmbeddedBrowserAgentState,
  listenEmbeddedBrowserOpenRequests,
  listenEmbeddedBrowserPageStateChanges,
  relabelEmbeddedBrowser,
  resolveEmbeddedBrowserAgentApproval,
  requestEmbeddedBrowserOpen,
  setEmbeddedBrowserAgentControlPaused,
} from './embedded-browser'

const desktopHostMocks = vi.hoisted(() => ({
  invoke: vi.fn(),
}))

vi.mock('@/api/dsh/desktopHost', () => ({
  invokeDesktopHost: desktopHostMocks.invoke,
}))

vi.mock('./runtime-environment', () => ({
  isElectronRuntime: vi.fn(() => true),
}))

describe('embedded-browser', () => {
  beforeEach(() => {
    vi.useRealTimers()
    desktopHostMocks.invoke.mockReset()
    desktopHostMocks.invoke.mockResolvedValue({
      events: [],
      latestSequence: 0,
      historyLost: false,
    })
  })

  test('removes query strings and fragments from diagnostic URLs', () => {
    expect(browserDiagnosticUrl('https://example.test/path?token=secret#details')).toBe(
      'https://example.test/path'
    )
    expect(browserDiagnosticUrl('file:///Users/me/report.html?token=secret#details')).toBe(
      'file:///Users/me/report.html'
    )
    expect(browserDiagnosticUrl('not a URL')).toBe('<invalid-url>')
  })

  test('evaluates JSON through the Electron browser capability', async () => {
    desktopHostMocks.invoke.mockResolvedValue([{ comment: 'Check this area' }])

    await expect(evalEmbeddedBrowserJson('window.consume()')).resolves.toEqual([
      { comment: 'Check this area' },
    ])
    expect(desktopHostMocks.invoke).toHaveBeenCalledWith('browser.evaluate', {
      label: 'workspace-browser',
      expression: 'window.consume()',
    })
  })

  test('relabels an embedded browser through Electron', async () => {
    await relabelEmbeddedBrowser('workspace-browser-blank-0', 'workspace-browser-task-1')

    expect(desktopHostMocks.invoke).toHaveBeenCalledWith('browser.relabel', {
      fromLabel: 'workspace-browser-blank-0',
      toLabel: 'workspace-browser-task-1',
    })
  })

  test('closes only the expected native browser identity', async () => {
    await closeEmbeddedBrowser('workspace-browser-task-1', 'embedded-browser-native-7')

    expect(desktopHostMocks.invoke).toHaveBeenCalledWith('browser.close', {
      expectedNativeLabel: 'embedded-browser-native-7',
      label: 'workspace-browser-task-1',
    })
  })

  test('clears selected embedded browser data through Electron', async () => {
    desktopHostMocks.invoke.mockResolvedValue(1)

    await expect(clearEmbeddedBrowserData(['cookies'])).resolves.toBe(1)

    expect(desktopHostMocks.invoke).toHaveBeenCalledWith('browser.clearData', {
      dataKinds: ['cookies'],
    })
  })

  test('preserves the full-clear call when no data kinds are provided', async () => {
    desktopHostMocks.invoke.mockResolvedValue(0)

    await clearEmbeddedBrowserData()

    expect(desktopHostMocks.invoke).toHaveBeenCalledWith('browser.clearData', {
      dataKinds: null,
    })
  })

  test('pauses agent control through Electron', async () => {
    await setEmbeddedBrowserAgentControlPaused(true, 'workspace-browser-task-1')

    expect(desktopHostMocks.invoke).toHaveBeenCalledWith('browser.setAgentControlPaused', {
      label: 'workspace-browser-task-1',
      paused: true,
    })
  })

  test('resolves agent approval through Electron', async () => {
    await resolveEmbeddedBrowserAgentApproval(
      'browser-approval-1',
      true,
      'workspace-browser-task-1'
    )

    expect(desktopHostMocks.invoke).toHaveBeenCalledWith('browser.resolveAgentApproval', {
      label: 'workspace-browser-task-1',
      approvalId: 'browser-approval-1',
      approved: true,
    })
  })

  test('listens for embedded browser agent state events', async () => {
    const handler = vi.fn()

    const unlisten = await listenEmbeddedBrowserAgentState(handler)
    await vi.waitFor(() =>
      expect(desktopHostMocks.invoke).toHaveBeenCalledWith('browser.events', { after: 0 })
    )
    unlisten?.()
  })

  test('listens for embedded browser page state changes', async () => {
    const handler = vi.fn()

    const unlisten = await listenEmbeddedBrowserPageStateChanges(handler)
    await vi.waitFor(() =>
      expect(desktopHostMocks.invoke).toHaveBeenCalledWith('browser.events', { after: 0 })
    )
    unlisten?.()
  })

  test('routes frontend open requests to the active embedded browser listener', async () => {
    const handler = vi.fn()
    const unlisten = listenEmbeddedBrowserOpenRequests(handler)

    expect(requestEmbeddedBrowserOpen('http://localhost:3000')).toBe(true)
    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({
        id: expect.any(String),
        baseLabel: 'workspace-browser',
        disposition: 'new-tab',
        label: 'workspace-browser',
        source: 'user',
        url: 'http://localhost:3000/',
      })
    )
    expect(requestEmbeddedBrowserOpen('asset://localhost/Users/me/workspace/trend.html')).toBe(true)
    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({
        baseLabel: 'workspace-browser',
        disposition: 'new-tab',
        label: 'workspace-browser',
        source: 'user',
        url: 'asset://localhost/Users/me/workspace/trend.html',
      })
    )
    expect(requestEmbeddedBrowserOpen('file:///Users/me/workspace/report.html')).toBe(true)
    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({
        baseLabel: 'workspace-browser',
        disposition: 'new-tab',
        label: 'workspace-browser',
        source: 'user',
        url: 'file:///Users/me/workspace/report.html',
      })
    )
    expect(requestEmbeddedBrowserOpen('/Users/me/workspace/report.html')).toBe(true)
    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({
        baseLabel: 'workspace-browser',
        disposition: 'new-tab',
        label: 'workspace-browser',
        source: 'user',
        url: 'file:///Users/me/workspace/report.html',
      })
    )
    expect(requestEmbeddedBrowserOpen('ftp://localhost/resource')).toBe(false)
    expect(handler).toHaveBeenCalledTimes(4)

    const release = await unlisten
    release?.()
  })

  test('dispatches Electron open request events', async () => {
    desktopHostMocks.invoke.mockResolvedValue({
      events: [
        {
          sequence: 1,
          type: 'open-request',
          payload: {
            id: 'agent-open-42',
            baseLabel: 'workspace-browser-task-1',
            source: 'agent',
            disposition: 'current-tab',
            targetLabel: 'workspace-browser-task-1',
            label: 'workspace-browser-task-1',
            url: 'https://example.test/',
          },
        },
      ],
      latestSequence: 1,
      historyLost: false,
    })
    const handler = vi.fn()

    const unlisten = listenEmbeddedBrowserOpenRequests(handler)

    await vi.waitFor(() => {
      expect(handler).toHaveBeenCalledWith({
        id: 'agent-open-42',
        baseLabel: 'workspace-browser-task-1',
        source: 'agent',
        disposition: 'current-tab',
        targetLabel: 'workspace-browser-task-1',
        label: 'workspace-browser-task-1',
        url: 'https://example.test/',
      })
    })
    expect(desktopHostMocks.invoke).toHaveBeenCalledWith('browser.events', { after: 0 })

    const release = await unlisten
    release?.()
  })
})
