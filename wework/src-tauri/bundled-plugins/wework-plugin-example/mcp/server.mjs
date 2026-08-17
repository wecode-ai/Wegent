#!/usr/bin/env node

import readline from 'node:readline'

const input = readline.createInterface({ input: process.stdin })

function respond(id, result) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`)
}

input.on('line', line => {
  let request
  try {
    request = JSON.parse(line)
  } catch {
    return
  }

  if (request.method === 'initialize') {
    respond(request.id, {
      protocolVersion: '2025-06-18',
      capabilities: { tools: {} },
      serverInfo: { name: 'wework-plugin-example', version: '0.1.0' },
    })
    return
  }
  if (request.method === 'tools/list') {
    respond(request.id, {
      tools: [
        {
          name: 'hello_wework',
          description: 'Return a greeting from the Wework plugin example.',
          inputSchema: {
            type: 'object',
            properties: { name: { type: 'string' } },
          },
        },
      ],
    })
    return
  }
  if (request.method === 'tools/call') {
    const name = request.params?.arguments?.name || 'Wework user'
    respond(request.id, {
      content: [{ type: 'text', text: `Hello, ${name}!` }],
    })
  }
})
