import { Page, Route } from '@playwright/test'

/**
 * Mock response data for AI APIs
 */
export const MOCK_AI_RESPONSE = {
  id: 'mock-response-id',
  object: 'chat.completion',
  created: Date.now(),
  model: 'mock-model',
  choices: [
    {
      index: 0,
      message: {
        role: 'assistant',
        content: 'This is a mock response from the AI service.',
      },
      finish_reason: 'stop',
    },
  ],
  usage: {
    prompt_tokens: 10,
    completion_tokens: 20,
    total_tokens: 30,
  },
}

/**
 * Mock streaming response for SSE
 */
export const MOCK_SSE_RESPONSE = `data: {"type":"message_start","message":{"id":"mock-id","type":"message","role":"assistant","content":[]}}

data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}

data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"This is a mock response."}}

data: {"type":"content_block_stop","index":0}

data: {"type":"message_stop"}

`

/**
 * Setup API mocks for E2E tests
 * @param page Playwright page object
 */
export async function setupApiMocks(page: Page): Promise<void> {
  // Mock Anthropic API
  await page.route('**/api.anthropic.com/**', async (route: Route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(MOCK_AI_RESPONSE),
    })
  })

  // Mock OpenAI API
  await page.route('**/api.openai.com/**', async (route: Route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(MOCK_AI_RESPONSE),
    })
  })
}

/**
 * Mock task execution API responses
 * @param page Playwright page object
 */
export async function mockTaskExecution(page: Page): Promise<void> {
  // Mock task creation
  await page.route('**/api/tasks', async (route: Route) => {
    if (route.request().method() === 'POST') {
      await route.fulfill({
        status: 201,
        contentType: 'application/json',
        body: JSON.stringify({
          id: 'mock-task-id',
          status: 'pending',
          created_at: new Date().toISOString(),
        }),
      })
    } else {
      await route.continue()
    }
  })

  // Mock SSE stream for task messages
  await page.route('**/api/tasks/*/stream', async (route: Route) => {
    await route.fulfill({
      status: 200,
      contentType: 'text/event-stream',
      body: MOCK_SSE_RESPONSE,
    })
  })
}

/**
 * Wait for API response
 * @param page Playwright page object
 * @param urlPattern URL pattern to match
 * @param timeout Timeout in milliseconds
 */
export async function waitForApiResponse(
  page: Page,
  urlPattern: string | RegExp,
  timeout: number = 10000
): Promise<void> {
  await page.waitForResponse(
    (response) =>
      (typeof urlPattern === 'string'
        ? response.url().includes(urlPattern)
        : urlPattern.test(response.url())) && response.status() === 200,
    { timeout }
  )
}

/**
 * Intercept and log API requests (for debugging)
 * @param page Playwright page object
 */
export async function logApiRequests(page: Page): Promise<void> {
  page.on('request', (request) => {
    if (request.url().includes('/api/')) {
      console.log(`>> ${request.method()} ${request.url()}`)
    }
  })

  page.on('response', (response) => {
    if (response.url().includes('/api/')) {
      console.log(`<< ${response.status()} ${response.url()}`)
    }
  })
}
