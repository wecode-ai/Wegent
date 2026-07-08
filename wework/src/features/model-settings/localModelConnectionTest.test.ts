import { describe, expect, test, vi } from 'vitest'
import { testLocalModelConnection } from './localModelConnectionTest'

describe('localModelConnectionTest', () => {
  test('calls the Responses endpoint with a dummy token when API key is empty', async () => {
    const fetcher = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ id: 'resp_1' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    )

    await expect(
      testLocalModelConnection(
        {
          baseUrl: ' http://localhost:11434/v1/ ',
          modelId: ' gpt-oss:20b ',
          apiKey: '',
        },
        { fetcher }
      )
    ).resolves.toEqual({ status: 200 })

    expect(fetcher).toHaveBeenCalledWith(
      'http://localhost:11434/v1/responses',
      expect.objectContaining({
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer dummy',
        },
      })
    )
    expect(JSON.parse(fetcher.mock.calls[0][1].body)).toMatchObject({
      model: 'gpt-oss:20b',
      input: [
        {
          role: 'user',
          content: [
            {
              type: 'input_text',
              text: 'Reply with ok.',
            },
          ],
        },
      ],
      max_output_tokens: 16,
    })
  })

  test('uses the provided API key and surfaces HTTP errors', async () => {
    const fetcher = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: { message: 'bad key' } }), {
        status: 401,
        statusText: 'Unauthorized',
        headers: { 'Content-Type': 'application/json' },
      })
    )

    await expect(
      testLocalModelConnection(
        {
          baseUrl: 'https://models.local/v1',
          modelId: 'gpt-5',
          apiKey: ' local-secret ',
        },
        { fetcher }
      )
    ).rejects.toThrow('HTTP 401: bad key')

    expect(fetcher).toHaveBeenCalledWith(
      'https://models.local/v1/responses',
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'Bearer local-secret',
        }),
      })
    )
  })

  test('accepts a full responses endpoint without duplicating the path', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({ id: 'resp_1' })))

    await expect(
      testLocalModelConnection(
        {
          baseUrl: 'https://models.local/v1/responses',
          modelId: 'gpt-5',
          apiKey: '',
        },
        { fetcher }
      )
    ).resolves.toEqual({ status: 200 })

    expect(fetcher).toHaveBeenCalledWith('https://models.local/v1/responses', expect.any(Object))
  })

  test('uses a custom request path when configured', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({ id: 'resp_1' })))

    await expect(
      testLocalModelConnection(
        {
          baseUrl: 'https://models.local/api',
          requestPath: '/respond',
          modelId: 'gpt-5',
          apiKey: '',
        },
        { fetcher }
      )
    ).resolves.toEqual({ status: 200 })

    expect(fetcher).toHaveBeenCalledWith('https://models.local/api/respond', expect.any(Object))
  })
})
