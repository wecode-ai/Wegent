import { beforeEach, describe, expect, test, vi } from 'vitest'
import {
  clearLocalConnectorAuthHealthCache,
  isLocalBrowserConnector,
  isLocalConnector,
  isLocalQrConnector,
  localConnectorAuthHealth,
  localConnectorAuthStart,
  localQrManageActionFromHealth,
} from './localConnectorAuth'

const mocks = vi.hoisted(() => ({
  ensureLocalExecutorStarted: vi.fn(),
  ensurePython: vi.fn(),
  requestLocalExecutor: vi.fn(),
}))

vi.mock('@/desktop/localExecutor', () => ({
  ensureLocalExecutorStarted: () => mocks.ensureLocalExecutorStarted(),
  requestLocalExecutor: (...args: unknown[]) => mocks.requestLocalExecutor(...args),
}))

vi.mock('@/desktop/executionEnvironments', () => ({
  ensurePython: () => mocks.ensurePython(),
}))

describe('localQrManageActionFromHealth', () => {
  test('returns logout when session is healthy', () => {
    expect(localQrManageActionFromHealth({ status: 'ok' })).toBe('logout')
  })

  test('returns login when session needs authorization', () => {
    expect(localQrManageActionFromHealth({ status: 'need_login' })).toBe('login')
    expect(localQrManageActionFromHealth({ status: 'need_scan' })).toBe('login')
    expect(localQrManageActionFromHealth({ status: 'waiting_scan' })).toBe('login')
    expect(localQrManageActionFromHealth({ status: 'error' })).toBe('login')
    expect(localQrManageActionFromHealth(null)).toBe('login')
    expect(localQrManageActionFromHealth(undefined)).toBe('login')
  })
})

describe('localConnectorAuthHealth cache', () => {
  beforeEach(() => {
    clearLocalConnectorAuthHealthCache()
    mocks.ensureLocalExecutorStarted.mockReset()
    mocks.ensurePython.mockReset().mockResolvedValue({ state: 'installed' })
    mocks.requestLocalExecutor.mockReset()
    mocks.ensureLocalExecutorStarted.mockResolvedValue({ deviceId: 'local-device' })
    mocks.requestLocalExecutor.mockResolvedValue({ status: 'ok' })
  })

  test('reuses a recent ok health probe without calling the executor again', async () => {
    const target = { pluginKey: 'dingtalk', connectorSlug: 'dingtalk' }
    await expect(localConnectorAuthHealth(target)).resolves.toEqual({ status: 'ok' })
    await expect(localConnectorAuthHealth(target)).resolves.toEqual({ status: 'ok' })
    expect(mocks.requestLocalExecutor).toHaveBeenCalledTimes(1)
  })

  test('bypasses a cached result while waiting for a fresh local installation', async () => {
    const target = { pluginKey: 'dingtalk', connectorSlug: 'dingtalk' }
    await localConnectorAuthHealth(target)
    await localConnectorAuthHealth(target, { bypassCache: true })

    expect(mocks.requestLocalExecutor).toHaveBeenCalledTimes(2)
  })

  test('ensures managed Python before starting Python authorization', async () => {
    const target = {
      pluginKey: 'python-connector',
      connectorSlug: 'python-connector',
      localAuth: {
        kind: 'local_qr' as const,
        health: ['python3', 'auth.py', 'health'],
        start: ['python3', 'auth.py', 'start'],
        poll: ['python3', 'auth.py', 'poll'],
      },
    }

    await localConnectorAuthStart(target)

    expect(mocks.ensurePython).toHaveBeenCalledOnce()
    expect(mocks.ensureLocalExecutorStarted).toHaveBeenCalledOnce()
    expect(mocks.ensurePython.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.ensureLocalExecutorStarted.mock.invocationCallOrder[0]
    )
  })

  test.each([
    ['shell', ['scripts/local-auth.sh', 'login']],
    ['PowerShell', ['scripts/local-auth.ps1', 'login']],
    ['native', ['bin/local-auth', 'login']],
  ])('does not block %s authorization on managed Python', async (_name, start) => {
    const target = {
      pluginKey: 'native-connector',
      connectorSlug: 'native-connector',
      localAuth: {
        kind: 'browser_oauth' as const,
        health: [start[0], 'health'],
        start,
        poll: [],
      },
    }

    await localConnectorAuthStart(target)

    expect(mocks.ensurePython).not.toHaveBeenCalled()
    expect(mocks.ensureLocalExecutorStarted).toHaveBeenCalledOnce()
  })
})

describe('local connector kinds', () => {
  test('distinguishes browser and QR authentication', () => {
    const browser = {
      localAuth: {
        kind: 'browser_oauth' as const,
        health: ['health'],
        start: ['login'],
        poll: [],
      },
    }
    const qr = {
      localAuth: {
        kind: 'local_qr' as const,
        health: ['health'],
        start: ['start'],
        poll: ['poll'],
      },
    }
    expect(isLocalConnector(browser)).toBe(true)
    expect(isLocalBrowserConnector(browser)).toBe(true)
    expect(isLocalQrConnector(browser)).toBe(false)
    expect(isLocalConnector(qr)).toBe(true)
    expect(isLocalQrConnector(qr)).toBe(true)
  })
})
