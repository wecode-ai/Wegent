import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import { writeFile } from 'node:fs/promises'

import { readRequestBody } from './response-protocol.mjs'

export async function startEmptyCommandHttpMcp(probePath, { recordReceipts = false } = {}) {
  const receipts = []
  let failure
  let calls = 0
  const failures = { unauthorized: 0, startup: 0, invocation: 0 }
  const server = createServer(async (request, response) => {
    try {
      if (
        (request.method === 'GET' && request.url.startsWith('/.well-known/')) ||
        (request.method === 'POST' && request.url === '/register')
      ) {
        // Native OAuth discovery and registration are unavailable after a real 401.
        response.writeHead(404).end()
        return
      }
      if (request.url === '/unauthorized' || request.url === '/startup-error') {
        const unauthorized = request.url === '/unauthorized'
        failures[unauthorized ? 'unauthorized' : 'startup']++
        response.writeHead(unauthorized ? 401 : 503).end()
        return
      }
      assert.ok(
        ['/mcp', '/failed-call'].includes(request.url),
        `Unexpected MCP request path: ${request.url}`
      )
      const failedCall = request.url === '/failed-call'
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
      if (!failedCall) assert.match(token, /^synthetic-mcp-secret-\d+$/)
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
                name: failedCall ? 'fail_operation' : 'probe_environment',
                description: 'Read the current synthetic MCP context',
                inputSchema: { type: 'object', properties: {} },
              },
            ],
          }
          break
        case 'tools/call': {
          if (failedCall) {
            assert.equal(message.params.name, 'fail_operation')
            failures.invocation++
            result = {
              isError: true,
              content: [{ type: 'text', text: 'MCP_ISOLATION_CALL_FAILED' }],
            }
            break
          }
          assert.equal(message.params.name, 'probe_environment')
          await writeFile(probePath, JSON.stringify({ token, pid: process.pid }), { mode: 0o600 })
          calls++
          let text = `MCP_CONTEXT:${token}`
          if (recordReceipts) {
            const receipt = randomUUID()
            receipts.push({ token, receipt })
            text += `\nMCP_RECEIPT:${receipt}`
          }
          result = { content: [{ type: 'text', text }] }
          break
        }
        case 'resources/list':
          result = { resources: [] }
          break
        case 'resources/templates/list':
          result = { resourceTemplates: [] }
          break
        case 'ping':
          result = {}
          break
        case 'server/discover':
          response.writeHead(200, { 'content-type': 'application/json' })
          response.end(
            JSON.stringify({
              jsonrpc: '2.0',
              id: message.id,
              error: { code: -32601, message: 'Method not found' },
            })
          )
          return
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
  const base = `http://127.0.0.1:${server.address().port}`
  return {
    receipts,
    failureConfigs: {
      unauthorized: { url: `${base}/unauthorized`, required: true },
      startup: { url: `${base}/startup-error`, required: true },
      invocation: { url: `${base}/failed-call`, headers: { 'X-Test-Token': '${{auth_token}}' } },
    },
    verifyFailures() {
      if (failure) throw failure
      assert.ok(failures.unauthorized > 0, 'The real authorization failure was not exercised')
      assert.ok(failures.startup > 0, 'The real startup failure was not exercised')
      assert.equal(failures.invocation, 1, 'Failed business operations must not be replayed')
    },
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
