import { beforeEach, describe, expect, test, vi } from 'vitest'
import {
  getLocalProxyConfig,
  getLocalProxyUrl,
  LOCAL_PROXY_SETTINGS_CHANGED_EVENT,
  normalizeLocalProxyUrl,
  saveLocalProxyUrl,
} from './localProxySettings'

describe('localProxySettings', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  test('saves, masks, and clears local proxy config', () => {
    const listener = vi.fn()
    window.addEventListener(LOCAL_PROXY_SETTINGS_CHANGED_EVENT, listener)

    try {
      const saved = saveLocalProxyUrl(' http://user:secret@127.0.0.1:7890 ')

      expect(saved.configured).toBe(true)
      expect(saved.proxyUrlMasked).toBe('http://***:***@127.0.0.1:7890/')
      expect(getLocalProxyUrl()).toBe('http://user:secret@127.0.0.1:7890')
      expect(listener).toHaveBeenCalledTimes(1)

      const cleared = saveLocalProxyUrl('')

      expect(cleared).toEqual({
        configured: false,
        proxyUrlMasked: '',
        updatedAt: null,
      })
      expect(getLocalProxyConfig().configured).toBe(false)
      expect(listener).toHaveBeenCalledTimes(2)
    } finally {
      window.removeEventListener(LOCAL_PROXY_SETTINGS_CHANGED_EVENT, listener)
    }
  })

  test('validates supported proxy URLs', () => {
    expect(normalizeLocalProxyUrl('socks5://127.0.0.1:7890')).toBe('socks5://127.0.0.1:7890')
    expect(() => normalizeLocalProxyUrl('ftp://127.0.0.1:21')).toThrow(/scheme/)
    expect(() => normalizeLocalProxyUrl('http://127.0.0.1')).toThrow(/host and port/)
  })
})
