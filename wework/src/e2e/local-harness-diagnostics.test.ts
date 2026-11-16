// @vitest-environment node

import { afterEach, expect, test, vi } from 'vitest'
import {
  resetDshTerminalTransportForTests,
  subscribeDshTerminalEvents,
} from '@/api/dsh/terminalTransport'
import {
  collectLocalHarnessDiagnostics,
  installLocalHarnessDiagnostics,
} from './local-harness-diagnostics'

vi.mock('@/lib/local-terminal', () => ({
  listLocalHarnessSessions: async () => [
    { session_id: 'terminal-1', harness_id: 'codex', active: false },
  ],
  getLocalTerminalSnapshot: async () => ({ sequence: 2, running: false, data: 'ready' }),
}))

afterEach(() => {
  resetDshTerminalTransportForTests()
  vi.unstubAllGlobals()
})

test('diagnostics observe terminal history without owning an event connection', async () => {
  const sources: FakeEventSource[] = []
  vi.stubGlobal(
    'EventSource',
    class extends FakeEventSource {
      constructor(url: string) {
        super(url)
        sources.push(this)
      }
    }
  )

  installLocalHarnessDiagnostics()
  installLocalHarnessDiagnostics()
  expect(sources).toHaveLength(0)

  const listener = vi.fn()
  const unsubscribe = subscribeDshTerminalEvents(listener)
  expect(sources).toHaveLength(1)
  const output = {
    protocolVersion: 1,
    sequence: 1,
    emittedAt: '2026-11-02T12:00:00.000Z',
    event: 'terminal.output',
    payload: { session_id: 'terminal-1', data: 'ready' },
  }
  sources[0].onmessage?.(new MessageEvent('message', { data: JSON.stringify(output) }))
  expect(listener.mock.calls.map(([event]) => event)).toEqual([output])
  expect(await collectLocalHarnessDiagnostics()).toEqual([
    {
      sessionId: 'terminal-1',
      harnessId: 'codex',
      active: false,
      history: { output: 'ready' },
      terminal: { sequence: 2, running: false, output: 'ready' },
    },
  ])

  unsubscribe()
  expect(sources[0].closed).toBe(true)
  const unsubscribeAgain = subscribeDshTerminalEvents(listener)
  expect(sources).toHaveLength(2)
  expect(sources[1].url).toBe('/wework/terminal/v1/events?after=1')
  const later = { ...output, sequence: 2, payload: { ...output.payload, data: ' later' } }
  sources[1].onmessage?.(new MessageEvent('message', { data: JSON.stringify(later) }))
  const exit = {
    ...output,
    sequence: 3,
    event: 'terminal.exit',
    payload: { session_id: 'terminal-1', exit_code: 0, signal: null },
  }
  sources[1].onmessage?.(new MessageEvent('message', { data: JSON.stringify(exit) }))
  expect(listener.mock.calls.map(([event]) => event)).toEqual([output, later, exit])
  expect((await collectLocalHarnessDiagnostics())[0].history).toEqual({
    output: 'ready later',
    exit: { emittedAt: exit.emittedAt, code: 0, signal: null },
  })
  unsubscribeAgain()
  expect(sources[1].closed).toBe(true)
})

class FakeEventSource {
  onmessage: ((event: MessageEvent) => void) | null = null
  onerror: (() => void) | null = null
  closed = false

  constructor(readonly url: string) {}

  close() {
    this.closed = true
  }
}
