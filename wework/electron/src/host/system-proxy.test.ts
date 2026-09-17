import { describe, expect, test, vi } from 'vitest'
import { proxyRulesToUrl, resolveSystemProxy } from './system-proxy.js'

describe('resolveSystemProxy', () => {
  test('passes the actual target URL to Chromium PAC resolution', async () => {
    const session = {
      resolveProxy: vi.fn(async (url: string) =>
        new URL(url).hostname === 'chatgpt.com' ? 'PROXY external.example:3128' : 'DIRECT'
      ),
    }
    await expect(
      resolveSystemProxy(session, 'https://chatgpt.com/backend-api/codex')
    ).resolves.toBe('http://external.example:3128')
    const internalUrl = 'https://wegent.example/api/runtime-work/llm-responses-proxy/responses'
    await expect(resolveSystemProxy(session, internalUrl)).resolves.toBeNull()
    expect(session.resolveProxy).toHaveBeenLastCalledWith(internalUrl)
  })

  test('rejects non-HTTP targets before calling the system resolver', async () => {
    const session = { resolveProxy: vi.fn() }
    await expect(resolveSystemProxy(session, 'file:///etc/hosts')).rejects.toThrow('HTTP')
    expect(session.resolveProxy).not.toHaveBeenCalled()
  })
})

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
