// @vitest-environment node

import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { execFileSync } from 'node:child_process'
import { afterEach, test, vi } from 'vitest'
import {
  logDesktopE2eSignal,
  processGroupIsExitingFromDarwinRows,
  stopProcess,
  stopProcessGroup,
} from '../e2e/desktop/process-lifecycle.mjs'

vi.mock('node:child_process', async importOriginal => ({
  ...(await importOriginal()),
  execFileSync: vi.fn(),
}))

const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')
const originalGetUid = Object.getOwnPropertyDescriptor(process, 'getuid')

afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
  Object.defineProperty(process, 'platform', originalPlatform)
  if (originalGetUid) Object.defineProperty(process, 'getuid', originalGetUid)
  else delete process.getuid
})

function exitingDarwinGroup({ exits = true, state = '?Es' } = {}) {
  Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true })
  Object.defineProperty(process, 'getuid', { value: () => 501, configurable: true })
  const child = childWithoutExitNotification()
  child.pid = 17455
  const denied = Object.assign(new Error('kill EPERM'), { code: 'EPERM' })
  let alive = true
  if (exits)
    setTimeout(() => {
      alive = false
    }, 100)
  execFileSync.mockReturnValue(`17455 15043 17455 501 ${state}\n`)
  vi.spyOn(process, 'kill').mockImplementation((pid, signal) => {
    if (!alive) throw Object.assign(new Error('No process'), { code: 'ESRCH' })
    if (pid === -child.pid && signal !== 0) throw denied
    assert.equal(signal, 0, 'No real process may receive a signal')
    return true
  })
  return { child, denied }
}

test('waits for owned P_WEXIT members after a rejected macOS group signal', async () => {
  vi.useFakeTimers()
  const { child } = exitingDarwinGroup()
  const stopping = stopProcessGroup(child)
  await vi.advanceTimersByTimeAsync(200)
  await stopping
  assert.equal(child.listenerCount('exit'), 0)
  assert.equal(
    process.kill.mock.calls.some(([, signal]) => signal === 'SIGKILL'),
    false
  )
})

test('retains permission failures for a live macOS process group', async () => {
  vi.useFakeTimers()
  const { child, denied } = exitingDarwinGroup({ state: 'S' })
  await assert.rejects(stopProcessGroup(child), error => error === denied)
})

test('waits for the observed owned zombie leader and P_WEXIT descendant to disappear', async () => {
  vi.useFakeTimers()
  const { child } = exitingDarwinGroup()
  execFileSync.mockReturnValue('17455 15043 17455 501 Z\n17456 1 17455 501 ?E\n')
  const stopping = stopProcessGroup(child)
  await vi.advanceTimersByTimeAsync(200)
  await stopping
  assert.equal(child.listenerCount('exit'), 0)
  assert.equal(
    process.kill.mock.calls.some(([, signal]) => signal === 'SIGKILL'),
    false
  )
})

test.each(['?Es', 'Z'])(
  'retains the existing exit deadline when %s never completes',
  async state => {
    vi.useFakeTimers()
    const { child } = exitingDarwinGroup({ exits: false, state })
    const stopping = stopProcessGroup(child).then(
      () => null,
      error => error
    )
    await vi.advanceTimersByTimeAsync(21_000)
    assert.match((await stopping).message, /Timed out waiting for process 17455 to exit/)
  }
)

test('recognizes only an absent group or owned macOS processes already exiting', () => {
  const exiting = ['17455', '15043', '17455', '501', '?Es']
  assert.equal(processGroupIsExitingFromDarwinRows([exiting], 501), true)
  assert.equal(processGroupIsExitingFromDarwinRows([], 501), true)
  const zombie = ['17456', '15043', '17455', '501', 'Z']
  assert.equal(processGroupIsExitingFromDarwinRows([exiting, zombie], 501), true)
  assert.equal(processGroupIsExitingFromDarwinRows([zombie], 0), false)
  for (const state of ['S', 'R', '?', 'T', 'U']) {
    assert.equal(
      processGroupIsExitingFromDarwinRows([exiting, [...exiting.slice(0, 4), state]], 501),
      false,
      `A group containing a non-exiting process (${state}) must not suppress EPERM`
    )
  }
  assert.equal(processGroupIsExitingFromDarwinRows([exiting], 0), false)
  assert.equal(processGroupIsExitingFromDarwinRows([exiting], undefined), false)
  assert.equal(processGroupIsExitingFromDarwinRows({ error: 'ETIMEDOUT' }, 501), false)
  assert.equal(processGroupIsExitingFromDarwinRows([exiting.slice(0, 4)], 501), false)
})

