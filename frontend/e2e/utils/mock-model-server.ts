/**
 * Mock Model Server for E2E Testing
 *
 * This server simulates OpenAI-compatible and Anthropic-compatible API endpoints to:
 * 1. Capture requests sent by the backend
 * 2. Verify the image_url format in vision messages
 * 3. Return mock streaming responses
 *
 * Usage:
 *   npx ts-node frontend/e2e/utils/mock-model-server.ts
 *
 * The server will start on port 9999 and log all captured requests.
 */

import * as http from 'http'

interface CapturedRequest {
  timestamp: string
  method: string
  url: string
  headers: Record<string, string | string[] | undefined>
  body: unknown
}

interface VisionMessage {
  role: string
  content:
    | string
    | Array<{
        type: string
        text?: string
        image_url?: {
          url: string
        }
      }>
}

interface ModelRequest {
  model?: string
  messages?: VisionMessage[]
  system?: unknown
  stream?: boolean
  tools?: unknown[]
}

interface StreamRule {
  matchText: string
  responseContent: string
  chunkDelayMs?: number
  doneDelayMs?: number
}

// Store captured requests for verification
const capturedRequests: CapturedRequest[] = []
const streamRules: StreamRule[] = []

// Port for the mock server
const PORT = parseInt(process.env.MOCK_MODEL_PORT || '9999')
const DEFAULT_RESPONSE_CONTENT =
  'I can see the image you uploaded. It appears to be a small red test image with dimensions of 10x10 pixels.'
const DEFAULT_CHUNK_DELAY_MS = 50

/**
 * Verify if a message contains valid image_url format
 */
function verifyImageUrlInMessage(message: VisionMessage): {
  hasImageUrl: boolean
  imageUrlPrefix?: string
  isValidFormat: boolean
  details: string
} {
  if (typeof message.content === 'string') {
    return {
      hasImageUrl: false,
      isValidFormat: false,
      details: 'Content is a string, not vision format',
    }
  }

  if (!Array.isArray(message.content)) {
    return {
      hasImageUrl: false,
      isValidFormat: false,
      details: 'Content is not an array',
    }
  }

  let hasText = false
  let hasImageUrl = false
  let imageUrlPrefix: string | undefined

  for (const item of message.content) {
    if (item.type === 'text' && item.text) {
      hasText = true
    }
    if (item.type === 'image_url' && item.image_url?.url) {
      hasImageUrl = true
      const match = item.image_url.url.match(/^(data:image\/[^;]+;base64,)/)
      if (match) {
        imageUrlPrefix = match[1]
      }
    }
  }

  return {
    hasImageUrl,
    imageUrlPrefix,
    isValidFormat: hasText && hasImageUrl && !!imageUrlPrefix,
    details: `hasText=${hasText}, hasImageUrl=${hasImageUrl}, prefix=${imageUrlPrefix || 'none'}`,
  }
}

function extractText(value: unknown): string {
  if (typeof value === 'string') {
    return value
  }

  if (Array.isArray(value)) {
    return value.map(item => extractText(item)).join(' ')
  }

  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>
    return ['body', 'messages', 'system', 'input', 'content', 'text', 'prompt']
      .map(key => extractText(obj[key]))
      .join(' ')
  }

  return ''
}

function getRequestText(request: ModelRequest | null): string {
  if (!request) {
    return ''
  }

  const messageText = (request.messages || [])
    .map(message => {
      if (typeof message.content === 'string') {
        return message.content
      }

      if (Array.isArray(message.content)) {
        return message.content
          .map(item => {
            if (item.type === 'text') {
              return item.text || ''
            }
            return ''
          })
          .join(' ')
      }

      return ''
    })
    .join(' ')

  return [extractText(request.system), messageText].join(' ')
}

function findStreamRule(request: ModelRequest | null): StreamRule | undefined {
  const requestText = getRequestText(request)
  return streamRules
    .filter(rule => requestText.includes(rule.matchText))
    .sort((left, right) => right.matchText.length - left.matchText.length)[0]
}

function extractContextToken(text: string): string | null {
  return text.match(/CTX_[A-Z0-9_]+/)?.[0] || null
}

function buildContextAwareResponseContent(request: ModelRequest | null): string {
  const requestText = getRequestText(request)
  const token = extractContextToken(requestText)
  const asksForPreviousToken =
    /previous turn|previous message|previous code turn|previous device turn|what context token|what .*token|上轮|上一轮|上一次|刚才/i.test(
      requestText
    )

  if (asksForPreviousToken) {
    return token ? `Mock model resumed with ${token}` : 'MISSING_CONTEXT'
  }

  if (token) {
    return `Mock model remembered ${token}`
  }

  return DEFAULT_RESPONSE_CONTENT
}

function parseJsonBody<T>(body: string): T | null {
  try {
    return body ? (JSON.parse(body) as T) : null
  } catch {
    return null
  }
}

function writeJson(res: http.ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(data, null, 2))
}

