// @vitest-environment node

import { describe, expect, test, vi } from 'vitest'
import { resolveExecutionRequestProxy } from './runtimeModelProxy'

describe('runtime model PAC routing', () => {
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
})
