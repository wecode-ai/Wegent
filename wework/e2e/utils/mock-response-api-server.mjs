import http from 'node:http'

const PORT = Number.parseInt(process.env.WEWORK_RESPONSE_API_MOCK_PORT || '9998', 10)
const DEFAULT_RESPONSE_CONTENT =
  process.env.WEWORK_RESPONSE_API_MOCK_CONTENT ||
  'Mock Responses API reply from the Wework E2E server.'
const DEFAULT_CHUNK_DELAY_MS = 20

const capturedRequests = []

function corsHeaders(extra = {}) {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,DELETE,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type,Authorization',
    ...extra,
  }
}

function writeJson(res, status, data) {
  res.writeHead(status, corsHeaders({ 'Content-Type': 'application/json' }))
  res.end(JSON.stringify(data, null, 2))
}

function writeOptions(res) {
  res.writeHead(204, corsHeaders())
  res.end()
}

function parseJsonBody(body) {
  try {
    return body ? JSON.parse(body) : null
  } catch {
    return null
  }
}

function extractText(value) {
  if (typeof value === 'string') {
    return value
  }

  if (Array.isArray(value)) {
    return value.map(item => extractText(item)).filter(Boolean).join(' ')
  }

  if (value && typeof value === 'object') {
    return ['input', 'content', 'text', 'message', 'prompt']
      .map(key => extractText(value[key]))
      .filter(Boolean)
      .join(' ')
  }

  return ''
}

function responseContent(request) {
  const requestText = extractText(request)
  const token = requestText.match(/CTX_[A-Z0-9_]+/)?.[0]
  if (token) {
    return `Mock Responses API remembered ${token}`
  }
  return DEFAULT_RESPONSE_CONTENT
}

function responseBody(request, content) {
  const createdAt = Math.floor(Date.now() / 1000)
  return {
    id: `resp_mock_${createdAt}`,
    object: 'response',
    created_at: createdAt,
    status: 'completed',
    model: request?.model || 'mock-response-model',
    output: [
      {
        id: `msg_mock_${createdAt}`,
        type: 'message',
        status: 'completed',
        role: 'assistant',
        content: [
          {
            type: 'output_text',
            text: content,
            annotations: [],
          },
        ],
      },
    ],
    output_text: content,
    usage: {
      input_tokens: 12,
      output_tokens: Math.max(1, content.split(/\s+/).length),
      total_tokens: 12 + Math.max(1, content.split(/\s+/).length),
    },
  }
}

function writeSseEvent(res, event) {
  res.write(`data: ${JSON.stringify(event)}\n\n`)
}

function writeStreamingResponsesApi(res, request, content) {
  const response = responseBody(request, content)
  res.writeHead(
    200,
    corsHeaders({
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    })
  )

  writeSseEvent(res, {
    type: 'response.created',
    response: { ...response, status: 'in_progress', output: [] },
  })
  writeSseEvent(res, {
    type: 'response.output_item.added',
    output_index: 0,
    item: response.output[0],
  })
  writeSseEvent(res, {
    type: 'response.content_part.added',
    item_id: response.output[0].id,
    output_index: 0,
    content_index: 0,
    part: response.output[0].content[0],
  })

  const chunks = content.split(' ')
  let index = 0

  const sendNextChunk = () => {
    if (index < chunks.length) {
      const delta = index === 0 ? chunks[index] : ` ${chunks[index]}`
      writeSseEvent(res, {
        type: 'response.output_text.delta',
        item_id: response.output[0].id,
        output_index: 0,
        content_index: 0,
        delta,
      })
      index += 1
      setTimeout(sendNextChunk, DEFAULT_CHUNK_DELAY_MS)
      return
    }

    writeSseEvent(res, {
      type: 'response.output_text.done',
      item_id: response.output[0].id,
      output_index: 0,
      content_index: 0,
      text: content,
    })
    writeSseEvent(res, {
      type: 'response.completed',
      response,
    })
    res.write('data: [DONE]\n\n')
    res.end()
  }

  sendNextChunk()
}

function handleResponses(req, res, body) {
  const parsedBody = parseJsonBody(body)
  if (body && !parsedBody) {
    writeJson(res, 400, { error: { message: 'Invalid JSON request body' } })
    return
  }

  capturedRequests.push({
    timestamp: new Date().toISOString(),
    method: req.method || 'GET',
    url: req.url || '/',
    headers: req.headers,
    body: parsedBody,
  })

  const content = responseContent(parsedBody)
  if (parsedBody?.stream === true) {
    writeStreamingResponsesApi(res, parsedBody, content)
    return
  }

  writeJson(res, 200, responseBody(parsedBody, content))
}

const server = http.createServer((req, res) => {
  if (req.method === 'OPTIONS') {
    writeOptions(res)
    return
  }

  let body = ''
  req.on('data', chunk => {
    body += chunk.toString()
  })

  req.on('end', () => {
    if (req.url === '/health') {
      writeJson(res, 200, {
        status: 'ok',
        capturedCount: capturedRequests.length,
      })
      return
    }

    if (req.url === '/captured-requests') {
      writeJson(res, 200, capturedRequests)
      return
    }

    if (req.url === '/clear-requests' && req.method === 'POST') {
      capturedRequests.length = 0
      writeJson(res, 200, { message: 'Requests cleared' })
      return
    }

    if (req.url?.includes('/responses') && req.method === 'POST') {
      handleResponses(req, res, body)
      return
    }

    writeJson(res, 404, { error: { message: 'Not found' } })
  })
})

server.listen(PORT, '127.0.0.1', () => {
  console.log(`Wework E2E Responses API mock listening on http://127.0.0.1:${PORT}`)
})

function shutdown() {
  server.close(() => {
    process.exit(0)
  })
}

process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
