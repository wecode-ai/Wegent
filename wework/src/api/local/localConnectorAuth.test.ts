import { describe, expect, test } from 'vitest'
import {
  isLocalBrowserConnector,
  isLocalConnector,
  isLocalQrConnector,
  localQrManageActionFromHealth,
} from './localConnectorAuth'

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
