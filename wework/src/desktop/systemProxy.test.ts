import { beforeEach, describe, expect, test, vi } from 'vitest'
import { saveLocalProxyUrl } from '@/features/model-settings/localProxySettings'
import {
  CODEX_API_URL,
  resolveEffectiveLocalCodexProxy,
  resolveLocalCodexProxyUrl,
} from './systemProxy'

describe('resolveLocalCodexProxyUrl', () => {
  beforeEach(() => {
    localStorage.clear()
    delete window.weworkElectronNetwork
  })

  test('prefers the proxy configured in Wework', async () => {
    saveLocalProxyUrl('http://127.0.0.1:7890')
    const resolveProxy = vi.fn()
    window.weworkElectronNetwork = { resolveProxy }
    await expect(resolveEffectiveLocalCodexProxy()).resolves.toEqual({
      proxyUrl: 'http://127.0.0.1:7890',
      source: 'wework',
    })
    expect(resolveProxy).not.toHaveBeenCalled()
  })

  test('resolves PAC separately for each target without reusing the ChatGPT route', async () => {
    const target = 'https://wegent.example/api/runtime-work/llm-responses-proxy/responses'
    const resolveProxy = vi.fn(async (url: string) =>
      url === CODEX_API_URL ? 'http://system-proxy:8080' : null
    )
    window.weworkElectronNetwork = { resolveProxy }
    await expect(resolveEffectiveLocalCodexProxy()).resolves.toEqual({
      proxyUrl: 'http://system-proxy:8080',
      source: 'system',
    })
    await expect(resolveEffectiveLocalCodexProxy(target)).resolves.toEqual({
      proxyUrl: null,
      source: 'direct',
    })
    expect(resolveProxy.mock.calls).toEqual([[CODEX_API_URL], [target]])
  })

  test('resolves the same target again after network changes', async () => {
    const resolveProxy = vi
      .fn()
      .mockResolvedValueOnce('http://system-proxy:8080')
      .mockResolvedValueOnce(null)
    window.weworkElectronNetwork = { resolveProxy }
    await expect(resolveLocalCodexProxyUrl()).resolves.toBe('http://system-proxy:8080')
    await expect(resolveLocalCodexProxyUrl()).resolves.toBeNull()
  })

  test('propagates PAC resolution failures instead of silently connecting directly', async () => {
    window.weworkElectronNetwork = {
      resolveProxy: vi.fn().mockRejectedValue(new Error('PAC unavailable')),
    }
    await expect(resolveLocalCodexProxyUrl()).rejects.toThrow('PAC unavailable')
  })

  test('uses direct connections without an Electron network bridge', async () => {
    await expect(resolveLocalCodexProxyUrl()).resolves.toBeNull()
  })
})
