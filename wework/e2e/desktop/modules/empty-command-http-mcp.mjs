import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { writeFile } from 'node:fs/promises'

import { readRequestBody } from './response-protocol.mjs'

export async function startEmptyCommandHttpMcp(probePath) {
  let failure
  let calls = 0
  const server = createServer(async (request, response) => {
    try {
      assert.equal(request.url, '/mcp')
      if (request.method === 'GET') {
        response.writeHead(405).end()
        return
      }
      if (request.method === 'DELETE') {
        response.writeHead(200).end()
        return
      }
      assert.equal(request.method, 'POST')
      const message = await readRequestBody(request)
      if (message.id === undefined) {
        response.writeHead(202).end()
        return
      }
      const token = request.headers['x-test-token']
      assert.match(token, /^synthetic-mcp-secret-\d+$/)
      let result
      switch (message.method) {
        case 'initialize':
          result = {
            protocolVersion: message.params.protocolVersion,
            capabilities: { tools: {} },
            serverInfo: { name: 'empty-command-http', version: '1' },
          }
          break
        case 'tools/list':
          result = {
            tools: [
              {
                name: 'probe_environment',
                description: 'Read the current synthetic MCP context',
                inputSchema: { type: 'object', properties: {} },
              },
            ],
          }
          break
        case 'tools/call':
          assert.equal(message.params.name, 'probe_environment')
          await writeFile(probePath, JSON.stringify({ token, pid: process.pid }), { mode: 0o600 })
          calls++
          result = { content: [{ type: 'text', text: `MCP_CONTEXT:${token}` }] }
          break
        case 'resources/list':
          result = { resources: [] }
          break
        case 'resources/templates/list':
          result = { resourceTemplates: [] }
          break
        case 'ping':
          result = {}
          break
        default:
          throw new Error(`Unexpected MCP method: ${message.method}`)
      }
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }))
    } catch (error) {
      failure = error
      response.writeHead(500).end()
    }
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  return {
    config: {
      command: '',
      args: [],
      env: {},
      url: `http://127.0.0.1:${server.address().port}/mcp`,
      headers: { 'X-Test-Token': '${{auth_token}}' },
    },
    verify() {
      if (failure) throw failure
      assert.equal(calls, 3, 'Remote MCP must be called on initial and resumed turns')
    },
    async close() {
      server.closeAllConnections()
      await new Promise(resolve => server.close(resolve))
    },
  }
}
