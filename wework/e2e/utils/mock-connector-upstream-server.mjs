import http from 'node:http'

const PORT = Number.parseInt(process.env.WEWORK_CONNECTOR_UPSTREAM_MOCK_PORT || '9996', 10)
const DEFAULT_ACCESS_TOKEN = 'connector-access-token'
const DEFAULT_REFRESH_TOKEN = 'connector-refresh-token'

const capturedRequests = []

function corsHeaders(extra = {}) {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS',
    'Access-Control-Allow-Headers':
      'Content-Type,Authorization,Mcp-Session-Id,MCP-Protocol-Version',
    'Access-Control-Expose-Headers': 'Mcp-Session-Id',
    ...extra,
  }
}

function writeJson(res, status, data, headers = {}) {
  res.writeHead(status, corsHeaders({ 'Content-Type': 'application/json', ...headers }))
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

function parseFormBody(body) {
  return Object.fromEntries(new URLSearchParams(body))
}

function parsedBody(req, body) {
  const contentType = req.headers['content-type'] || ''
  if (String(contentType).includes('application/x-www-form-urlencoded')) {
    return parseFormBody(body)
  }
  return parseJsonBody(body)
}

function capture(req, body) {
  capturedRequests.push({
    timestamp: new Date().toISOString(),
    method: req.method || 'GET',
    url: req.url || '/',
    headers: req.headers,
    body: parsedBody(req, body),
  })
}

function redirectOAuth(req, res) {
  const url = new URL(req.url || '/', `http://127.0.0.1:${PORT}`)
  const redirectUri = url.searchParams.get('redirect_uri')
  const state = url.searchParams.get('state')
  if (!redirectUri || !state) {
    writeJson(res, 400, { error: 'redirect_uri and state are required' })
    return
  }

  const callback = new URL(redirectUri)
  callback.searchParams.set('code', 'provider-code')
  callback.searchParams.set('state', state)
  res.writeHead(302, corsHeaders({ Location: callback.toString() }))
  res.end()
}

function issueOAuthToken(req, res, body) {
  const payload = parsedBody(req, body) || {}
  const grantType = payload.grant_type || 'authorization_code'
  if (grantType === 'refresh_token' && !payload.refresh_token) {
    writeJson(res, 400, { error: 'refresh_token is required' })
    return
  }
  if (grantType === 'authorization_code' && !payload.code) {
    writeJson(res, 400, { error: 'code is required' })
    return
  }

  writeJson(res, 200, {
    access_token:
      grantType === 'refresh_token' ? `${DEFAULT_ACCESS_TOKEN}-refreshed` : DEFAULT_ACCESS_TOKEN,
    refresh_token: DEFAULT_REFRESH_TOKEN,
    token_type: 'Bearer',
    scope: payload.scope || 'docs.read sites.write',
    expires_in: 3600,
  })
}

function ticketFromUrl(req) {
  const url = new URL(req.url || '/', `http://127.0.0.1:${PORT}`)
  const match = url.pathname.match(/^\/api\/tickets\/([^/]+)$/)
  if (!match) {
    return null
  }
  return {
    id: decodeURIComponent(match[1]),
    expand: url.searchParams.get('expand') === 'true',
  }
}

function handleTicketLookup(req, res) {
  const ticket = ticketFromUrl(req)
  if (!ticket) {
    writeJson(res, 404, { error: 'Ticket not found' })
    return
  }

  writeJson(res, 200, {
    id: ticket.id,
    title: `Mock ticket ${ticket.id}`,
    status: 'open',
    expanded: ticket.expand,
    received_authorization: req.headers.authorization || null,
    received_user: req.headers['x-wegent-username'] || null,
  })
}

function connectorTools() {
  return [
    {
      name: 'search_docs',
      title: 'Search docs',
      description: 'Search mock connector documents.',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string' },
        },
        required: ['query'],
      },
      annotations: {
        readOnlyHint: true,
        openWorldHint: false,
      },
    },
    {
      name: 'create_site',
      title: 'Create site',
      description: 'Create a deterministic mock site project.',
      inputSchema: {
        type: 'object',
        properties: {
          title: { type: 'string' },
        },
        required: ['title'],
      },
      annotations: {
        destructiveHint: false,
        openWorldHint: true,
      },
    },
  ]
}

