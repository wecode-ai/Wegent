/** @jest-environment node */

import { Agent, get, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'

describe('mock model control connections', () => {
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
})
