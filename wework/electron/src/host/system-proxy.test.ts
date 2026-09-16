import { describe, expect, test } from 'vitest'
import { proxyRulesToUrl } from './system-proxy.js'

describe('proxyRulesToUrl', () => {
  test.each([
    ['PROXY 127.0.0.1:7890', 'http://127.0.0.1:7890'],
    ['HTTPS proxy.example.com:443', 'https://proxy.example.com:443'],
    ['SOCKS5 localhost:1080', 'socks5://localhost:1080'],
    ['SOCKS localhost:1080', 'socks5://localhost:1080'],
  ])('maps %s to a Codex proxy URL', (rules, expected) => {
    expect(proxyRulesToUrl(rules)).toBe(expected)
  })

  test('uses the first supported proxy from a fallback list', () => {
    expect(proxyRulesToUrl('SOCKS4 old.example.com:1080; PROXY 127.0.0.1:7890; DIRECT')).toBe(
      'http://127.0.0.1:7890'
    )
  })

  test.each(['DIRECT', 'DIRECT; PROXY 127.0.0.1:7890', '', 'PROXY missing-port'])(
    'does not invent a proxy for %s',
    rules => {
      expect(proxyRulesToUrl(rules)).toBeNull()
    }
  )
})
