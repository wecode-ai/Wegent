import { expect, test } from 'vitest'
import { verifyOverloadHistoryRace } from '../e2e/desktop/modules/overload-history-race.mjs'

function protocolFixture({
  turnId = 'failed-turn',
  status = 'done',
  running = true,
  error = null,
} = {}) {
  let nativeReleased = false
  let overloaded = false
  let now = 0
  const armed = new Map()
  const captures = {}
  const nativeGate = {
    async arm() {},
    async wait() {
      expect(overloaded).toBe(true)
      return { turnId: 'failed-turn', notification: 'turn/completed', status: 'failed' }
    },
    async release() {
      nativeReleased = true
    },
  }
  const gates = {
    async arm(rule) {
      armed.set(rule.id, rule)
    },
    async wait(id, kick) {
      if (id === 'recovered-terminal-history') {
        // A running native owner must not expose terminal history. The former
        // schedule deadlocked here while withholding the native failed frame.
        if (!nativeReleased) throw new Error('Native failure is still withheld')
        await kick()
        captures[id] = {
          capturedAt: ++now,
          value: { result: { running, turns: [{ id: turnId, status, error }] } },
        }
      } else {
        expect(armed.get(id).hold).toBe(true)
        captures[id] = { capturedAt: ++now }
      }
      return captures[id]
    },
    async read(id) {
      return captures[id]
    },
    async release(id) {
      if (id === 'recovered-terminal-history')
        expect(captures['live-recovery'].deliveredAt).toBeDefined()
      captures[id].deliveredAt = ++now
    },
    async save() {
      return captures
    },
  }
  const commands = []
  return {
    options: {
      gates,
      nativeGate,
      address: { taskId: 'task' },
      resultDir: '/unused',
      releaseOverload() {
        overloaded = true
      },
      control: {
        async command(...args) {
          commands.push(args)
        },
      },
    },
    captures,
    commands,
  }
}

test('delivers native failure before reading history and renderer recovery before the old response', async () => {
  const fixture = protocolFixture()
  await verifyOverloadHistoryRace(fixture.options)
  expect(fixture.commands).toEqual([['dispatchRuntimeEventLagged', 'body']])
  expect(fixture.captures['recovered-terminal-history'].capturedAt).toBeLessThan(
    fixture.captures['live-recovery'].deliveredAt
  )
  expect(fixture.captures['live-recovery'].deliveredAt).toBeLessThan(
    fixture.captures['recovered-terminal-history'].deliveredAt
  )
})

test.each([
  { turnId: 'another-turn' },
  { status: 'streaming' },
  { status: 'failed' },
  { running: false },
  { error: 'Model overloaded' },
])('rejects history that is not the actual failed native turn: %j', async options => {
  await expect(verifyOverloadHistoryRace(protocolFixture(options).options)).rejects.toThrow()
})