function writeSseChunk(res: http.ServerResponse, content: string): void {
  res.write(
    `data: ${JSON.stringify({
      id: 'mock-response',
      object: 'chat.completion.chunk',
      created: Date.now(),
      model: 'mock-model',
      choices: [
        {
          index: 0,
          delta: { content },
          finish_reason: null,
        },
      ],
    })}\n\n`
  )
}

function writeSseDone(res: http.ServerResponse): void {
  res.write(
    `data: ${JSON.stringify({
      id: 'mock-response',
      object: 'chat.completion.chunk',
      created: Date.now(),
      model: 'mock-model',
      choices: [
        {
          index: 0,
          delta: {},
          finish_reason: 'stop',
        },
      ],
    })}\n\n`
  )
  res.write('data: [DONE]\n\n')
  res.end()
}

function writeStreamingResponse(
  res: http.ServerResponse,
  content: string,
  chunkDelayMs: number,
  doneDelayMs: number
): void {
  const chunks = content.split(' ')
  let index = 0

  const sendChunk = () => {
    if (index < chunks.length) {
      const chunk = index === 0 ? chunks[index] : ' ' + chunks[index]
      writeSseChunk(res, chunk)
      index++
      setTimeout(sendChunk, chunkDelayMs)
      return
    }

    setTimeout(() => writeSseDone(res), doneDelayMs)
  }

  sendChunk()
}

function writeAnthropicSseEvent(res: http.ServerResponse, event: string, data: unknown): void {
  res.write(`event: ${event}\n`)
  res.write(`data: ${JSON.stringify(data)}\n\n`)
}

function writeAnthropicStreamingResponse(
  res: http.ServerResponse,
  content: string,
  model: string,
  chunkDelayMs: number,
  doneDelayMs: number
): void {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  })

  writeAnthropicSseEvent(res, 'message_start', {
    type: 'message_start',
    message: {
      id: `msg_${Date.now()}`,
      type: 'message',
      role: 'assistant',
      model,
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: {
        input_tokens: 100,
        output_tokens: 0,
      },
    },
  })
  writeAnthropicSseEvent(res, 'content_block_start', {
    type: 'content_block_start',
    index: 0,
    content_block: {
      type: 'text',
      text: '',
    },
  })

  const chunks = content.split(' ')
  let index = 0

  const sendChunk = () => {
    if (index < chunks.length) {
      const text = index === 0 ? chunks[index] : ' ' + chunks[index]
      writeAnthropicSseEvent(res, 'content_block_delta', {
        type: 'content_block_delta',
        index: 0,
        delta: {
          type: 'text_delta',
          text,
        },
      })
      index++
      setTimeout(sendChunk, chunkDelayMs)
      return
    }

    setTimeout(() => {
      writeAnthropicSseEvent(res, 'content_block_stop', {
        type: 'content_block_stop',
        index: 0,
      })
      writeAnthropicSseEvent(res, 'message_delta', {
        type: 'message_delta',
        delta: {
          stop_reason: 'end_turn',
          stop_sequence: null,
        },
        usage: {
          output_tokens: Math.max(1, chunks.length),
        },
      })
      writeAnthropicSseEvent(res, 'message_stop', {
        type: 'message_stop',
      })
      res.end()
    }, doneDelayMs)
  }

  sendChunk()
}

function writeAnthropicJsonResponse(
  res: http.ServerResponse,
  content: string,
  model: string
): void {
  writeJson(res, 200, {
    id: `msg_${Date.now()}`,
    type: 'message',
    role: 'assistant',
    model,
    content: [
      {
        type: 'text',
        text: content,
      },
    ],
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage: {
      input_tokens: 100,
      output_tokens: Math.max(1, content.split(' ').length),
    },
  })
}

/**
 * Create the mock HTTP server
 */