function jsonRpcResponse(id, result) {
  return {
    jsonrpc: '2.0',
    id,
    result,
  }
}

function jsonRpcError(id, code, message) {
  return {
    jsonrpc: '2.0',
    id,
    error: { code, message },
  }
}

function handleMcp(req, res, body) {
  const request = parseJsonBody(body)
  if (!request || typeof request !== 'object') {
    writeJson(res, 400, { error: 'Invalid JSON-RPC request' })
    return
  }

  if (!('id' in request)) {
    res.writeHead(202, corsHeaders())
    res.end()
    return
  }

  const sessionHeaders = { 'Mcp-Session-Id': 'mock-connector-session' }
  if (request.method === 'initialize') {
    writeJson(
      res,
      200,
      jsonRpcResponse(request.id, {
        protocolVersion: '2025-06-18',
        capabilities: {
          tools: {
            listChanged: false,
          },
        },
        serverInfo: {
          name: 'wegent-e2e-connector-upstream',
          version: '0.1.0',
        },
      }),
      sessionHeaders
    )
    return
  }

  if (request.method === 'tools/list') {
    writeJson(res, 200, jsonRpcResponse(request.id, { tools: connectorTools() }), sessionHeaders)
    return
  }

  if (request.method === 'tools/call') {
    const name = request.params?.name
    const args = request.params?.arguments || {}
    if (name === 'search_docs') {
      const query = typeof args.query === 'string' ? args.query : ''
      writeJson(
        res,
        200,
        jsonRpcResponse(request.id, {
          content: [
            {
              type: 'text',
              text: `Mock connector found docs for ${query}`,
            },
          ],
          structuredContent: {
            query,
            results: [{ id: 'doc-1', title: `Result for ${query}` }],
          },
          isError: false,
        }),
        sessionHeaders
      )
      return
    }

    if (name === 'create_site') {
      const title =
        typeof args.title === 'string' && args.title.trim() ? args.title.trim() : 'Untitled'
      writeJson(
        res,
        200,
        jsonRpcResponse(request.id, {
          content: [
            {
              type: 'text',
              text: `Created mock site ${title}`,
            },
          ],
          structuredContent: {
            siteid: `mock_${title.toLowerCase().replace(/[^a-z0-9]+/g, '_')}`,
            title,
            url: `https://sites.example.test/${encodeURIComponent(title.toLowerCase())}`,
          },
          isError: false,
        }),
        sessionHeaders
      )
      return
    }

    writeJson(res, 200, jsonRpcError(request.id, -32601, 'Tool not found'), sessionHeaders)
    return
  }

  writeJson(res, 200, jsonRpcError(request.id, -32601, 'Method not found'), sessionHeaders)
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
        mcpUrl: `http://127.0.0.1:${PORT}/mcp`,
        httpApiUrl: `http://127.0.0.1:${PORT}/api`,
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

    capture(req, body)

    if (req.url?.startsWith('/oauth/authorize') && req.method === 'GET') {
      redirectOAuth(req, res)
      return
    }

    if (req.url === '/oauth/token' && req.method === 'POST') {
      issueOAuthToken(req, res, body)
      return
    }

    if (req.url?.startsWith('/api/tickets/') && req.method === 'GET') {
      handleTicketLookup(req, res)
      return
    }

    if (req.url === '/mcp' && req.method === 'POST') {
      handleMcp(req, res, body)
      return
    }

    writeJson(res, 404, { error: 'Not found' })
  })
})

server.listen(PORT, '127.0.0.1', () => {
  console.log(`Wework E2E connector upstream mock listening on http://127.0.0.1:${PORT}`)
})

function shutdown() {
  server.close(() => {
    process.exit(0)
  })
}

process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
