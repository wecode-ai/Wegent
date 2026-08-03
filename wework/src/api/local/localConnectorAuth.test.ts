import { describe, expect, test } from 'vitest'
import { localQrManageActionFromHealth } from './localConnectorAuth'

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
