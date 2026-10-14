import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test, vi } from 'vitest'
import { PreferencesStore } from '../host/preferences-store.js'
import { createInitialRuntimePreparation } from './initial-runtime-preparation.js'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((done, fail) => {
    resolve = done
    reject = fail
  })
  return { promise, resolve, reject }
}

test('starts preparation before its consumer and shares the pending initial attempt', async () => {
  const gate = deferred<object>()
  const prepare = vi.fn(() => gate.promise)
  const preparation = createInitialRuntimePreparation(prepare)
  expect(prepare).toHaveBeenCalledOnce()
  const first = preparation.take()
  const concurrent = preparation.take()
  expect(first).toBe(concurrent)
  const environment = {}
  gate.resolve(environment)
  expect(await first).toBe(environment)
  expect(prepare).toHaveBeenCalledOnce()
})

test('handles an unconsumed rejection immediately and preserves its identity at the gate', async () => {
  const originalError = new Error('synthetic migration failure')
  const prepare = vi.fn().mockRejectedValueOnce(originalError).mockResolvedValueOnce('retry')
  const preparation = createInitialRuntimePreparation(prepare)
  await expect(preparation.settled()).resolves.toBeUndefined()
  await expect(preparation.take()).rejects.toBe(originalError)
  expect(prepare).toHaveBeenCalledOnce()
  expect(await preparation.take()).toBe('retry')
  expect(prepare).toHaveBeenCalledTimes(2)
})

test('reprepares after a consumed success instead of retaining a permanent environment cache', async () => {
  const retryGate = deferred<string>()
  const prepare = vi
    .fn()
    .mockResolvedValueOnce('initial')
    .mockImplementation(() => retryGate.promise)
  const preparation = createInitialRuntimePreparation(prepare)
  expect(await preparation.take()).toBe('initial')
  const retry = preparation.take()
  const concurrent = preparation.take()
  expect(retry).toBe(concurrent)
  expect(prepare).toHaveBeenCalledTimes(2)
  retryGate.resolve('reprepared')
  expect(await retry).toBe('reprepared')
})

test('finishes pending migration writes before shutdown cleanup without consuming the attempt', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wework-initial-migration-'))
  const gate = deferred<void>()
  const marker = join(root, 'migration-complete')
  const prepare = vi.fn(async () => {
    await gate.promise
    await writeFile(marker, 'complete')
    return marker
  })
  const preparation = createInitialRuntimePreparation(prepare)
  const cleanup = vi.fn(async () => {
    expect(await readFile(marker, 'utf8')).toBe('complete')
    await rm(root, { recursive: true })
  })
  const shutdown = preparation.settled().then(cleanup)
  try {
    await Promise.resolve()
    expect(cleanup).not.toHaveBeenCalled()
    gate.resolve()
    await shutdown
    expect(cleanup).toHaveBeenCalledOnce()
    expect(await preparation.take()).toBe(marker)
    expect(prepare).toHaveBeenCalledOnce()
  } finally {
    gate.resolve()
    await shutdown
    await rm(root, { recursive: true, force: true })
  }
})

test('uses the same preferences store and preserves an explicit configured Node setting', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wework-initial-preferences-'))
  try {
    const preferences = new PreferencesStore(root)
    await preferences.update({ nodeExecutablePath: 'synthetic-configured-node' })
    const preparation = createInitialRuntimePreparation(() => preferences.read())
    const environment = await preparation.take()
    expect(environment.nodeExecutablePath).toBe('synthetic-configured-node')
    await preferences.update({ workbenchMode: 'developer' })
    expect(await preparation.take()).toEqual({
      nodeExecutablePath: 'synthetic-configured-node',
      workbenchMode: 'developer',
    })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('waits for retry migration writes before shutdown cleanup after an initial failure', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wework-retry-migration-'))
  const gate = deferred<void>()
  const marker = join(root, 'migration-complete')
  const originalError = new Error('synthetic initial migration failure')
  const prepare = vi
    .fn()
    .mockRejectedValueOnce(originalError)
    .mockImplementation(async () => {
      await gate.promise
      await writeFile(marker, 'complete')
      return marker
    })
  const preparation = createInitialRuntimePreparation(prepare)
  await expect(preparation.take()).rejects.toBe(originalError)
  const retry = preparation.take()
  const cleanup = vi.fn(async () => {
    expect(await readFile(marker, 'utf8')).toBe('complete')
    await rm(root, { recursive: true })
  })
  const shutdown = preparation.settled().then(cleanup)
  try {
    await Promise.resolve()
    expect(cleanup).not.toHaveBeenCalled()
    gate.resolve()
    expect(await retry).toBe(marker)
    await shutdown
    expect(cleanup).toHaveBeenCalledOnce()
    expect(prepare).toHaveBeenCalledTimes(2)
  } finally {
    gate.resolve()
    await retry
    await shutdown
    await rm(root, { recursive: true, force: true })
  }
})
