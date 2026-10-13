import { EventEmitter } from 'node:events'
import { afterEach, expect, test, vi } from 'vitest'
import { createDesktopScenario } from '../e2e/desktop/scenarios/codex-invalid-launch-cwd.scenario.mjs'

afterEach(() => vi.unstubAllEnvs())

test('records peer resets without crashing while preserving unexpected transport failures', () => {
  vi.stubEnv('WEWORK_E2E_MODEL_SERVER_PORT', '12345')
  const scenario = createDesktopScenario({ resultDir: '/fixture' })
  const server = new EventEmitter()
  scenario.attachServer(server)
  const socket = new EventEmitter()
  socket.destroy = vi.fn()
  server.emit('upgrade', { url: '/unrelated' }, socket, Buffer.alloc(0))

  socket.emit('error', Object.assign(new Error('peer closed'), { code: 'ECONNRESET' }))
  expect(scenario.diagnostics()).toEqual({
    requestCount: 0,
    connectionResets: [{ code: 'ECONNRESET', at: expect.any(String) }],
  })
  expect(socket.destroy).toHaveBeenCalled()
  const unexpected = Object.assign(new Error('unexpected'), { code: 'EIO' })
  expect(() => socket.emit('error', unexpected)).toThrow(unexpected)
})

test('propagates model socket resets before scenario verification completes', () => {
  vi.stubEnv('WEWORK_E2E_MODEL_SERVER_PORT', '12345')
  const scenario = createDesktopScenario({ resultDir: '/fixture' })
  const server = new EventEmitter()
  const onError = vi.fn()
  server.on('error', onError)
  scenario.attachServer(server)
  const socket = new EventEmitter()
  socket.destroy = vi.fn()
  socket.write = vi.fn()
  server.emit(
    'upgrade',
    { url: '/v1/responses', headers: { 'sec-websocket-key': 'fixture-key' } },
    socket,
    Buffer.alloc(0)
  )

  const peerReset = Object.assign(new Error('peer closed'), { code: 'ECONNRESET' })
  socket.emit('error', peerReset)

  expect(onError).toHaveBeenCalledExactlyOnceWith(peerReset)
  expect(scenario.diagnostics()).toEqual({
    requestCount: 0,
    connectionResets: [{ code: 'ECONNRESET', at: expect.any(String) }],
  })
  expect(socket.destroy).toHaveBeenCalled()
  scenario.close()
})
