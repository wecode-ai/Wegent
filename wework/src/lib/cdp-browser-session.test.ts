// @vitest-environment node

import { beforeEach, describe, expect, test, vi } from 'vitest'
import {
  goBackCdpBrowserSession,
  readCdpBrowserPageState,
  screenshotCdpBrowserSession,
} from './cdp-browser-session'

const localExecutorMocks = vi.hoisted(() => ({
  ensureLocalExecutorStarted: vi.fn(),
  requestLocalExecutor: vi.fn(),
}))

const runtimeMocks = vi.hoisted(() => ({
  isElectronRuntime: vi.fn(),
}))

vi.mock('@/desktop/localExecutor', () => localExecutorMocks)

vi.mock('./runtime-environment', () => runtimeMocks)

describe('CDP browser session', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    runtimeMocks.isElectronRuntime.mockReturnValue(true)
    localExecutorMocks.ensureLocalExecutorStarted.mockResolvedValue({
      running: true,
      ready: true,
      deviceId: 'local-device',
    })
    localExecutorMocks.requestLocalExecutor.mockImplementation(async (_method, params) => {
      if (params.command_key === 'browser_relay_restart') {
        return { success: true, stdout: '', stderr: '' }
      }
      return {
        success: true,
        stdout: { ok: true, data: { targetId: 'target-1' } },
        stderr: '',
      }
    })
  })

  test('uses focused browser-tool evaluation for page state and history actions', async () => {
    localExecutorMocks.requestLocalExecutor.mockImplementation(async (_method, params) => {
      if (params.command_key === 'browser_relay_restart') {
        return { success: true, stdout: '', stderr: '' }
      }
      const payload = JSON.parse(params.args[0])
      if (payload.action === 'evaluate') {
        return {
          success: true,
          stdout: {
            ok: true,
            data: {
              faviconUrl: 'https://example.com/favicon.ico',
              title: 'Example',
              url: 'https://example.com/page',
            },
          },
          stderr: '',
        }
      }
      return { success: true, stdout: { ok: true, data: {} }, stderr: '' }
    })

    const session = { targetId: 'target-1', url: 'https://example.com/' }

    await goBackCdpBrowserSession(session)
    await expect(readCdpBrowserPageState(session)).resolves.toEqual({
      faviconUrl: 'https://example.com/favicon.ico',
      title: 'Example',
      url: 'https://example.com/page',
    })

    const browserPayloads = localExecutorMocks.requestLocalExecutor.mock.calls
      .map(([, params]) => params)
      .filter(params => params.command_key === 'browser_tool')
      .map(params => JSON.parse(params.args[0]))

    expect(browserPayloads).toEqual(
      expect.arrayContaining([
        { action: 'focus', targetId: 'target-1' },
        expect.objectContaining({
          action: 'evaluate',
          expression: 'window.history.back(); true',
        }),
      ])
    )
  })

  test('captures screenshots through the focused CDP browser target', async () => {
    localExecutorMocks.requestLocalExecutor.mockImplementation(async (_method, params) => {
      if (params.command_key === 'browser_relay_restart') {
        return { success: true, stdout: '', stderr: '' }
      }
      const payload = JSON.parse(params.args[0])
      if (payload.action === 'screenshot') {
        return {
          success: true,
          stdout: {
            ok: true,
            data: { path: '/tmp/browser-skill/screenshot.jpeg', size: 1024, type: 'jpeg' },
          },
          stderr: '',
        }
      }
      return { success: true, stdout: { ok: true, data: {} }, stderr: '' }
    })

    await expect(
      screenshotCdpBrowserSession({ targetId: 'target-1', url: 'https://example.com/' })
    ).resolves.toEqual({
      path: '/tmp/browser-skill/screenshot.jpeg',
      size: 1024,
      type: 'jpeg',
    })

    const browserPayloads = localExecutorMocks.requestLocalExecutor.mock.calls
      .map(([, params]) => params)
      .filter(params => params.command_key === 'browser_tool')
      .map(params => JSON.parse(params.args[0]))

    expect(browserPayloads).toEqual(
      expect.arrayContaining([
        { action: 'focus', targetId: 'target-1' },
        { action: 'screenshot', type: 'jpeg' },
      ])
    )
  })
})
