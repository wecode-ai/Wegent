import { describe, expect, test, vi } from 'vitest'
import { resolveExecutionRequestProxy, resolveRuntimeModelProxy } from './runtimeModelProxy'

describe('runtime model PAC routing', () => {
  test('resolves the actual request path and independent vision route', async () => {
    const resolveProxy = vi.fn(async (url: string) =>
      new URL(url).hostname === 'external.example' ? 'http://proxy.example:3128' : null
    )
    const config = {
      base_url: 'https://external.example/v1',
      responses_url: 'https://external.example/custom/messages',
      vision_sidecar: { request_url: 'https://internal.example/vision/responses' },
    }
    const resolved = await resolveRuntimeModelProxy(config, resolveProxy)
    expect(resolveProxy.mock.calls).toEqual([
      ['https://external.example/custom/messages'],
      ['https://internal.example/vision/responses'],
    ])
    expect(resolved.proxy).toEqual({ url: 'http://proxy.example:3128' })
    expect(resolved.vision_sidecar).toEqual({ ...config.vision_sidecar, proxy: { url: null } })
    expect(config).not.toHaveProperty('proxy')
  })

  test('clears a stale proxy when PAC selects DIRECT, including materialized tasks', async () => {
    const execution = {
      model_config: {
        base_url: 'https://internal.example/gateway',
        proxy: { url: 'http://old-proxy:3128' },
        proxy_url: 'http://old-proxy:3128',
        runtime_config: { codex: { use_proxy: true, proxy_configured: true, configured: true } },
      },
    }
    const resolveProxy = vi.fn().mockResolvedValue(null)
    const result = await resolveExecutionRequestProxy(execution, resolveProxy)
    expect(resolveProxy).toHaveBeenCalledWith('https://internal.example/gateway/responses')
    expect(result.model_config).not.toHaveProperty('proxy')
    expect(result.model_config).not.toHaveProperty('proxy_url')
    expect(result.model_config).toHaveProperty('runtime_config.codex', {
      use_proxy: false,
      proxy_configured: false,
      configured: true,
    })
  })

  test('does not apply the desktop network to a remote executor', async () => {
    const config = {
      base_url: 'https://remote.example/v1',
      proxy: { url: 'http://remote-proxy:3128' },
    }
    expect(await resolveRuntimeModelProxy(config)).toBe(config)
  })

  test('supports direct primary model and proxied vision model', async () => {
    const resolveProxy = vi
      .fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce('http://vision-proxy:3128')
    const result = await resolveRuntimeModelProxy(
      {
        base_url: 'http://localhost:11434/v1',
        vision_sidecar: { request_url: 'https://vision.example/v1/responses' },
      },
      resolveProxy
    )
    expect(result.proxy).toBeUndefined()
    expect(result.vision_sidecar).toHaveProperty('proxy.url', 'http://vision-proxy:3128')
  })
})