const server = http.createServer((req, res) => {
  let body = ''

  req.on('data', chunk => {
    body += chunk.toString()
  })

  req.on('end', () => {
    const timestamp = new Date().toISOString()

    // Parse request body
    const parsedBody = parseJsonBody<ModelRequest>(body)
    if (body && !parsedBody) {
      console.error(`[${timestamp}] Failed to parse request body`)
    }

    // Capture the request
    const captured: CapturedRequest = {
      timestamp,
      method: req.method || 'GET',
      url: req.url || '/',
      headers: req.headers,
      body: parsedBody,
    }
    capturedRequests.push(captured)

    // Log the request
    console.log(`\n${'='.repeat(60)}`)
    console.log(`[${timestamp}] ${req.method} ${req.url}`)
    console.log(`${'='.repeat(60)}`)

    // Check for image_url in messages
    if (parsedBody?.messages) {
      console.log(`\nMessages count: ${parsedBody.messages.length}`)

      for (let i = 0; i < parsedBody.messages.length; i++) {
        const msg = parsedBody.messages[i]
        console.log(`\nMessage ${i + 1} (role: ${msg.role}):`)

        if (msg.role === 'user') {
          const verification = verifyImageUrlInMessage(msg)
          console.log(`  Image URL Check: ${JSON.stringify(verification, null, 2)}`)

          if (verification.hasImageUrl) {
            console.log(`  ✅ IMAGE_URL FOUND! Prefix: ${verification.imageUrlPrefix}`)
          }
        }
      }
    }

    // Handle different endpoints
    if (req.url?.includes('/chat/completions')) {
      const streamRule = findStreamRule(parsedBody)
      const responseContent =
        streamRule?.responseContent || buildContextAwareResponseContent(parsedBody)

      // Check if streaming is requested
      const isStreaming = parsedBody?.stream === true

      if (isStreaming) {
        // Return SSE streaming response
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
        })

        writeStreamingResponse(
          res,
          responseContent,
          streamRule?.chunkDelayMs ?? DEFAULT_CHUNK_DELAY_MS,
          streamRule?.doneDelayMs ?? 0
        )
      } else {
        // Return non-streaming response
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(
          JSON.stringify({
            id: 'mock-response',
            object: 'chat.completion',
            created: Date.now(),
            model: 'mock-model',
            choices: [
              {
                index: 0,
                message: {
                  role: 'assistant',
                  content: responseContent,
                },
                finish_reason: 'stop',
              },
            ],
            usage: {
              prompt_tokens: 100,
              completion_tokens: 20,
              total_tokens: 120,
            },
          })
        )
      }
    } else if (req.url?.includes('/messages/count_tokens')) {
      writeJson(res, 200, {
        input_tokens: Math.max(1, Math.ceil(getRequestText(parsedBody).length / 4)),
      })
    } else if (req.url?.includes('/messages')) {
      const streamRule = findStreamRule(parsedBody)
      const responseContent =
        streamRule?.responseContent || buildContextAwareResponseContent(parsedBody)
      const model = parsedBody?.model || 'mock-claude'
      const isStreaming = parsedBody?.stream === true

      if (isStreaming) {
        writeAnthropicStreamingResponse(
          res,
          responseContent,
          model,
          streamRule?.chunkDelayMs ?? DEFAULT_CHUNK_DELAY_MS,
          streamRule?.doneDelayMs ?? 0
        )
      } else {
        writeAnthropicJsonResponse(res, responseContent, model)
      }
    } else if (req.url === '/captured-requests') {
      // Endpoint to retrieve captured requests
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(capturedRequests, null, 2))
    } else if (req.url === '/clear-requests') {
      // Endpoint to clear captured requests
      capturedRequests.length = 0
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ message: 'Requests cleared' }))
    } else if (req.url === '/stream-rules' && req.method === 'GET') {
      writeJson(res, 200, streamRules)
    } else if (req.url === '/stream-rules' && req.method === 'POST') {
      const streamRule = parseJsonBody<StreamRule>(body)
      if (!streamRule?.matchText || !streamRule.responseContent) {
        writeJson(res, 400, { error: 'matchText and responseContent are required' })
        return
      }

      const existingIndex = streamRules.findIndex(rule => rule.matchText === streamRule.matchText)
      if (existingIndex >= 0) {
        streamRules[existingIndex] = streamRule
      } else {
        streamRules.push(streamRule)
      }

      writeJson(res, 200, { message: 'Stream rule saved', rule: streamRule })
    } else if (req.url?.startsWith('/stream-rules') && req.method === 'DELETE') {
      const url = new URL(req.url, `http://localhost:${PORT}`)
      const matchText = url.searchParams.get('matchText')

      if (matchText) {
        const ruleIndex = streamRules.findIndex(rule => rule.matchText === matchText)
        if (ruleIndex >= 0) {
          streamRules.splice(ruleIndex, 1)
        }
      } else {
        streamRules.length = 0
      }

      writeJson(res, 200, { message: 'Stream rules cleared', remainingCount: streamRules.length })
    } else if (req.url === '/health') {
      // Health check endpoint
      writeJson(res, 200, {
        status: 'ok',
        capturedCount: capturedRequests.length,
        streamRuleCount: streamRules.length,
      })
    } else {
      // Default response
      res.writeHead(404, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'Not found' }))
    }
  })
})

// Start the server
server.listen(PORT, () => {
  console.log(`
╔════════════════════════════════════════════════════════════╗
║           Mock Model Server for E2E Testing                ║
╠════════════════════════════════════════════════════════════╣
║  Server running on: http://localhost:${PORT}                  ║
║                                                            ║
║  Endpoints:                                                ║
║    POST /v1/chat/completions - Mock OpenAI chat API        ║
║    POST /v1/messages         - Mock Anthropic Messages API ║
║    GET  /captured-requests   - View captured requests      ║
║    POST /clear-requests      - Clear captured requests     ║
║    GET  /stream-rules        - View stream rules           ║
║    POST /stream-rules        - Add a matched stream rule   ║
║    DELETE /stream-rules      - Clear stream rules          ║
║    GET  /health              - Health check                ║
║                                                            ║
║  Configure your model to use:                              ║
║    Base URL: http://localhost:${PORT}/v1                      ║
║    API Key: any-value                                      ║
╚════════════════════════════════════════════════════════════╝
`)
})

// Handle graceful shutdown
process.on('SIGINT', () => {
  console.log('\nShutting down mock server...')
  server.close(() => {
    console.log('Server closed')
    process.exit(0)
  })
})

export { server, capturedRequests, verifyImageUrlInMessage }
