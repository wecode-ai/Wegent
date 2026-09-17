import { describe, expect, test } from 'vitest'

import { isTrustedVncSurfaceAttachment } from './vnc-surface-security.js'

const ALLOWED_ORIGIN = 'http://127.0.0.1:1420'
const DSH_URL = `${ALLOWED_ORIGIN}/`

describe('VNC surface security', () => {
  test.each([
    '/device-desktop?deviceId=device-1&vncSurface=isolated',
    '/wework/app/device-desktop?deviceId=device-1&vncSurface=isolated',
  ])('accepts the internal device desktop child route at %s', path => {
    expect(
      isTrustedVncSurfaceAttachment(
        {
          partition: 'wework-vnc-surface-route:test-surface',
          src: `${ALLOWED_ORIGIN}${path}`,
        },
        DSH_URL
      )
    ).toBe(true)
  })

  test.each([
    {
      name: 'missing route partition',
      params: {
        src: `${ALLOWED_ORIGIN}/wework/app/device-desktop?deviceId=device-1&vncSurface=isolated`,
      },
    },
    {
      name: 'external origin',
      params: {
        partition: 'wework-vnc-surface-route:test-surface',
        src: 'https://example.com/wework/app/device-desktop?deviceId=device-1&vncSurface=isolated',
      },
    },
    {
      name: 'unexpected route',
      params: {
        partition: 'wework-vnc-surface-route:test-surface',
        src: `${ALLOWED_ORIGIN}/wework/app/settings?deviceId=device-1&vncSurface=isolated`,
      },
    },
    {
      name: 'unexpected development route',
      params: {
        partition: 'wework-vnc-surface-route:test-surface',
        src: `${ALLOWED_ORIGIN}/settings?deviceId=device-1&vncSurface=isolated`,
      },
    },
    {
      name: 'missing device',
      params: {
        partition: 'wework-vnc-surface-route:test-surface',
        src: `${ALLOWED_ORIGIN}/wework/app/device-desktop?vncSurface=isolated`,
      },
    },
    {
      name: 'unexpected query parameter',
      params: {
        partition: 'wework-vnc-surface-route:test-surface',
        src: `${ALLOWED_ORIGIN}/wework/app/device-desktop?deviceId=device-1&vncSurface=isolated&token=secret`,
      },
    },
  ])('rejects $name', ({ params }) => {
    expect(isTrustedVncSurfaceAttachment(params, DSH_URL)).toBe(false)
  })
})
