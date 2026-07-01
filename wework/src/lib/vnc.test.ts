import { afterEach, describe, expect, test } from 'vitest'

import { buildVncPageUrl } from './vnc'

describe('buildVncPageUrl', () => {
  afterEach(() => {
    localStorage.clear()
  })

  test('uses the configured app base path for the VNC page', () => {
    window.__WEWORK_RUNTIME_CONFIG__ = {
      ...window.__WEWORK_RUNTIME_CONFIG__,
      appBasePath: '/wework',
    }
    localStorage.setItem('auth_token', 'token value')

    const url = buildVncPageUrl('device/1', 'sandbox-1')
    const parsedUrl = new URL(url)

    expect(parsedUrl.pathname).toBe('/wework/vnc.html')
    expect(parsedUrl.searchParams.get('sandboxId')).toBe('sandbox-1')
    expect(parsedUrl.searchParams.get('wsUrl')).toBe(
      'ws://localhost:3000/api/cloud-devices/device%2F1/vnc-ws?token=token%20value'
    )
  })
})
