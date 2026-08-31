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
})
