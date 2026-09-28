import { describe, expect, test, vi } from 'vitest'
import { codexProviderRequestUrl } from './codexProviderProxy'

describe('codexProviderRequestUrl', () => {
  test.each([
    [undefined, '/responses'],
    ['openai-chat-completions', '/chat/completions'],
    ['anthropic-messages', '/messages'],
  ])('uses the configured provider endpoint for %s', async (format, path) => {
    const request = vi.fn().mockResolvedValue({
      config: {
        model_providers: {
          custom: { base_url: 'https://internal.example/v1/', upstream_api_format: format },
        },
      },
    })
    await expect(codexProviderRequestUrl('custom', request)).resolves.toBe(
      `https://internal.example/v1${path}`
    )
  })

  test('rejects an unknown provider instead of using the ChatGPT PAC route', async () => {
    const request = vi.fn().mockResolvedValue({ config: {} })
    await expect(codexProviderRequestUrl('missing', request)).rejects.toThrow('no request URL')
  })
})
