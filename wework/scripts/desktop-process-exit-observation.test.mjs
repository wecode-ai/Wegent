// @vitest-environment node

import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { afterEach, test, vi } from 'vitest'
import { logDesktopE2eSignal, stopProcess } from '../e2e/desktop/process-lifecycle.mjs'

afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
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
