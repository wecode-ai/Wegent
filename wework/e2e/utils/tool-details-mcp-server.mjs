import readline from 'node:readline'

const serverName = process.argv[2]

const toolsByServer = {
  node_repl: [
    {
      name: 'js',
      description: 'Run JavaScript in the persistent Node REPL.',
      inputSchema: {
        type: 'object',
        properties: {
          code: { type: 'string' },
        },
        required: ['code'],
      },
    },
  ],
  github__issues: [
    {
      name: 'get_issue_details',
      description: 'Get deterministic issue details for the Wework desktop E2E.',
      inputSchema: {
        type: 'object',
        properties: {
          owner: { type: 'string' },
          repo: { type: 'string' },
          issue_number: { type: 'number' },
        },
        required: ['owner', 'repo', 'issue_number'],
      },
    },
  ],
}

const tools = toolsByServer[serverName]
if (!tools) {
  throw new Error(`Unknown tool details MCP server: ${serverName}`)
}

function respond(id, result) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`)
}

function respondError(id, code, message) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } })}\n`)
}

function callTool(name, args) {
  if (serverName === 'node_repl' && name === 'js') {
    return {
      content: [{ type: 'text', text: "{ status: 'executed', result: 84 }" }],
      isError: false,
    }
  }
  if (serverName === 'github__issues' && name === 'get_issue_details') {
    const issue = {
      title: 'Tool detail verification',
      state: 'open',
      owner: args.owner,
      repo: args.repo,
      issue_number: args.issue_number,
    }
    return {
      content: [{ type: 'text', text: JSON.stringify(issue, null, 2) }],
      structuredContent: issue,
      isError: false,
    }
  }
  return null
}

const input = readline.createInterface({
  input: process.stdin,
  crlfDelay: Infinity,
})

input.on('line', line => {
  if (!line.trim()) return
  let request
  try {
    request = JSON.parse(line)
  } catch (error) {
    console.error(`[tool-details-mcp] Ignoring malformed JSON: ${String(error)}`)
    return
  }
  if (request === null || typeof request !== 'object' || Array.isArray(request)) return
  if (!('id' in request)) return

  if (request.method === 'initialize') {
    respond(request.id, {
      protocolVersion: '2025-06-18',
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: `wework-e2e-${serverName}`, version: '1.0.0' },
    })
    return
  }
  if (request.method === 'tools/list') {
    respond(request.id, { tools })
    return
  }
  if (request.method === 'tools/call') {
    const result = callTool(request.params?.name, request.params?.arguments ?? {})
    if (result) {
      respond(request.id, result)
    } else {
      respondError(request.id, -32601, `Unknown tool: ${request.params?.name}`)
    }
    return
  }
  respondError(request.id, -32601, `Unknown method: ${request.method}`)
})
