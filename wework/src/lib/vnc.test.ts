import { afterEach, describe, expect, test } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { buildVncPageUrl } from './vnc'

describe('buildVncPageUrl', () => {
  afterEach(() => {
    localStorage.clear()
    window.__WEWORK_RUNTIME_CONFIG__ = undefined
  })

  test('keeps the VNC page local and uses the cloud WebSocket proxy', () => {
    window.__WEWORK_RUNTIME_CONFIG__ = {
      ...window.__WEWORK_RUNTIME_CONFIG__,
      appBasePath: '/wework',
    }

    const url = buildVncPageUrl({
      deviceId: 'device/1',
      sandboxId: 'sandbox-1',
      socketBaseUrl: 'https://cloud.example.com/wework/',
      token: 'cloud token',
    })
    const parsedUrl = new URL(url)

    expect(parsedUrl.origin).toBe(window.location.origin)
    expect(parsedUrl.pathname).toBe('/wework/vnc.html')
    expect(parsedUrl.searchParams.get('sandboxId')).toBe('sandbox-1')
    expect(parsedUrl.searchParams.get('wsUrl')).toBe(
      'wss://cloud.example.com/wework/vnc-proxy/device%2F1?token=cloud%20token'
    )
  })

  test('uses ws for an http cloud connection', () => {
    const url = buildVncPageUrl({
      deviceId: 'device-1',
      sandboxId: 'sandbox-1',
      socketBaseUrl: 'http://127.0.0.1:8000',
      token: 'token',
    })

    expect(new URL(url).searchParams.get('wsUrl')).toBe(
      'ws://127.0.0.1:8000/vnc-proxy/device-1?token=token'
    )
  })

  test('loads noVNC relative to the VNC page base path', () => {
    const html = readFileSync(resolve(process.cwd(), 'public/vnc.html'), 'utf8')

    expect(html).toContain('<script src="./novnc/rfb.min.js"></script>')
    expect(html).not.toContain('<script src="/novnc/rfb.min.js"></script>')
  })
})
