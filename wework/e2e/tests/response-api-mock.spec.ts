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
