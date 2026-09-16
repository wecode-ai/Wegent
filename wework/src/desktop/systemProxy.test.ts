import { beforeEach, describe, expect, test, vi } from 'vitest'
import { saveLocalProxyUrl } from '@/features/model-settings/localProxySettings'
import {
  getEffectiveLocalCodexProxyUrl,
  resetSystemProxyStateForTests,
  resolveEffectiveLocalCodexProxy,
  resolveLocalCodexProxyUrl,
} from './systemProxy'

describe('resolveLocalCodexProxyUrl', () => {
  beforeEach(() => {
    localStorage.clear()
    delete window.weworkElectronNetwork
    resetSystemProxyStateForTests()
  })

  test('prefers the proxy configured in Wework', async () => {
    saveLocalProxyUrl('http://127.0.0.1:7890')
    const resolveCodexProxy = vi.fn().mockResolvedValue('http://system-proxy:8080')
    window.weworkElectronNetwork = { resolveCodexProxy }

    await expect(resolveEffectiveLocalCodexProxy()).resolves.toEqual({
      proxyUrl: 'http://127.0.0.1:7890',
      source: 'wework',
    })
    expect(resolveCodexProxy).not.toHaveBeenCalled()
  })

  test('uses the Electron system proxy when Wework has no explicit proxy', async () => {
    window.weworkElectronNetwork = {
      resolveCodexProxy: vi.fn().mockResolvedValue('http://system-proxy:8080'),
    }

    await expect(resolveEffectiveLocalCodexProxy()).resolves.toEqual({
      proxyUrl: 'http://system-proxy:8080',
      source: 'system',
    })
  })

  test('uses a direct connection when Electron resolves no system proxy', async () => {
    window.weworkElectronNetwork = {
      resolveCodexProxy: vi.fn().mockResolvedValue(null),
    }

    await expect(resolveEffectiveLocalCodexProxy()).resolves.toEqual({
      proxyUrl: null,
      source: 'direct',
    })
  })

  test('keeps the URL-only API for Codex runtime configuration', async () => {
    window.weworkElectronNetwork = {
      resolveCodexProxy: vi.fn().mockResolvedValue('socks5://127.0.0.1:1080'),
    }

    await expect(resolveLocalCodexProxyUrl()).resolves.toBe('socks5://127.0.0.1:1080')
  })

  test('reuses the resolved system proxy for local runtime requests', async () => {
    window.weworkElectronNetwork = {
      resolveCodexProxy: vi.fn().mockResolvedValue('http://system-proxy:8080'),
    }

    expect(getEffectiveLocalCodexProxyUrl()).toBe('')

    await resolveEffectiveLocalCodexProxy()

    expect(getEffectiveLocalCodexProxyUrl()).toBe('http://system-proxy:8080')
  })

  test('lets an explicit Wework proxy override the resolved system proxy', async () => {
    window.weworkElectronNetwork = {
      resolveCodexProxy: vi.fn().mockResolvedValue('http://system-proxy:8080'),
    }
    await resolveEffectiveLocalCodexProxy()

    saveLocalProxyUrl('http://127.0.0.1:7890')

    expect(getEffectiveLocalCodexProxyUrl()).toBe('http://127.0.0.1:7890')
  })
})
