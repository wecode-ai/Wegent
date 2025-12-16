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
 * Mock streaming response for SSE (Anthropic format)
 */
export const MOCK_SSE_RESPONSE = `data: {"type":"message_start","message":{"id":"mock-id","type":"message","role":"assistant","content":[]}}

data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}

data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"This is a mock response."}}

data: {"type":"content_block_stop","index":0}

data: {"type":"message_stop"}

`

/**
 * Generate mock chat stream SSE response with task/subtask IDs
 * This is used for testing the chat functionality with file attachments
 */
export function generateMockChatStreamResponse(
  taskId?: number,
  subtaskId?: number,
  content?: string
): string {
  const tId = taskId || Date.now()
  const sId = subtaskId || tId + 1
  const responseContent =
    content ||
    'This is a mock response from the AI service. I have received and processed your file attachment.'

  return [
    `data: {"task_id":${tId},"subtask_id":${sId},"content":"","done":false}\n\n`,
    `data: {"content":"${responseContent}","done":false}\n\n`,
    `data: {"content":"","done":true,"result":{"value":"${responseContent}"}}\n\n`,
  ].join('')
}

/**
 * Mock response for attachment upload
 */
export interface MockAttachmentResponse {
  id: number
  filename: string
  file_size: number
  mime_type: string
  status: 'uploading' | 'parsing' | 'ready' | 'failed'
  text_length?: number | null
  error_message?: string | null
}

/**
 * Generate mock attachment response
 */
export function generateMockAttachmentResponse(
  filename: string,
  mimeType: string,
  options?: Partial<MockAttachmentResponse>
): MockAttachmentResponse {
  return {
    id: options?.id || Math.floor(Math.random() * 10000) + 1000,
    filename,
    file_size: options?.file_size || 1024,
    mime_type: mimeType,
    status: options?.status || 'ready',
    text_length: options?.text_length || 100,
    error_message: options?.error_message || null,
  }
}

/**
 * MIME type mapping for common file extensions
 */
export const MIME_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.pdf': 'application/pdf',
  '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.ppt': 'application/vnd.ms-powerpoint',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.xls': 'application/vnd.ms-excel',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.csv': 'text/csv',
}

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

/**
 * Setup chat stream mock for testing media file chat
 * @param page Playwright page object
 */
export async function mockChatStream(page: Page): Promise<void> {
  await page.route('**/api/chat/stream', async (route: Route) => {
    const request = route.request()

    if (request.method() === 'POST') {
      const mockTaskId = Date.now()
      const mockSubtaskId = mockTaskId + 1

      await route.fulfill({
        status: 200,
        contentType: 'text/event-stream',
        headers: {
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
          'X-Task-Id': String(mockTaskId),
          'X-Subtask-Id': String(mockSubtaskId),
        },
        body: generateMockChatStreamResponse(mockTaskId, mockSubtaskId),
      })
    } else {
      await route.continue()
    }
  })
}

/**
 * Setup attachment upload mock for testing file uploads
 * @param page Playwright page object
 */
export async function mockAttachmentUpload(page: Page): Promise<void> {
  let attachmentIdCounter = 1000

  await page.route('**/api/attachments/upload', async (route: Route) => {
    const attachmentId = attachmentIdCounter++

    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(
        generateMockAttachmentResponse('uploaded-file', 'application/octet-stream', {
          id: attachmentId,
        })
      ),
    })
  })

  // Mock get attachment details
  await page.route(/\/api\/attachments\/\d+$/, async (route: Route) => {
    if (route.request().method() === 'GET') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          ...generateMockAttachmentResponse('test-file', 'application/octet-stream'),
          file_extension: '.pdf',
          created_at: new Date().toISOString(),
        }),
      })
    } else if (route.request().method() === 'DELETE') {
      await route.fulfill({
        status: 204,
      })
    } else {
      await route.continue()
    }
  })
}

/**
 * Setup all mocks needed for media chat testing
 * @param page Playwright page object
 */
export async function setupMediaChatMocks(page: Page): Promise<void> {
  await mockChatStream(page)
  await mockAttachmentUpload(page)
}
