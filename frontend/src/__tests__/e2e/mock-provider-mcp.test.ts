/** @jest-environment node */

// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { createServer, type Server } from 'http'
import type { AddressInfo } from 'net'
import { handleProviderMcpHttpRequest } from '../../../e2e/utils/mock-provider-mcp'

describe('MCP import response gate', () => {
  let server: Server
  let url: string

  async function control(path: string, body: unknown = {}) {
    const response = await fetch(`${url}/mcp-control/${path}`, {
      method: 'POST',
      body: JSON.stringify(body),
    })
    expect(response.status).toBe(200)
    return response.json()
  }

  beforeAll(async () => {
    server = createServer((request, response) => {
      let body = ''
      request.on('data', chunk => (body += chunk.toString()))
      request.on('end', () => {
        if (!handleProviderMcpHttpRequest(request, response, body, 0)) {
          response.writeHead(404).end()
        }
      })
    })
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', resolve)
    })
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  })

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close(error => (error ? reject(error) : resolve()))
    })
  })

  it.each(['config', 'reset'])('holds the body until %s releases it', async releasePath => {
    await control('reset')
    let pending: Promise<Response> | undefined
    try {
      const configured = await control('config', { pausedContentNodeIds: ['imp-product'] })
      expect(configured.pausedContentNodeIds).toEqual(['imp-product'])
      pending = fetch(`${url}/mcp`, {
        method: 'POST',
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: { name: 'get_document_content', arguments: { nodeId: 'imp-product' } },
        }),
      })
      let waiting: string[] = []
      for (let attempt = 0; attempt < 100; attempt++) {
        waiting = (await control('config')).waitingContentNodeIds
        if (waiting.includes('imp-product')) break
        await new Promise(resolve => setTimeout(resolve, 10))
      }
      expect(waiting).toEqual(['imp-product'])
      expect(await (await fetch(`${url}/mcp-control/calls`)).json()).toEqual([])

      await control(releasePath, { pausedContentNodeIds: [] })
      const response = await pending
      expect(response.status).toBe(200)
      const body = await response.json()
      expect(JSON.parse(body.result.content[0].text).markdown).toContain('DINGTALK-PRODUCT-V1')
      const calls = await (await fetch(`${url}/mcp-control/calls`)).json()
      expect(calls).toEqual([
        expect.objectContaining({ name: 'get_document_content', isError: false }),
      ])
    } finally {
      await control('reset')
      await pending
    }
  })

  it.each([
    ['calls', 'GET'],
    ['config', 'POST'],
    ['reset', 'POST'],
  ])('closes the %s control connection after responding', async (path, method) => {
    const response = await fetch(`${url}/mcp-control/${path}`, {
      method,
      body: method === 'POST' ? '{}' : undefined,
    })

    expect(response.status).toBe(200)
    expect(response.headers.get('connection')).toBe('close')
  })

  it('keeps another worker gated, configured and recorded when one worker resets', async () => {
    const scopedControl = async (scope: string, path: string, body: unknown = {}) => {
      const response = await fetch(`${url}/e2e/${scope}/mcp-control/${path}`, {
        method: 'POST',
        body: JSON.stringify(body),
      })
      expect(response.status).toBe(200)
      return response.json()
    }
    const call = async (scope: string) => {
      const response = await fetch(`${url}/e2e/${scope}/mcp`, {
        method: 'POST',
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: { name: 'get_document_content', arguments: { nodeId: 'imp-product' } },
        }),
      })
      expect(response.status).toBe(200)
      return response.json()
    }
    let pending: Promise<unknown> | undefined
    try {
      await scopedControl('worker-b', 'config', {
        pausedContentNodeIds: ['imp-product'],
        documentContents: { 'imp-product': 'WORKER_B_CONTENT' },
      })
      // The real HTTP handler enters the content gate before its end observer runs.
      const received = new Promise<void>(resolve =>
        server.once('request', request => request.once('end', resolve))
      )
      pending = call('worker-b')
      await received
      await scopedControl('worker-a', 'config', { deniedNodeIds: ['imp-product'] })
      const denied = await call('worker-a')
      expect(denied.result.isError).toBe(true)
      await scopedControl('worker-a', 'reset')
      const state = await scopedControl('worker-b', 'config')
      expect(state.waitingContentNodeIds).toEqual(['imp-product'])
      expect(state.documentContents).toEqual({ 'imp-product': 'WORKER_B_CONTENT' })
      expect(await (await fetch(`${url}/e2e/worker-a/mcp-control/calls`)).json()).toEqual([])
      await scopedControl('worker-b', 'config', { pausedContentNodeIds: [] })
      const result = (await pending) as { result: { content: Array<{ text: string }> } }
      expect(result.result.content[0].text).toContain('WORKER_B_CONTENT')
      const calls = await (await fetch(`${url}/e2e/worker-b/mcp-control/calls`)).json()
      expect(calls).toHaveLength(1)
      expect(calls[0].isError).toBe(false)
    } finally {
      await scopedControl('worker-a', 'reset')
      await scopedControl('worker-b', 'reset')
      await pending
    }
  })
})
