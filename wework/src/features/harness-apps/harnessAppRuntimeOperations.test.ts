import { describe, expect, test, vi } from 'vitest'
import { runHarnessAppRuntimeOperation } from './harnessAppRuntimeOperations'

describe('Harness app runtime operations', () => {
  test('serializes token handoff, close and reopen for one installation', async () => {
    let release: () => void = () => {}
    const handoff = runHarnessAppRuntimeOperation(
      'serialized-app',
      () =>
        new Promise<void>(resolve => {
          release = resolve
        })
    )
    const close = vi.fn().mockResolvedValue(undefined)
    const reopen = vi.fn().mockResolvedValue('running')
    const stopped = runHarnessAppRuntimeOperation('serialized-app', close)
    const restarted = runHarnessAppRuntimeOperation('serialized-app', reopen)
    await Promise.resolve()
    try {
      expect(close).not.toHaveBeenCalled()
      expect(reopen).not.toHaveBeenCalled()
    } finally {
      release()
      await handoff
      await stopped
      await restarted
    }
    expect(close.mock.invocationCallOrder[0]).toBeLessThan(reopen.mock.invocationCallOrder[0]!)
    await expect(restarted).resolves.toBe('running')
  })

  test('preserves errors without blocking later operations or other installations', async () => {
    let reject: (error: Error) => void = () => {}
    const failure = new Error('Start failed')
    const first = runHarnessAppRuntimeOperation(
      'failed-app',
      () =>
        new Promise<void>((_, rejectOperation) => {
          reject = rejectOperation
        })
    )
    const rejection = expect(first).rejects.toBe(failure)
    const next = vi.fn().mockResolvedValue('reopened')
    const later = runHarnessAppRuntimeOperation('failed-app', next)
    try {
      await expect(
        runHarnessAppRuntimeOperation('independent-app', async () => 'running')
      ).resolves.toBe('running')
      expect(next).not.toHaveBeenCalled()
    } finally {
      reject(failure)
      await rejection
    }
    await expect(later).resolves.toBe('reopened')
  })
})
