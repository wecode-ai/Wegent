// @vitest-environment node

import { beforeEach, describe, expect, test, vi } from 'vitest'
import {
  browserDiagnosticUrl,
  clearEmbeddedBrowserData,
  closeEmbeddedBrowser,
  evalEmbeddedBrowserJson,
  listenEmbeddedBrowserOpenRequests,
  migrateEmbeddedBrowserLabel,
  migrateEmbeddedBrowserLabelSequence,
  requestEmbeddedBrowserOpen,
  resolveEmbeddedBrowserAgentApproval,
} from './embedded-browser'

const desktopHostMocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  subscribe: vi.fn(),
}))

vi.mock('@/api/dsh/desktopHost', () => ({
  invokeDesktopHost: desktopHostMocks.invoke,
  subscribeDesktopHostEvents: desktopHostMocks.subscribe,
}))

vi.mock('./runtime-environment', () => ({
  isElectronRuntime: vi.fn(() => true),
}))

describe('embedded-browser', () => {
  beforeEach(() => {
    vi.useRealTimers()
    desktopHostMocks.invoke.mockReset()
    desktopHostMocks.subscribe.mockReset()
    desktopHostMocks.subscribe.mockReturnValue(() => {})
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

  test('waits for an opening browser before migrating its label', async () => {
    vi.useFakeTimers()
    desktopHostMocks.invoke
      .mockRejectedValueOnce(
        new Error('Embedded browser is unavailable: workspace-browser-blank-0')
      )
      .mockResolvedValueOnce(undefined)

    const migration = migrateEmbeddedBrowserLabel(
      'workspace-browser-blank-0',
      'workspace-browser-task-1',
      { waitForSource: true }
    )
    await vi.advanceTimersByTimeAsync(50)

    await expect(migration).resolves.toBeUndefined()
    expect(desktopHostMocks.invoke).toHaveBeenCalledTimes(2)
  })

  test('migrates an empty browser label without waiting for a native browser', async () => {
    desktopHostMocks.invoke.mockRejectedValueOnce(
      new Error('Embedded browser is unavailable: workspace-browser-blank-0')
    )

    await expect(
      migrateEmbeddedBrowserLabel('workspace-browser-blank-0', 'workspace-browser-task-1', {
        waitForSource: false,
      })
    ).resolves.toBeUndefined()
    expect(desktopHostMocks.invoke).toHaveBeenCalledTimes(1)
  })

  test('does not retry unrelated browser migration errors', async () => {
    desktopHostMocks.invoke.mockRejectedValueOnce(new Error('Browser label already exists'))

    await expect(
      migrateEmbeddedBrowserLabel('workspace-browser-blank-0', 'workspace-browser-task-1', {
        waitForSource: true,
      })
    ).rejects.toThrow('Browser label already exists')
    expect(desktopHostMocks.invoke).toHaveBeenCalledTimes(1)
  })

  test('reports each successful label migration before a later migration fails', async () => {
    const onMigrated = vi.fn()
    desktopHostMocks.invoke
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('Browser label already exists'))

    await expect(
      migrateEmbeddedBrowserLabelSequence(
        [
          {
            tab: 'browser-1',
            fromLabel: 'workspace-browser-blank-0',
            toLabel: 'workspace-browser-task-1',
            waitForSource: true,
          },
          {
            tab: 'browser-2',
            fromLabel: 'workspace-browser-blank-0:tab-2',
            toLabel: 'workspace-browser-task-1:tab-2',
            waitForSource: true,
          },
        ],
        { onMigrated }
      )
    ).rejects.toThrow('Browser label already exists')
    expect(onMigrated).toHaveBeenCalledOnce()
    expect(onMigrated).toHaveBeenCalledWith(
      expect.objectContaining({
        tab: 'browser-1',
        toLabel: 'workspace-browser-task-1',
      })
    )
  })

  test('closes without an identity using the host optional-string contract', async () => {
    desktopHostMocks.invoke.mockImplementationOnce(async (_command, params) => {
      if (
        params.expectedNativeLabel !== undefined &&
        typeof params.expectedNativeLabel !== 'string'
      ) {
        throw new Error('expectedNativeLabel is invalid')
      }
    })
    await expect(closeEmbeddedBrowser('workspace-browser-task-1')).resolves.toBeUndefined()
  })

  test('closes only the expected native browser identity', async () => {
    await closeEmbeddedBrowser('workspace-browser-task-1', 'embedded-browser-native-7')

    expect(desktopHostMocks.invoke).toHaveBeenCalledWith('browser.close', {
      expectedNativeLabel: 'embedded-browser-native-7',
      label: 'workspace-browser-task-1',
    })
  })

  test('preserves the full-clear call when no data kinds are provided', async () => {
    desktopHostMocks.invoke.mockResolvedValue(0)

    await clearEmbeddedBrowserData()

    expect(desktopHostMocks.invoke).toHaveBeenCalledWith('browser.clearData', {
      dataKinds: null,
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
})
