import { expect, test, vi } from 'vitest'
import { readAfterRuntimeTaskCreation, trackRuntimeTaskCreation } from './runtimeTaskCreation'

function deferred() {
  let resolve!: () => void
  let reject!: (error: unknown) => void
  const promise = new Promise<void>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}

test('optimistic readers wait for persistence without delaying independent tasks', async () => {
  const address = { deviceId: 'creation-device', taskId: 'pending' }
  const creation = deferred()
  expect(trackRuntimeTaskCreation(address, creation.promise)).toBe(creation.promise)
  const read = vi.fn(async () => 'result')
  const pending = readAfterRuntimeTaskCreation(address, read)
  await Promise.resolve()
  expect(read).not.toHaveBeenCalled()
  await expect(
    readAfterRuntimeTaskCreation({ ...address, taskId: 'existing' }, read)
  ).resolves.toBe('result')
  expect(read).toHaveBeenCalledOnce()
  creation.resolve()
  await expect(pending).resolves.toBe('result')
  expect(read).toHaveBeenCalledTimes(2)
})

test('departing views cancel their read while the primary creation continues', async () => {
  const address = { deviceId: 'creation-device', taskId: 'departed' }
  const creation = deferred()
  trackRuntimeTaskCreation(address, creation.promise)
  const controller = new AbortController()
  const read = vi.fn(async () => 'result')
  const pending = readAfterRuntimeTaskCreation(address, read, controller.signal)
  const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' })
  controller.abort()
  await rejected
  creation.resolve()
  await creation.promise
  expect(read).not.toHaveBeenCalled()
  await expect(readAfterRuntimeTaskCreation(address, read)).resolves.toBe('result')
})

test('failed creation does not dispatch a doomed read and later recovery remains readable', async () => {
  const address = { deviceId: 'creation-device', taskId: 'failed' }
  const creation = deferred()
  trackRuntimeTaskCreation(address, creation.promise)
  const read = vi.fn(async () => 'result')
  const pending = readAfterRuntimeTaskCreation(address, read)
  const failure = new Error('Create failed')
  const rejected = expect(pending).rejects.toBe(failure)
  creation.reject(failure)
  await rejected
  expect(read).not.toHaveBeenCalled()
  await expect(readAfterRuntimeTaskCreation(address, read)).resolves.toBe('result')
})
