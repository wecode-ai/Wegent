// @vitest-environment node

import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { afterEach, expect, test, vi } from 'vitest'
import { waitForNativeFileHolder } from '../e2e/desktop/modules/native-file-holder.mjs'

function holder() {
  const child = new EventEmitter()
  child.pid = 42
  child.stdout = new PassThrough()
  child.stderr = new PassThrough()
  return child
}

afterEach(() => vi.useRealTimers())

test('readiness requires a complete native acknowledgement and releases its listeners', async () => {
  const child = holder()
  const ready = waitForNativeFileHolder(child)
  child.stdout.write('he')
  child.stdout.write('ld\r\n')
  await ready
  expect(child.listenerCount('close')).toBe(0)
  expect(child.listenerCount('error')).toBe(0)
  expect(child.stdout.listenerCount('data')).toBe(0)
  expect(child.stderr.listenerCount('data')).toBe(0)
})

test('a failed native process reports stderr immediately instead of waiting for the deadline', async () => {
  const child = holder()
  const ready = waitForNativeFileHolder(child)
  child.stderr.write('File open failed: path unavailable')
  const rejected = expect(ready).rejects.toThrow(
    'exited before readiness: code=1, signal=null; pid=42; stderr=File open failed: path unavailable'
  )
  child.emit('close', 1, null)
  await rejected
})

test('an early successful exit without a held handle still fails', async () => {
  const child = holder()
  const ready = waitForNativeFileHolder(child)
  const rejected = expect(ready).rejects.toThrow('exited before readiness: code=0')
  child.emit('close', 0, null)
  await rejected
})

test('a spawn error preserves its reason', async () => {
  const child = holder()
  const ready = waitForNativeFileHolder(child)
  const rejected = expect(ready).rejects.toThrow('failed to start: spawn ENOENT')
  child.emit('error', new Error('spawn ENOENT'))
  await rejected
})

test('an invalid acknowledgement never proves a handle was acquired', async () => {
  const child = holder()
  const ready = waitForNativeFileHolder(child)
  const rejected = expect(ready).rejects.toThrow('Invalid native holder acknowledgement')
  child.stdout.write('not-held\n')
  await rejected
})

test('the readiness deadline includes bounded stderr diagnostics', async () => {
  vi.useFakeTimers()
  const child = holder()
  const ready = waitForNativeFileHolder(child)
  child.stderr.write('x'.repeat(10_000))
  let settled = false
  const observed = ready.catch(error => {
    settled = true
    return error
  })
  await vi.advanceTimersByTimeAsync(29_999)
  expect(settled).toBe(false)
  await vi.advanceTimersByTimeAsync(1)
  const error = await observed
  expect(error.message).toContain('Native file holder did not start within 30000ms')
  expect(error.message.length).toBeLessThan(4300)
  expect(child.listenerCount('close')).toBe(0)
})
