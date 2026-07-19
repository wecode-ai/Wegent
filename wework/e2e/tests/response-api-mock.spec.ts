import { expect, test } from '@playwright/test'
import { WeworkApp } from '../fixtures/wework-app'

const responseApiMockUrl = process.env.WEWORK_RESPONSE_API_MOCK_URL || 'http://127.0.0.1:9998'

type CapturedRequest = {
  method: string
  url: string
  body: {
    model?: string
    input?: unknown
  } | null
}

test('serves browser-accessible OpenAI Responses API mock responses', async ({ page }) => {
  const app = new WeworkApp(page)

  await app.goto('/')

  const result = await page.evaluate(async mockUrl => {
    await fetch(`${mockUrl}/clear-requests`, { method: 'POST' })

    const response = await fetch(`${mockUrl}/v1/responses`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer test-token',
      },
      body: JSON.stringify({
        model: 'mock-response-model',
        input: [
          {
            role: 'user',
            content: [
              {
                type: 'input_text',
                text: 'Remember CTX_WEWORK_E2E.',
              },
            ],
          },
        ],
        store: false,
      }),
    })

    const body = await response.json()
    const captured = await fetch(`${mockUrl}/captured-requests`).then(res => res.json())

    return {
      status: response.status,
      outputText: body.output_text,
      captured,
    }
  }, responseApiMockUrl)

  expect(result.status).toBe(200)
  expect(result.outputText).toContain('CTX_WEWORK_E2E')
  const matchingRequests = (result.captured as CapturedRequest[]).filter(request =>
    JSON.stringify(request.body).includes('CTX_WEWORK_E2E')
  )
  expect(matchingRequests).toHaveLength(1)
  expect(matchingRequests[0]).toMatchObject({
    method: 'POST',
    url: '/v1/responses',
    body: {
      model: 'mock-response-model',
    },
  })
})

for (const protocol of [
  {
    name: 'Responses custom tools',
    apiFormat: 'openai-responses' as const,
    toolProfile: 'custom' as const,
    path: '/v1/responses',
    modelId: 'mock-response-model',
    expectedToolType: 'custom',
  },
  {
    name: 'Responses shell profile function capability',
    apiFormat: 'openai-responses' as const,
    toolProfile: 'shell' as const,
    path: '/v1/responses',
    modelId: 'mock-response-shell-model',
    expectedToolType: 'function',
  },
  {
    name: 'Chat Completions function tools',
    apiFormat: 'openai-chat-completions' as const,
    toolProfile: 'function' as const,
    path: '/v1/chat/completions',
    modelId: 'mock-chat-model',
    expectedToolType: 'function',
  },
  {
    name: 'Anthropic Messages function tools',
    apiFormat: 'anthropic-messages' as const,
    toolProfile: 'function' as const,
    path: '/v1/messages',
    modelId: 'mock-anthropic-model',
    expectedToolType: undefined,
  },
]) {
  test(`runs a forced Agent capability probe through ${protocol.name}`, async ({ page }) => {
    const app = new WeworkApp(page)
    await app.goto('/')

    const [request, result] = await Promise.all([
      page.waitForRequest(
        candidate =>
          candidate.method() === 'POST' &&
          candidate.url().startsWith(responseApiMockUrl) &&
          candidate.url().endsWith(protocol.path.split('/').at(-1) ?? protocol.path)
      ),
      app.testLocalModelConnection({
        baseUrl: `${responseApiMockUrl}/v1`,
        apiFormat: protocol.apiFormat,
        toolProfile: protocol.toolProfile,
        modelId: protocol.modelId,
        apiKey: 'test-token',
      }),
    ])

    expect(result).toEqual({ status: 200, toolCalling: true })
    const body = request.postDataJSON()
    expect(body.model).toBe(protocol.modelId)
    expect(request.postData()).toContain('wework_capability_probe')
    if (protocol.expectedToolType) {
      expect(body.tools[0].type).toBe(protocol.expectedToolType)
    } else {
      expect(body.tools[0].name).toBe('wework_capability_probe')
      expect(body.tools[0].input_schema).toBeTruthy()
    }
  })
}

test('surfaces local model send circuit breaker failures', async ({ page }) => {
  const app = new WeworkApp(page)

  await app.goto('/')

  await expect(
    app.tripLocalModelConnectionCircuitBreaker({
      baseUrl: `${responseApiMockUrl}/v1`,
      modelId: 'mock-response-model',
      apiKey: 'test-token',
    })
  ).rejects.toThrow('WEWORK_E2E_LOCAL_MODEL_SEND_CIRCUIT_OPEN')
})

test('streams OpenAI Responses API events from the mock server', async ({ page }) => {
  const app = new WeworkApp(page)

  await app.goto('/')

  const streamText = await page.evaluate(async mockUrl => {
    const response = await fetch(`${mockUrl}/v1/responses`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer test-token',
      },
      body: JSON.stringify({
        model: 'mock-response-model',
        input: 'Stream CTX_WEWORK_STREAM.',
        stream: true,
        store: false,
      }),
    })

    const reader = response.body?.getReader()
    if (!reader) {
      throw new Error('Expected a readable response body')
    }

    const decoder = new TextDecoder()
    let text = ''

    while (true) {
      const { value, done } = await reader.read()
      if (done) {
        break
      }
      text += decoder.decode(value, { stream: true })
    }

    text += decoder.decode()
    return text
  }, responseApiMockUrl)

  expect(streamText).toContain('response.created')
  expect(streamText).toContain('response.output_text.delta')
  expect(streamText).toContain('response.completed')
  expect(streamText).toContain('[DONE]')
})
