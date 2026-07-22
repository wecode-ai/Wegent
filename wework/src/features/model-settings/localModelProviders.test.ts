import { describe, expect, it, vi } from 'vitest'
import { discoverProviderModels, findLocalModelProviderProfile } from './localModelProviders'

describe('localModelProviders', () => {
  it('defines the Kimi Coding profile with only provider-managed defaults', () => {
    const profile = findLocalModelProviderProfile('kimi-coding')

    expect(profile).toMatchObject({
      baseUrl: 'https://api.kimi.com/coding/v1',
      apiFormat: 'openai-chat-completions',
      requestPath: '/chat/completions',
      modelsPath: '/models',
      toolProfile: 'function',
      contextWindow: 256_000,
    })
  })

  it('loads, validates, sorts, and deduplicates provider model entries', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          data: [{ id: 'kimi-k3' }, { id: '' }, { id: 'kimi-k2.5' }, { id: 'kimi-k3' }],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      )
    )

    const models = await discoverProviderModels(
      findLocalModelProviderProfile('kimi-coding'),
      'secret-key',
      { fetcher }
    )

    expect(fetcher).toHaveBeenCalledWith(
      'https://api.kimi.com/coding/v1/models',
      expect.objectContaining({
        method: 'GET',
        headers: { Authorization: 'Bearer secret-key' },
      })
    )
    expect(models).toEqual([
      { id: 'kimi-k2.5', displayName: 'kimi-k2.5' },
      { id: 'kimi-k3', displayName: 'kimi-k3' },
    ])
  })

  it('reports provider HTTP errors instead of accepting an invalid catalog', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        new Response(JSON.stringify({ error: { message: 'invalid token' } }), { status: 401 })
      )

    await expect(
      discoverProviderModels(findLocalModelProviderProfile('kimi-coding'), 'bad-key', { fetcher })
    ).rejects.toThrow('HTTP 401: invalid token')
  })
})
