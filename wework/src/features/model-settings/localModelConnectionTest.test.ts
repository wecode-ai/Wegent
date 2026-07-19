import { describe, expect, test, vi } from 'vitest'
import { testLocalModelConnection } from './localModelConnectionTest'

describe('localModelConnectionTest', () => {
  test('rejects a text-only response because it does not prove agent tool capability', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ choices: [{ message: { content: 'PING' } }] }))
      )

    await expect(
      testLocalModelConnection(
        {
          baseUrl: 'https://models.local/v1',
          apiFormat: 'openai-chat-completions',
          modelId: 'text-only',
        },
        { fetcher }
      )
    ).rejects.toThrow('did not return the required capability probe tool call')
  })

  test('calls the Responses endpoint with a dummy token when API key is empty', async () => {
    const fetcher = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          id: 'resp_1',
          output: [{ type: 'custom_tool_call', name: 'wework_capability_probe' }],
        }),
        {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }
      )
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
    ).resolves.toEqual({ status: 200, toolCalling: true })

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
      input: 'Call the capability probe with value PING.',
      tool_choice: { type: 'custom', name: 'wework_capability_probe' },
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

  test('surfaces a friendly error when a successful response is not JSON', async () => {
    const fetcher = vi.fn().mockResolvedValue(
      new Response('<html>proxy landing page</html>', {
        status: 200,
        headers: { 'Content-Type': 'text/html' },
      })
    )

    await expect(
      testLocalModelConnection(
        {
          baseUrl: 'https://models.local/v1',
          modelId: 'misconfigured-proxy',
        },
        { fetcher }
      )
    ).rejects.toThrow('Model returned a non-JSON response body')
  })

  test('accepts a full responses endpoint without duplicating the path', async () => {
    const fetcher = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          id: 'resp_1',
          output: [{ type: 'custom_tool_call', name: 'wework_capability_probe' }],
        })
      )
    )

    await expect(
      testLocalModelConnection(
        {
          baseUrl: 'https://models.local/v1/responses',
          modelId: 'gpt-5',
          apiKey: '',
        },
        { fetcher }
      )
    ).resolves.toEqual({ status: 200, toolCalling: true })

    expect(fetcher).toHaveBeenCalledWith('https://models.local/v1/responses', expect.any(Object))
  })

  test('uses a custom request path when configured', async () => {
    const fetcher = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          id: 'resp_1',
          output: [{ type: 'custom_tool_call', name: 'wework_capability_probe' }],
        })
      )
    )

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
    ).resolves.toEqual({ status: 200, toolCalling: true })

    expect(fetcher).toHaveBeenCalledWith('https://models.local/api/respond', expect.any(Object))
  })

  test('tests Chat Completions endpoints with the matching request format', async () => {
    const fetcher = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                tool_calls: [{ function: { name: 'wework_capability_probe', arguments: '{}' } }],
              },
            },
          ],
        })
      )
    )

    await expect(
      testLocalModelConnection(
        {
          baseUrl: 'https://api.kimi.com/coding/v1',
          apiFormat: 'openai-chat-completions',
          modelId: 'kimi-for-coding',
          apiKey: 'secret',
        },
        { fetcher }
      )
    ).resolves.toEqual({ status: 200, toolCalling: true })

    expect(fetcher).toHaveBeenCalledWith(
      'https://api.kimi.com/coding/v1/chat/completions',
      expect.any(Object)
    )
    expect(JSON.parse(fetcher.mock.calls[0][1].body)).toMatchObject({
      model: 'kimi-for-coding',
      messages: [{ role: 'user', content: 'Call the capability probe with value PING.' }],
      tool_choice: { type: 'function', function: { name: 'wework_capability_probe' } },
      stream: false,
    })
  })

  test('tests Anthropic Messages endpoints with the matching headers and body', async () => {
    const fetcher = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          content: [{ type: 'tool_use', name: 'wework_capability_probe', id: 'tool_1', input: {} }],
        })
      )
    )

    await expect(
      testLocalModelConnection(
        {
          baseUrl: 'https://api.kimi.com/coding/',
          apiFormat: 'anthropic-messages',
          modelId: 'kimi-for-coding',
          apiKey: 'secret',
        },
        { fetcher }
      )
    ).resolves.toEqual({ status: 200, toolCalling: true })

    expect(fetcher).toHaveBeenCalledWith(
      'https://api.kimi.com/coding/v1/messages',
      expect.objectContaining({
        headers: expect.objectContaining({
          'x-api-key': 'secret',
          'anthropic-version': '2023-06-01',
        }),
      })
    )
    expect(JSON.parse(fetcher.mock.calls[0][1].body)).toMatchObject({
      model: 'kimi-for-coding',
      messages: [{ role: 'user', content: 'Call the capability probe with value PING.' }],
      tool_choice: { type: 'tool', name: 'wework_capability_probe' },
      stream: false,
    })
  })
})
