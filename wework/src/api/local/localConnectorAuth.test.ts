import { beforeEach, describe, expect, test, vi } from 'vitest'
import {
  clearLocalConnectorAuthHealthCache,
  isLocalBrowserConnector,
  isLocalConnector,
  isLocalQrConnector,
  localConnectorAuthHealth,
  localQrManageActionFromHealth,
} from './localConnectorAuth'

const mocks = vi.hoisted(() => ({
  ensureLocalExecutorStarted: vi.fn(),
  requestLocalExecutor: vi.fn(),
}))

vi.mock('@/tauri/localExecutor', () => ({
  ensureLocalExecutorStarted: () => mocks.ensureLocalExecutorStarted(),
  requestLocalExecutor: (...args: unknown[]) => mocks.requestLocalExecutor(...args),
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