function childWithoutExitNotification() {
  return Object.assign(new EventEmitter(), {
    pid: process.pid,
    exitCode: null,
    signalCode: null,
    kill: vi.fn(),
  })
}

function observeLiveness(isAlive) {
  vi.spyOn(process, 'kill').mockImplementation((_pid, signal) => {
    assert.equal(signal, 0, 'The test must never signal a real process')
    if (!isAlive()) throw Object.assign(new Error('No process'), { code: 'ESRCH' })
    return true
  })
}

test('accepts kernel exit even when the child exit event has not arrived', async () => {
  vi.useFakeTimers()
  const child = childWithoutExitNotification()
  observeLiveness(() => false)
  const stopping = stopProcess(child).then(
    () => null,
    error => error
  )
  await vi.advanceTimersByTimeAsync(20_000)
  assert.equal(await stopping, null)
  assert.equal(child.listenerCount('exit'), 0)
})

test('waits for forced termination and observes it without an exit notification', async () => {
  vi.useFakeTimers()
  const child = childWithoutExitNotification()
  let alive = true
  child.kill.mockImplementation(signal => {
    if (signal === 'SIGKILL') alive = false
  })
  observeLiveness(() => alive)
  const stopping = stopProcess(child).then(
    () => null,
    error => error
  )
  await vi.advanceTimersByTimeAsync(20_000)
  assert.equal(await stopping, null)
  assert.deepEqual(child.kill.mock.calls, [['SIGTERM'], ['SIGKILL']])
  assert.equal(child.listenerCount('exit'), 0)
})

test('still fails when the process remains alive after forced termination', async () => {
  vi.useFakeTimers()
  const child = childWithoutExitNotification()
  observeLiveness(() => true)
  const stopping = stopProcess(child).then(
    () => null,
    error => error
  )
  await vi.advanceTimersByTimeAsync(20_000)
  assert.match((await stopping).message, /Timed out waiting for process/)
  assert.deepEqual(child.kill.mock.calls, [['SIGTERM'], ['SIGKILL']])
  assert.equal(child.listenerCount('exit'), 0)
})

function observedSignalLogs() {
  const lines = []
  const log = vi.spyOn(console, 'log').mockImplementation(value => {
    lines.push(value)
  })
  return {
    lines,
    records() {
      return lines
        .filter(line => String(line).startsWith('[desktop-e2e-signal] '))
        .map(line => JSON.parse(String(line).slice('[desktop-e2e-signal] '.length)))
    },
  }
}

test('logs every signal delivered while stopping a process', async () => {
  vi.useFakeTimers()
  const child = childWithoutExitNotification()
  let alive = true
  child.kill.mockImplementation(signal => {
    if (signal === 'SIGKILL') alive = false
  })
  observeLiveness(() => alive)
  const observation = observedSignalLogs()
  const stopping = stopProcess(child).then(
    () => null,
    error => error
  )
  await vi.advanceTimersByTimeAsync(20_000)
  assert.equal(await stopping, null)
  const records = observation.records()
  assert.deepEqual(
    records.map(record => ({ action: record.action, pid: record.pid, signal: record.signal })),
    [
      { action: 'stop-process', pid: process.pid, signal: 'SIGTERM' },
      { action: 'stop-process', pid: process.pid, signal: 'SIGKILL' },
    ]
  )
  for (const record of records) {
    assert.match(record.at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/)
  }
})

test('signal log records stay single-line JSON with an embedded timestamp', () => {
  const observation = observedSignalLogs()
  logDesktopE2eSignal({ action: 'signal-group', processGroupId: 42, signal: 'SIGTERM' })
  const record = observation.records()[0]
  assert.equal(record.action, 'signal-group')
  assert.equal(record.processGroupId, 42)
  assert.equal(record.signal, 'SIGTERM')
  assert.match(record.at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
})
