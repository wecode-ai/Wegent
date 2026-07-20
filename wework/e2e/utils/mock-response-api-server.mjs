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
    'Access-Control-Allow-Headers': 'Content-Type,Authorization,x-api-key,anthropic-version',
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
    return value
      .map(item => extractText(item))
      .filter(Boolean)
      .join(' ')
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

function capabilityProbeName(request) {
  const tools = Array.isArray(request?.tools) ? request.tools : []
  return tools
    .map(tool => tool?.name || tool?.function?.name)
    .find(name => name === 'wework_capability_probe')
}

function capabilityRequestError(req, request, apiFormat) {
  const tools = Array.isArray(request?.tools) ? request.tools : []
  const tool = tools.find(
    candidate => (candidate?.name || candidate?.function?.name) === 'wework_capability_probe'
  )
  if (!tool) return 'Missing wework_capability_probe tool'
  if (!String(req.headers.authorization || '').startsWith('Bearer ')) {
    return 'Missing bearer authorization'
  }
  if (request?.stream !== false) return 'Capability probe must be non-streaming'

  if (apiFormat === 'responses') {
    if (request?.store !== false || request?.max_output_tokens !== 64) {
      return 'Responses probe options are incorrect'
    }
    if (!String(request?.input || '').includes('PING')) return 'Responses probe prompt is missing'
    if (request?.tool_choice !== undefined) return 'Responses probe must not force a tool'
    if (tool.type === 'custom') {
      if (
        tool.format?.type !== 'grammar' ||
        tool.format?.syntax !== 'lark' ||
        tool.format?.definition !== 'start: "PING"'
      ) {
        return 'Responses custom tool grammar is incorrect'
      }
      return null
    }
    if (
      tool.type !== 'function' ||
      tool.parameters?.properties?.input?.type !== 'string' ||
      !tool.parameters?.required?.includes('input')
    ) {
      return 'Responses function tool schema is incorrect'
    }
    return null
  }

  if (
    request?.max_tokens !== 64 ||
    request?.messages?.[0]?.role !== 'user' ||
    !String(request?.messages?.[0]?.content || '').includes('PING')
  ) {
    return `${apiFormat} probe prompt or token limit is incorrect`
  }
  if (apiFormat === 'chat') {
    if (
      tool.type !== 'function' ||
      tool.function?.parameters?.properties?.input?.type !== 'string' ||
      request?.tool_choice !== undefined
    ) {
      return 'Chat function tool schema is incorrect or the probe forced a tool'
    }
    return null
  }
  if (
    req.headers['x-api-key'] !== 'test-token' ||
    req.headers['anthropic-version'] !== '2023-06-01' ||
    tool.input_schema?.properties?.input?.type !== 'string' ||
    request?.tool_choice !== undefined
  ) {
    return 'Anthropic headers or tool schema is incorrect, or the probe forced a tool'
  }
  return null
}

function responsesCapabilityBody(request) {
  const createdAt = Math.floor(Date.now() / 1000)
  const custom = request?.tools?.[0]?.type === 'custom'
  return {
    id: `resp_probe_${createdAt}`,
    object: 'response',
    created_at: createdAt,
    status: 'completed',
    model: request?.model || 'mock-response-model',
    output: [
      custom
        ? {
            id: `tool_probe_${createdAt}`,
            type: 'custom_tool_call',
            call_id: `call_probe_${createdAt}`,
            name: 'wework_capability_probe',
            input: 'PING',
          }
        : {
            id: `tool_probe_${createdAt}`,
            type: 'function_call',
            call_id: `call_probe_${createdAt}`,
            name: 'wework_capability_probe',
            arguments: JSON.stringify({ input: 'PING' }),
          },
    ],
    usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
  }
}

function chatCapabilityBody(request) {
  return {
    id: 'chatcmpl_probe',
    object: 'chat.completion',
    model: request?.model || 'mock-chat-model',
    choices: [
      {
        index: 0,
        finish_reason: 'tool_calls',
        message: {
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              id: 'call_probe',
              type: 'function',
              function: {
                name: 'wework_capability_probe',
                arguments: JSON.stringify({ input: 'PING' }),
              },
            },
          ],
        },
      },
    ],
  }
}

function anthropicCapabilityBody(request) {
  return {
    id: 'msg_probe',
    type: 'message',
    role: 'assistant',
    model: request?.model || 'mock-anthropic-model',
    stop_reason: 'tool_use',
    content: [
      {
        type: 'tool_use',
        id: 'toolu_probe',
        name: 'wework_capability_probe',
        input: { input: 'PING' },
      },
    ],
    usage: { input_tokens: 1, output_tokens: 1 },
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
  if (capabilityProbeName(parsedBody)) {
    const error = capabilityRequestError(req, parsedBody, 'responses')
    if (error) {
      writeJson(res, 422, { error: { message: error } })
      return
    }
    writeJson(res, 200, responsesCapabilityBody(parsedBody))
    return
  }
  if (parsedBody?.stream === true) {
    writeStreamingResponsesApi(res, parsedBody, content)
    return
  }

  writeJson(res, 200, responseBody(parsedBody, content))
}

function handleChat(req, res, body) {
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
  if (!capabilityProbeName(parsedBody)) {
    writeJson(res, 400, { error: { message: 'Capability probe tool is required' } })
    return
  }
  const error = capabilityRequestError(req, parsedBody, 'chat')
  if (error) {
    writeJson(res, 422, { error: { message: error } })
    return
  }
  writeJson(res, 200, chatCapabilityBody(parsedBody))
}

function handleAnthropic(req, res, body) {
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
  if (!capabilityProbeName(parsedBody)) {
    writeJson(res, 400, { error: { message: 'Capability probe tool is required' } })
    return
  }
  const error = capabilityRequestError(req, parsedBody, 'anthropic')
  if (error) {
    writeJson(res, 422, { error: { message: error } })
    return
  }
  writeJson(res, 200, anthropicCapabilityBody(parsedBody))
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

    if (req.url?.includes('/chat/completions') && req.method === 'POST') {
      handleChat(req, res, body)
      return
    }

    if (req.url?.includes('/messages') && req.method === 'POST') {
      handleAnthropic(req, res, body)
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
