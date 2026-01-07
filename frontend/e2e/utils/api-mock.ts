import { Page, Route } from '@playwright/test'

/**
 * Captured request data for verification
 */
export interface CapturedChatRequest {
  message: string
  team_id: number
  task_id?: number
  attachment_id?: number
  model_id?: string
  enable_web_search?: boolean
}

/**
 * Image URL content structure (OpenAI vision format)
 */
export interface ImageUrlContent {
  type: 'image_url'
  image_url: {
    url: string
  }
}

/**
 * Text content structure
 */
export interface TextContent {
  type: 'text'
  text: string
}

/**
 * Vision message content (array of text and image_url)
 */
export type VisionContent = (TextContent | ImageUrlContent)[]

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
    response =>
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
  page.on('request', request => {
    if (request.url().includes('/api/')) {
      console.log(`>> ${request.method()} ${request.url()}`)
    }
  })

  page.on('response', response => {
    if (response.url().includes('/api/')) {
      console.log(`<< ${response.status()} ${response.url()}`)
    }
  })
}

/**
 * Generate mock SSE response for chat stream
 * @param content Response content from the mock model
 * @param taskId Task ID to include in response
 * @param subtaskId Subtask ID to include in response
 */
export function generateMockChatSSEResponse(
  content: string,
  taskId: number = 1,
  subtaskId: number = 1
): string {
  return `data: {"task_id": ${taskId}, "subtask_id": ${subtaskId}, "content": "", "done": false}

data: {"content": ${JSON.stringify(content)}, "done": false}

data: {"content": "", "done": true, "result": {"value": ${JSON.stringify(content)}}}

`
}

/**
 * Mock chat stream endpoint with request capture
 * This allows tests to verify the request format including image_url
 *
 * @param page Playwright page object
 * @param onRequestCapture Callback to capture the request data
 * @param mockResponse Optional custom response content
 */
export async function mockChatStreamWithCapture(
  page: Page,
  onRequestCapture?: (request: CapturedChatRequest) => void,
  mockResponse: string = 'I can see the image you uploaded. It appears to be a test image.'
): Promise<void> {
  await page.route('**/api/chat/stream', async (route: Route) => {
    const request = route.request()

    // Only handle POST requests
    if (request.method() !== 'POST') {
      await route.continue()
      return
    }

    try {
      const postData = request.postDataJSON() as CapturedChatRequest

      // Capture request for verification
      if (onRequestCapture) {
        onRequestCapture(postData)
      }

      // Return mock SSE response
      await route.fulfill({
        status: 200,
        contentType: 'text/event-stream',
        headers: {
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
          'X-Accel-Buffering': 'no',
          'X-Task-Id': '1',
          'X-Subtask-Id': '1',
        },
        body: generateMockChatSSEResponse(mockResponse),
      })
    } catch {
      // If parsing fails, continue with the original request
      await route.continue()
    }
  })
}

/**
 * Mock attachment upload endpoint
 * Returns a mock attachment response with image_base64
 *
 * @param page Playwright page object
 * @param onUploadCapture Callback to capture upload data
 */
export async function mockAttachmentUpload(
  page: Page,
  onUploadCapture?: (filename: string, size: number) => void
): Promise<void> {
  let attachmentIdCounter = 1

  await page.route('**/api/attachments/upload', async (route: Route) => {
    const request = route.request()

    if (request.method() !== 'POST') {
      await route.continue()
      return
    }

    const attachmentId = attachmentIdCounter++

    // Capture upload info if callback provided
    if (onUploadCapture) {
      // Note: In real tests, we'd parse the multipart form data
      // For now, we just acknowledge the upload
      onUploadCapture('test-image.png', 75)
    }

    // Return mock attachment response
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        id: attachmentId,
        filename: 'test-image.png',
        file_size: 75,
        mime_type: 'image/png',
        status: 'ready',
        text_length: 0,
        error_message: null,
      }),
    })
  })
}

/**
 * Mock attachment detail endpoint
 *
 * @param page Playwright page object
 */
export async function mockAttachmentDetail(page: Page): Promise<void> {
  await page.route('**/api/attachments/*', async (route: Route) => {
    const request = route.request()
    const url = request.url()

    // Skip upload endpoint
    if (url.includes('/upload')) {
      await route.continue()
      return
    }

    if (request.method() !== 'GET') {
      await route.continue()
      return
    }

    // Extract attachment ID from URL
    const match = url.match(/\/api\/attachments\/(\d+)/)
    const attachmentId = match ? parseInt(match[1]) : 1

    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        id: attachmentId,
        filename: 'test-image.png',
        file_size: 75,
        mime_type: 'image/png',
        status: 'ready',
        text_length: 0,
        error_message: null,
        subtask_id: 0,
        file_extension: '.png',
        created_at: new Date().toISOString(),
      }),
    })
  })
}

/**
 * Verify that a vision message content contains valid image_url format
 *
 * @param content The message content to verify
 * @returns Object with validation result and details
 */
export function verifyImageUrlFormat(content: unknown): {
  isValid: boolean
  hasText: boolean
  hasImageUrl: boolean
  imageUrlPrefix?: string
  error?: string
} {
  // Check if content is an array (vision format)
  if (!Array.isArray(content)) {
    return {
      isValid: false,
      hasText: false,
      hasImageUrl: false,
      error: 'Content is not an array (not vision format)',
    }
  }

  let hasText = false
  let hasImageUrl = false
  let imageUrlPrefix: string | undefined

  for (const item of content) {
    if (typeof item !== 'object' || item === null) {
      continue
    }

    const typedItem = item as Record<string, unknown>

    if (typedItem.type === 'text' && typeof typedItem.text === 'string') {
      hasText = true
    }

    if (typedItem.type === 'image_url') {
      const imageUrl = typedItem.image_url as Record<string, unknown> | undefined
      if (imageUrl && typeof imageUrl.url === 'string') {
        hasImageUrl = true
        // Extract prefix (e.g., "data:image/png;base64,")
        const url = imageUrl.url as string
        const prefixMatch = url.match(/^(data:image\/[^;]+;base64,)/)
        if (prefixMatch) {
          imageUrlPrefix = prefixMatch[1]
        }
      }
    }
  }

  return {
    isValid: hasText && hasImageUrl && !!imageUrlPrefix,
    hasText,
    hasImageUrl,
    imageUrlPrefix,
    error:
      !hasText || !hasImageUrl
        ? `Missing required content: hasText=${hasText}, hasImageUrl=${hasImageUrl}`
        : undefined,
  }
}

/**
 * Setup all image-related mocks for chat testing
 *
 * @param page Playwright page object
 * @param onChatRequest Callback to capture chat request
 * @param onUpload Callback to capture upload
 */
export async function setupImageChatMocks(
  page: Page,
  onChatRequest?: (request: CapturedChatRequest) => void,
  onUpload?: (filename: string, size: number) => void
): Promise<void> {
  await mockAttachmentUpload(page, onUpload)
  await mockAttachmentDetail(page)
  await mockChatStreamWithCapture(page, onChatRequest)
}
