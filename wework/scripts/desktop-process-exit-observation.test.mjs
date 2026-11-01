import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { afterEach, test, vi } from 'vitest'
import { stopProcess } from '../e2e/desktop/process-lifecycle.mjs'

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
