import { afterEach, describe, expect, test, vi } from 'vitest'
import { getWeworkUpdateTarget } from './app-updater'

function setUserAgent(userAgent: string) {
  vi.stubGlobal('navigator', { userAgent })
}

describe('getWeworkUpdateTarget', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  test('routes stable macOS updates to the stable Darwin manifest', () => {
    setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)')

    expect(getWeworkUpdateTarget('stable')).toBe('stable-darwin')
  })

  test('routes Beta Windows updates to the Beta Windows manifest', () => {
    setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64)')

    expect(getWeworkUpdateTarget('beta')).toBe('beta-windows')
  })
})
