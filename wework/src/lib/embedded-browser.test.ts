import { beforeEach, describe, expect, test, vi } from 'vitest'
import { invoke } from '@tauri-apps/api/core'
import {
  EMBEDDED_BROWSER_AGENT_STATE_EVENT,
  EMBEDDED_BROWSER_PAGE_STATE_CHANGE_EVENT,
  clearEmbeddedBrowserData,
  evalEmbeddedBrowserJson,
  listenEmbeddedBrowserAgentState,
  listenEmbeddedBrowserOpenRequests,
  listenEmbeddedBrowserPageStateChanges,
  relabelEmbeddedBrowser,
  resolveEmbeddedBrowserAgentApproval,
  requestEmbeddedBrowserOpen,
  setEmbeddedBrowserAgentControlPaused,
} from './embedded-browser'

const eventMocks = vi.hoisted(() => {
  const unlisten = vi.fn()
  return {
    listen: vi.fn().mockResolvedValue(unlisten),
    unlisten,
  }
})

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
}))

vi.mock('@tauri-apps/api/event', () => ({
  listen: eventMocks.listen,
}))

vi.mock('./runtime-environment', () => ({
  isTauriRuntime: vi.fn(() => true),
}))

const invokeMock = vi.mocked(invoke)

describe('embedded-browser', () => {
  beforeEach(() => {
    invokeMock.mockReset()
    eventMocks.listen.mockClear()
  })

  test('unwraps successful eval result values', async () => {
    invokeMock.mockResolvedValue({
      ok: true,
      value: [{ comment: 'Check this area' }],
    })

    await expect(evalEmbeddedBrowserJson('window.consume()')).resolves.toEqual([
      { comment: 'Check this area' },
    ])
  })

  test('keeps direct eval values for compatibility', async () => {
    invokeMock.mockResolvedValue([{ comment: 'Direct value' }])

    await expect(evalEmbeddedBrowserJson('window.consume()')).resolves.toEqual([
      { comment: 'Direct value' },
    ])
  })

  test('throws failed eval result errors', async () => {
    invokeMock.mockResolvedValue({
      ok: false,
      error: 'Evaluation failed',
    })

    await expect(evalEmbeddedBrowserJson('window.consume()')).rejects.toThrow('Evaluation failed')
  })

  test('relabels an embedded browser through Tauri', async () => {
    invokeMock.mockResolvedValue(undefined)

    await relabelEmbeddedBrowser('workspace-browser-blank-0', 'workspace-browser-task-1')

    expect(invokeMock).toHaveBeenCalledWith('embedded_browser_relabel', {
      fromLabel: 'workspace-browser-blank-0',
      toLabel: 'workspace-browser-task-1',
    })
  })

  test('clears selected embedded browser data through Tauri', async () => {
    invokeMock.mockResolvedValue(1)

    await expect(clearEmbeddedBrowserData(['cookies'])).resolves.toBe(1)

    expect(invokeMock).toHaveBeenCalledWith('embedded_browser_clear_data', {
      dataKinds: ['cookies'],
    })
  })

  test('preserves the full-clear call when no data kinds are provided', async () => {
    invokeMock.mockResolvedValue(0)

    await clearEmbeddedBrowserData()

    expect(invokeMock).toHaveBeenCalledWith('embedded_browser_clear_data', {
      dataKinds: null,
    })
  })

  test('pauses agent control through Tauri', async () => {
    invokeMock.mockResolvedValue(undefined)

    await setEmbeddedBrowserAgentControlPaused(true, 'workspace-browser-task-1')

    expect(invokeMock).toHaveBeenCalledWith('embedded_browser_set_agent_control_paused', {
      label: 'workspace-browser-task-1',
      paused: true,
    })
  })

  test('resolves agent approval through Tauri', async () => {
    invokeMock.mockResolvedValue(undefined)

    await resolveEmbeddedBrowserAgentApproval(
      'browser-approval-1',
      true,
      'workspace-browser-task-1'
    )

    expect(invokeMock).toHaveBeenCalledWith('embedded_browser_resolve_agent_approval', {
      label: 'workspace-browser-task-1',
      approvalId: 'browser-approval-1',
      approved: true,
    })
  })

  test('listens for embedded browser agent state events', async () => {
    const handler = vi.fn()

    await listenEmbeddedBrowserAgentState(handler)

    expect(eventMocks.listen).toHaveBeenCalledWith(
      EMBEDDED_BROWSER_AGENT_STATE_EVENT,
      expect.any(Function)
    )
  })

  test('listens for embedded browser page state changes', async () => {
    const handler = vi.fn()

    await listenEmbeddedBrowserPageStateChanges(handler)

    expect(eventMocks.listen).toHaveBeenCalledWith(
      EMBEDDED_BROWSER_PAGE_STATE_CHANGE_EVENT,
      expect.any(Function)
    )
  })

  test('routes frontend open requests to the active embedded browser listener', async () => {
    const handler = vi.fn()
    const unlisten = listenEmbeddedBrowserOpenRequests(handler)

    expect(requestEmbeddedBrowserOpen('http://localhost:3000')).toBe(true)
    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({
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
})
