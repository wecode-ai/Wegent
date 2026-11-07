/** @jest-environment node */

import { once } from 'node:events'
import {
  Agent,
  get,
  request,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http'
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

  it('preserves UTF-8 split across HTTP chunks through rules and model output', async () => {
    const matchText = 'fragmented-utf8'
    const responseContent = 'before中 between😀 after'
    const rule = { matchText, responseContent, chunkDelayMs: 0 }
    const body = Buffer.from(JSON.stringify(rule))
    const splitAt = [body.indexOf(Buffer.from('中')) + 1, body.indexOf(Buffer.from('😀')) + 2]
    const chunks = [
      body.subarray(0, splitAt[0]),
      body.subarray(splitAt[0], splitAt[1]),
      body.subarray(splitAt[1]),
    ]
    const received = new Promise<IncomingMessage>(resolve => {
      server.once('request', incoming => resolve(incoming))
    })
    const client = request(`${url}/stream-rules`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    })
    const response = new Promise<{ status?: number; body: string }>((resolve, reject) => {
      client.on('error', reject)
      client.on('response', incoming => {
        let text = ''
        incoming.setEncoding('utf8')
        incoming.on('data', chunk => (text += chunk))
        incoming.on('error', reject)
        incoming.on('end', () => resolve({ status: incoming.statusCode, body: text }))
      })
    })
    try {
      client.flushHeaders()
      const incoming = await received
      for (const chunk of chunks) {
        const observed = once(incoming, 'data')
        client.write(chunk)
        await observed
      }
      client.end()
      const saved = await response
      expect(saved.status).toBe(200)
      expect(JSON.parse(saved.body).rule).toEqual(rule)

      const stream = await modelRequest(matchText).result
      const output = stream
        .split('\n')
        .filter(line => line.startsWith('data: '))
        .map(line => JSON.parse(line.slice(6)))
        .filter(event => event.type === 'content_block_delta')
        .map(event => event.delta.text)
        .join('')
      expect(output).toBe(responseContent)
    } finally {
      client.destroy()
    }
  })

  async function hold(matchText: string) {
    await post('/stream-rules', {
      matchText,
      responseContent: `ANSWER_${matchText}`,
      chunkDelayMs: 0,
      holdResponse: true,
    })
  }

  async function pendingResponses(matchText: string) {
    const response = await fetch(`${url}/stream-rules`)
    expect(response.status).toBe(200)
    const rules = (await response.json()) as Array<{ matchText: string; pendingResponses: number }>
    return rules.find(rule => rule.matchText === matchText)?.pendingResponses
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
      expect(await pendingResponses(matchText)).toBe(1)

      expect(await post('/stream-rules/release', { matchText })).toEqual({ released: 1 })
      expect(await pendingResponses(matchText)).toBe(0)
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
    expect(await pendingResponses(matchText)).toBe(1)
    const closed = once(response, 'close')
    const rejected = expect(pending.result).rejects.toMatchObject({ name: 'AbortError' })
    pending.controller.abort()
    await rejected
    await closed
    expect(await pendingResponses(matchText)).toBe(0)
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

  it('isolates identical model rules, gates, scenario counters and request records across workers', async () => {
    const a = '/e2e/worker-a'
    const b = '/e2e/worker-b'
    let pending: ReturnType<typeof modelRequest> | undefined
    try {
      await post(`${a}/stream-rules`, {
        matchText: 'same-prompt',
        responseContent: 'WORKER_A',
        chunkDelayMs: 0,
      })
      await post(`${b}/stream-rules`, {
        matchText: 'same-prompt',
        responseContent: 'WORKER_B',
        chunkDelayMs: 0,
        holdResponse: true,
      })
      pending = modelRequest('same-prompt', `${b}/v1/messages`)
      await pending.received
      expect(await modelRequest('same-prompt', `${a}/v1/messages`).result).toContain('WORKER_A')
      await (await fetch(`${url}${a}/stream-rules`, { method: 'DELETE' })).json()
      await post(`${a}/clear-requests`, {})
      expect(pending.finished()).toBe(false)
      const records = await (await fetch(`${url}${b}/captured-requests`)).json()
      expect(
        records.filter((record: { url: string }) => record.url === '/v1/messages')
      ).toHaveLength(1)
      expect(await post(`${b}/stream-rules/release`, { matchText: 'same-prompt' })).toEqual({
        released: 1,
      })
      expect(await pending.result).toContain('WORKER_B')
      for (const [scope, answer] of [
        [a, 'SCENARIO_A'],
        [b, 'SCENARIO_B'],
      ]) {
        await post(`${scope}/tool-scenarios`, {
          matchText: 'same-scenario',
          steps: [{ responseContent: answer }],
        })
      }
      expect(await modelRequest('same-scenario', `${a}/v1/messages`).result).toContain('SCENARIO_A')
      const untouched = await (
        await fetch(`${url}${b}/tool-scenarios?matchText=same-scenario`)
      ).json()
      expect(untouched.nextStep).toBe(0)
      expect(untouched.capturedRequests).toEqual([])
      expect(await modelRequest('same-scenario', `${b}/v1/messages`).result).toContain('SCENARIO_B')
      await post(`${a}/claude-background-scenarios`, { model: 'same-model', mode: 'stop' })
      await post(`${b}/claude-background-scenarios`, { model: 'same-model', mode: 'complete' })
      await (
        await fetch(`${url}${a}/claude-background-scenarios?model=same-model`, { method: 'DELETE' })
      ).json()
      const background = await (
        await fetch(`${url}${b}/claude-background-scenarios?model=same-model`)
      ).json()
      expect(background.mode).toBe('complete')
    } finally {
      for (const scope of [a, b]) {
        await (await fetch(`${url}${scope}/stream-rules`, { method: 'DELETE' })).json()
        await (await fetch(`${url}${scope}/tool-scenarios`, { method: 'DELETE' })).json()
        await post(`${scope}/clear-requests`, {})
        await (
          await fetch(`${url}${scope}/claude-background-scenarios?model=same-model`, {
            method: 'DELETE',
          })
        ).json()
      }
      await pending?.result
    }
  })
})
