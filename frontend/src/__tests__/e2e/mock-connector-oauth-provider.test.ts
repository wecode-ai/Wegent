/** @jest-environment node */

import { createHash } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import {
  CONNECTOR_OAUTH_TOOL_RESULT,
  handleConnectorOAuthRequest,
  resetConnectorOAuthProvider,
} from '../../../e2e/utils/mock-connector-oauth-provider'

describe('Connector OAuth HTTP protocol fixture', () => {
  let server: Server
  let url: string

  beforeAll(async () => {
    server = createServer((request, response) => {
      let body = ''
      request.setEncoding('utf8')
      request.on('data', chunk => (body += chunk))
      request.on('end', () => {
        if (!handleConnectorOAuthRequest(request, response, body)) {
          response.writeHead(404).end()
        }
      })
    })
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', resolve)
    })
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/connector-oauth`
  })

  beforeEach(() => resetConnectorOAuthProvider())

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close(error => (error ? reject(error) : resolve()))
    })
  })

  async function grant(): Promise<string> {
    const registered = await fetch(`${url}/register`, {
      method: 'POST',
      body: JSON.stringify({ redirect_uris: ['http://127.0.0.1/callback'] }),
    })
    expect(registered.status).toBe(201)
    const client = await registered.json()
    const verifier = 'protocol-fixture-verifier'
    const parameters = new URLSearchParams({
      client_id: client.client_id,
      redirect_uri: 'http://127.0.0.1/callback',
      code_challenge: createHash('sha256').update(verifier).digest('base64url'),
      state: 'fixture-state',
    })
    const consent = await fetch(`${url}/authorize?${parameters}`, { redirect: 'manual' })
    expect(consent.status).toBe(302)
    const callback = new URL(consent.headers.get('location')!)
    expect(callback.searchParams.get('state')).toBe('fixture-state')
    const exchange = await fetch(`${url}/token`, {
      method: 'POST',
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code: callback.searchParams.get('code')!,
        code_verifier: verifier,
        client_id: client.client_id,
      }),
    })
    expect(exchange.status).toBe(200)
    return (await exchange.json()).access_token
  }

  it('records the actual encoded path and query only for authenticated HTTP operations', async () => {
    const path = `${url}/mcp/records/a%2Fb?detail=full`
    expect((await fetch(path)).status).toBe(401)
    const token = await grant()
    const response = await fetch(path, { headers: { Authorization: `Bearer ${token}` } })
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      marker: CONNECTOR_OAUTH_TOOL_RESULT,
      method: 'GET',
      path: '/connector-oauth/mcp/records/a%2Fb',
      query: { detail: 'full' },
    })
    const state = await (await fetch(`${url}/_state`)).json()
    expect(state.httpCalls).toHaveLength(1)
    expect(state.toolCalls).toEqual([])
  })

  it('injects HTTP grant rejection without rejecting MCP traffic or recording a tool call', async () => {
    const token = await grant()
    const headers = { Authorization: `Bearer ${token}` }
    const control = await fetch(`${url}/_control`, {
      method: 'POST',
      body: JSON.stringify({ rejectHttp: true }),
    })
    expect(control.status).toBe(200)
    expect((await fetch(`${url}/mcp/records/record`, { headers })).status).toBe(401)
    const discovery = await fetch(`${url}/mcp`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    })
    expect(discovery.status).toBe(200)
    expect((await discovery.json()).result.tools).toHaveLength(2)
    expect((await (await fetch(`${url}/_state`)).json()).httpCalls).toEqual([])
    resetConnectorOAuthProvider()
    const reset = await (await fetch(`${url}/_state`)).json()
    expect(reset.rejectHttp).toBe(false)
    expect(reset.httpCalls).toEqual([])
  })

  it('routes legacy SSE replies to the advertised session, without accepting a POST handshake', async () => {
    const controller = new AbortController()
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
    try {
      const stream = await fetch(`${url}/sse`, { signal: controller.signal })
      expect(stream.status).toBe(200)
      expect(stream.headers.get('content-type')).toBe('text/event-stream')
      reader = stream.body!.getReader()
      const endpointEvent = new TextDecoder().decode((await reader.read()).value)
      expect(endpointEvent).toMatch(/^event: endpoint\n/)
      const target = new URL(
        endpointEvent
          .split('\n')
          .find(line => line.startsWith('data: '))!
          .slice(6),
        url
      )
      const posted = await fetch(target, {
        method: 'POST',
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 23,
          method: 'tools/call',
          params: { name: 'echo', arguments: { value: 'legacy' } },
        }),
      })
      expect(posted.status).toBe(202)
      const reply = new TextDecoder().decode((await reader.read()).value)
      expect(reply).toContain('event: message')
      expect(reply).toContain('"id":23')
      expect(reply).toContain(CONNECTOR_OAUTH_TOOL_RESULT)
      expect((await fetch(`${url}/sse`, { method: 'POST', body: '{}' })).status).toBe(405)
      const missing = await fetch(`${url}/sse/messages?session=missing`, {
        method: 'POST',
        body: '{}',
      })
      expect(missing.status).toBe(404)
      const state = await (await fetch(`${url}/_state`)).json()
      expect(state.toolCalls).toEqual([{ name: 'echo', arguments: { value: 'legacy' } }])
    } finally {
      await reader?.cancel()
      controller.abort()
    }
  })

  it('can return a successful empty MCP directory and restore the original surface', async () => {
    const token = await grant()
    const listing = async () => {
      const response = await fetch(`${url}/mcp`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
      })
      expect(response.status).toBe(200)
      return (await response.json()).result.tools
    }
    const removed = await fetch(`${url}/_control`, {
      method: 'POST',
      body: JSON.stringify({ toolNames: [] }),
    })
    expect(removed.status).toBe(200)
    expect(await listing()).toEqual([])
    const restored = await fetch(`${url}/_control`, {
      method: 'POST',
      body: JSON.stringify({ toolNames: ['echo'] }),
    })
    expect(restored.status).toBe(200)
    expect((await listing()).map((tool: { name: string }) => tool.name)).toEqual(['echo'])
  })
})
