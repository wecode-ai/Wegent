import assert from 'node:assert/strict'
import childProcess from 'node:child_process'
import { EventEmitter } from 'node:events'
import { afterEach, test, vi } from 'vitest'
import {
  processStatesFromDarwinPs,
  stopProcess,
  stopProcessGroup,
} from '../e2e/desktop/process-lifecycle.mjs'

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
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
  vi.spyOn(childProcess, 'execFileSync').mockImplementation(() =>
    isAlive() ? `${process.pid} ${process.pid} S\n` : ''
  )
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

function darwinProcessTable(read) {
  vi.stubGlobal('process', Object.create(process, { platform: { value: 'darwin' } }))
  vi.spyOn(childProcess, 'execFileSync').mockImplementation(read)
}

test('parses Darwin process state flags and rejects incomplete process tables', () => {
  assert.deepEqual(processStatesFromDarwinPs(' 42 42 Z+\n 43 42 S\n'), [
    { pid: 42, groupId: 42, state: 'Z+' },
    { pid: 43, groupId: 42, state: 'S' },
  ])
  assert.throws(() => processStatesFromDarwinPs('42 42'), /Invalid process state/)
})

test('recognizes an exited Darwin group before the child notification arrives', async () => {
  darwinProcessTable(() => '42 42 Z\n43 42 Z+\n')
  const kill = vi.spyOn(process, 'kill').mockImplementation(() => {
    throw Object.assign(new Error('kill EPERM'), { code: 'EPERM' })
  })
  const child = childWithoutExitNotification()
  child.pid = 42

  await stopProcessGroup(child)
  assert.equal(child.exitCode, null, 'The kernel state must suffice without an exit callback')
  assert.equal(kill.mock.calls.length, 0)
})

test('terminates a live descendant even when its Darwin group leader is a zombie', async () => {
  let stopped = false
  darwinProcessTable(() => `42 42 Z\n43 42 ${stopped ? 'Z' : 'S'}\n`)
  const kill = vi.spyOn(process, 'kill').mockImplementation(() => {
    stopped = true
    return true
  })
  const child = childWithoutExitNotification()
  child.pid = 42

  await stopProcessGroup(child)
  assert.deepEqual(kill.mock.calls, [[-42, 'SIGTERM']])
})

test('verifies the group has exited when it disappears between inspection and signaling', async () => {
  let stopped = false
  darwinProcessTable(() => `42 42 ${stopped ? 'Z' : 'S'}\n`)
  const kill = vi.spyOn(process, 'kill').mockImplementation(() => {
    stopped = true
    throw Object.assign(new Error('kill EPERM'), { code: 'EPERM' })
  })
  const child = childWithoutExitNotification()
  child.pid = 42

  await stopProcessGroup(child)
  assert.deepEqual(kill.mock.calls, [[-42, 'SIGTERM']])
})

test('preserves a real permission failure while the Darwin group is alive', async () => {
  darwinProcessTable(() => '42 42 S\n')
  const failure = Object.assign(new Error('kill EPERM'), { code: 'EPERM' })
  vi.spyOn(process, 'kill').mockImplementation(() => {
    throw failure
  })
  const child = childWithoutExitNotification()
  child.pid = 42

  await assert.rejects(stopProcessGroup(child), error => error === failure)
  assert.deepEqual(failure.processGroup, {
    processGroupId: 42,
    signal: 'SIGTERM',
    members: [{ pid: 42, groupId: 42, state: 'S' }],
  })
})

test('does not guess that a Darwin group exited when inspection fails', async () => {
  const failure = new Error('Process inspection failed')
  darwinProcessTable(() => {
    throw failure
  })
  const kill = vi.spyOn(process, 'kill')
  const child = childWithoutExitNotification()
  child.pid = 42

  await assert.rejects(stopProcessGroup(child), error => error === failure)
  assert.equal(kill.mock.calls.length, 0)
})

test('preserves an inspection error after termination instead of escalating blindly', async () => {
  const failure = new Error('Process inspection failed')
  let inspections = 0
  darwinProcessTable(() => {
    if (inspections++ === 0) return '42 42 S\n'
    throw failure
  })
  const kill = vi.spyOn(process, 'kill').mockReturnValue(true)
  const child = childWithoutExitNotification()
  child.pid = 42

  await assert.rejects(stopProcessGroup(child), error => error === failure)
  assert.deepEqual(kill.mock.calls, [[-42, 'SIGTERM']])
  assert.equal(child.listenerCount('exit'), 0)
})
