import { beforeEach, describe, expect, test, vi } from 'vitest'
import {
  getLocalProxyConfig,
  LOCAL_PROXY_SETTINGS_CHANGED_EVENT,
  normalizeLocalProxyUrl,
  saveLocalProxyConfig,
  saveLocalProxyUrl,
} from './localProxySettings'

describe('localProxySettings', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  test('saves and masks custom proxy config', () => {
    const listener = vi.fn()
    window.addEventListener(LOCAL_PROXY_SETTINGS_CHANGED_EVENT, listener)

    try {
      const saved = saveLocalProxyUrl(' http://user:secret@127.0.0.1:7890 ')

      expect(saved.mode).toBe('custom')
      expect(saved.proxyUrl).toBe('http://user:secret@127.0.0.1:7890')
      expect(saved.proxyUrlMasked).toBe('http://***:***@127.0.0.1:7890/')
      expect(listener).toHaveBeenCalledTimes(1)

      const cleared = saveLocalProxyUrl('')

      expect(cleared).toMatchObject({
        mode: 'system',
        proxyUrl: '',
        proxyUrlMasked: '',
      })
      expect(listener).toHaveBeenCalledTimes(2)
    } finally {
      window.removeEventListener(LOCAL_PROXY_SETTINGS_CHANGED_EVENT, listener)
    }
  })

  test('stores direct mode separately from system proxy mode', () => {
    expect(getLocalProxyConfig()).toEqual({
      mode: 'system',
      proxyUrl: '',
      proxyUrlMasked: '',
      updatedAt: null,
    })

    const direct = saveLocalProxyConfig('direct')

    expect(direct).toMatchObject({
      mode: 'direct',
      proxyUrl: '',
      proxyUrlMasked: '',
    })
    expect(direct.updatedAt).not.toBeNull()
  })

  test('migrates legacy stored proxy URLs to custom mode', () => {
    localStorage.setItem(
      'wework.local-proxy-settings',
      JSON.stringify({ proxyUrl: 'http://127.0.0.1:7890' })
    )

    expect(getLocalProxyConfig()).toMatchObject({
      mode: 'custom',
      proxyUrl: 'http://127.0.0.1:7890',
    })
  })

  test('validates supported proxy URLs', () => {
    expect(normalizeLocalProxyUrl('socks5://127.0.0.1:7890')).toBe('socks5://127.0.0.1:7890')
    expect(() => saveLocalProxyConfig('custom')).toThrow(/required/)
    expect(() => normalizeLocalProxyUrl('ftp://127.0.0.1:21')).toThrow(/scheme/)
    expect(() => normalizeLocalProxyUrl('http://127.0.0.1')).toThrow(/host and port/)
  })
})
