/** @jest-environment node */

import { createServer, type Server } from 'http'
import type { AddressInfo } from 'net'
import { handleEmbeddingRequest } from '../../../e2e/utils/mock-embedding'

describe('E2E embedding HTTP boundary', () => {
  let server: Server
  let url: string

  beforeAll(async () => {
    server = createServer((request, response) => {
      let body = ''
      request.on('data', chunk => {
        body += chunk.toString()
      })
      request.on('end', () => {
        if (!handleEmbeddingRequest(request, response, body)) {
          response.writeHead(404).end()
        }
      })
    })
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', resolve)
    })
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/embeddings`
  })

  afterAll(async () => {
    if (!server?.listening) return
    await new Promise<void>((resolve, reject) =>
      server.close(error => (error ? reject(error) : resolve()))
    )
  })

  it('returns deterministic, input-dependent OpenAI-compatible vectors', async () => {
    const payload = {
      model: 'text-embedding-3-small',
      input: ['产品说明', '接口规范'],
      dimensions: 32,
    }
    const first = await fetch(url, { method: 'POST', body: JSON.stringify(payload) })
    expect(first.status).toBe(200)
    const result = await first.json()
    expect(result.object).toBe('list')
    expect(result.data).toHaveLength(2)
    expect(result.data[0]).toMatchObject({ index: 0, object: 'embedding' })
    expect(result.data[0].embedding).toHaveLength(32)
    expect(result.data[0].embedding.every(Number.isFinite)).toBe(true)
    expect(result.data[0].embedding).not.toEqual(result.data[1].embedding)
    const second = await fetch(url, { method: 'POST', body: JSON.stringify(payload) })
    expect((await second.json()).data).toEqual(result.data)
  })

  it('rejects invalid input rather than returning fake success', async () => {
    const result = await fetch(url, { method: 'POST', body: JSON.stringify({ input: [] }) })
    expect(result.status).toBe(400)
  })
})
