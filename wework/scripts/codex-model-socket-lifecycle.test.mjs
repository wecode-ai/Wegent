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
