/**
 * Mock Model Server for E2E Testing
 *
 * This server simulates an OpenAI-compatible API endpoint to:
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

interface ChatCompletionRequest {
  model: string
  messages: VisionMessage[]
  stream?: boolean
  tools?: unknown[]
}

// Store captured requests for verification
const capturedRequests: CapturedRequest[] = []

// Port for the mock server
const PORT = parseInt(process.env.MOCK_MODEL_PORT || '9999')

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

/**
 * Generate mock SSE streaming response
 */
function generateSSEResponse(content: string): string {
  const chunks = content.split(' ')
  let response = ''

  for (let i = 0; i < chunks.length; i++) {
    const chunk = i === 0 ? chunks[i] : ' ' + chunks[i]
    response += `data: ${JSON.stringify({
      id: 'mock-response',
      object: 'chat.completion.chunk',
      created: Date.now(),
      model: 'mock-model',
      choices: [
        {
          index: 0,
          delta: { content: chunk },
          finish_reason: null,
        },
      ],
    })}\n\n`
  }

  // Final chunk
  response += `data: ${JSON.stringify({
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

  response += 'data: [DONE]\n\n'

  return response
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
    let parsedBody: ChatCompletionRequest | null = null
    try {
      if (body) {
        parsedBody = JSON.parse(body)
      }
    } catch {
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
      // Check if streaming is requested
      const isStreaming = parsedBody?.stream === true

      if (isStreaming) {
        // Return SSE streaming response
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
        })

        const responseContent =
          'I can see the image you uploaded. It appears to be a small red test image with dimensions of 10x10 pixels.'
        const sseResponse = generateSSEResponse(responseContent)

        // Send response in chunks to simulate streaming
        const lines = sseResponse.split('\n\n')
        let index = 0

        const sendChunk = () => {
          if (index < lines.length) {
            if (lines[index]) {
              res.write(lines[index] + '\n\n')
            }
            index++
            setTimeout(sendChunk, 50)
          } else {
            res.end()
          }
        }

        sendChunk()
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
                  content:
                    'I can see the image you uploaded. It appears to be a small red test image.',
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
    } else if (req.url === '/captured-requests') {
      // Endpoint to retrieve captured requests
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(capturedRequests, null, 2))
    } else if (req.url === '/clear-requests') {
      // Endpoint to clear captured requests
      capturedRequests.length = 0
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ message: 'Requests cleared' }))
    } else if (req.url === '/health') {
      // Health check endpoint
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ status: 'ok', capturedCount: capturedRequests.length }))
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
║    POST /v1/chat/completions - Mock chat API               ║
║    GET  /captured-requests   - View captured requests      ║
║    POST /clear-requests      - Clear captured requests     ║
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
