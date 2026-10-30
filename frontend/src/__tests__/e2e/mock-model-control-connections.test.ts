/** @jest-environment node */

import { once } from 'node:events'
import { Agent, get, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'

describe('mock model controls', () => {
  let server: Server
  let url: string
  const agent = new Agent({ keepAlive: true })
  const previousPort = process.env.MOCK_MODEL_PORT
  const previousInterruptListeners = new Set(process.listeners('SIGINT'))
  let log: jest.SpyInstance

  beforeAll(async () => {
    process.env.MOCK_MODEL_PORT = '0'
    log = jest.spyOn(console, 'log').mockImplementation(() => {})
    ;({ server } = await import('../../../e2e/utils/mock-model-server'))
    if (!server.listening) {
      await new Promise<void>(resolve => server.once('listening', resolve))
    }
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  })

  afterEach(async () => {
    const response = await fetch(`${url}/stream-rules`, { method: 'DELETE' })
    await response.json()
  })

  afterAll(async () => {
    agent.destroy()
    await new Promise<void>((resolve, reject) => {
      server.close(error => (error ? reject(error) : resolve()))
    })
    for (const listener of process.listeners('SIGINT')) {
      if (!previousInterruptListeners.has(listener)) process.removeListener('SIGINT', listener)
    }
    if (previousPort === undefined) delete process.env.MOCK_MODEL_PORT
    else process.env.MOCK_MODEL_PORT = previousPort
    log.mockRestore()
  })

  it.each([
    ['/health', 200],
    ['/captured-requests', 200],
    ['/clear-requests', 200],
    ['/stream-rules', 200],
    ['/stream-rules/release', 404],
    ['/tool-scenarios?matchText=missing', 404],
  ])(
    'closes %s after responding so the client cannot reuse an expired socket',
    async (path, status) => {
      const response = await new Promise<{ status?: number; connection?: string }>(
        (resolve, reject) => {
          get(`${url}${path}`, { agent }, result => {
            result.resume()
            result.on('end', () =>
              resolve({ status: result.statusCode, connection: result.headers.connection })
            )
          }).on('error', reject)
        }
      )

      expect(response).toEqual({ status, connection: 'close' })
      expect(Object.values(agent.freeSockets).flat()).toHaveLength(0)
    }
  )

  async function post(path: string, data: unknown) {
    const response = await fetch(`${url}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    })
    expect(response.status).toBe(200)
    return response.json()
  }

  async function hold(matchText: string) {
    await post('/stream-rules', {
      matchText,
      responseContent: `ANSWER_${matchText}`,
      chunkDelayMs: 0,
      holdResponse: true,
    })
  }

  function modelRequest(matchText: string, path = '/v1/messages') {
    // The server's end handler enters the gate before this observer runs.
    const received = new Promise<ServerResponse>(resolve => {
      server.once('request', (request, response) => {
        request.once('end', () => resolve(response))
      })
    })
    const controller = new AbortController()
    let finished = false
    const result = fetch(`${url}${path}`, {
      method: 'POST',
      signal: controller.signal,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'mock-model',
        stream: true,
        messages: [{ role: 'user', content: matchText }],
        input: matchText,
      }),
    }).then(async response => {
      const text = await response.text()
      finished = true
      expect(response.status).toBe(200)
      return text
    })
    return { received, result, controller, finished: () => finished }
  }

  it.each(['/v1/messages', '/v1/responses', '/v1/chat/completions'])(
    'holds %s until explicit release and lets later pipeline stages finish',
    async path => {
      const matchText = `held-${path}`
      await hold(matchText)
      const pending = modelRequest(matchText, path)
      await pending.received
      expect(pending.finished()).toBe(false)

      expect(await post('/stream-rules/release', { matchText })).toEqual({ released: 1 })
      expect(await pending.result).toContain(`ANSWER_${matchText}`)
      expect(await modelRequest(matchText, path).result).toContain(`ANSWER_${matchText}`)
      expect(await post('/stream-rules/release', { matchText })).toEqual({ released: 0 })
    }
  )

  it('remembers release before a model request arrives', async () => {
    const matchText = 'release-before-request'
    await hold(matchText)
    expect(await post('/stream-rules/release', { matchText })).toEqual({ released: 0 })
    expect(await modelRequest(matchText).result).toContain(`ANSWER_${matchText}`)
  })

  it('removes a cancelled request from the gate', async () => {
    const matchText = 'cancelled-request'
    await hold(matchText)
    const pending = modelRequest(matchText)
    const response = await pending.received
    const closed = once(response, 'close')
    const rejected = expect(pending.result).rejects.toMatchObject({ name: 'AbortError' })
    pending.controller.abort()
    await rejected
    await closed
    expect(await post('/stream-rules/release', { matchText })).toEqual({ released: 0 })
  })

  it.each(['replace', 'delete', 'clear-all'])(
    '%s releases pending requests without changing their captured response rule',
    async action => {
      const matchText = `cleanup-${action}`
      await hold(matchText)
      const pending = modelRequest(matchText)
      await pending.received
      if (action === 'replace') {
        await post('/stream-rules', { matchText, responseContent: 'REPLACED' })
      } else {
        const query = action === 'delete' ? `?matchText=${matchText}` : ''
        const response = await fetch(`${url}/stream-rules${query}`, { method: 'DELETE' })
        expect(response.status).toBe(200)
        await response.json()
      }
      expect(await pending.result).toContain(`ANSWER_${matchText}`)
      const released = await fetch(`${url}/stream-rules/release`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ matchText }),
      })
      expect(released.status).toBe(404)
      await released.json()
      if (action === 'replace') {
        expect(await modelRequest(matchText).result).toContain('REPLACED')
      }
    }
  )
})
