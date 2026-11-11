import { describe, expect, test, vi } from 'vitest'
import {
  DesktopPreferencesController,
  resolvePopoutShortcut,
} from './desktop-preferences-controller.js'

function fixture(initial: Record<string, unknown> = {}) {
  let preferences = initial
  const store = {
    read: vi.fn(async () => preferences),
    readSnapshot: vi.fn(async () => ({ preferences, readable: true })),
    update: vi.fn(async (patch: Record<string, unknown>) => {
      preferences = { ...preferences, ...patch }
      return preferences
    }),
  }
  const effects = {
    isShuttingDown: vi.fn(() => false),
    configurePopoutShortcut: vi.fn(),
    setPerformanceRecordingEnabled: vi.fn<(_enabled: boolean) => Promise<void>>(
      async () => undefined
    ),
  }
  return { store, effects, controller: new DesktopPreferencesController(store, effects) }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: Error) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

describe('DesktopPreferencesController', () => {
  test('leaves active desktop effects unchanged when preferences cannot be read', async () => {
    const { controller, store, effects } = fixture({ popoutWindowShortcut: 'Ctrl+Alt+P' })
    store.readSnapshot.mockResolvedValueOnce({ preferences: {}, readable: false })
    await expect(controller.update({ popoutWindowShortcut: 'Ctrl+Alt+Q' })).rejects.toThrow(
      'unreadable'
    )
    expect(effects.configurePopoutShortcut).not.toHaveBeenCalled()
    expect(effects.setPerformanceRecordingEnabled).not.toHaveBeenCalled()
    expect(store.update).not.toHaveBeenCalled()
  })
  test('does not read or restore recording after shutdown starts', async () => {
    const { controller, store, effects } = fixture({ performanceRecordingEnabled: true })
    effects.isShuttingDown.mockReturnValue(true)

    await controller.restorePerformanceRecording()

    expect(store.read).not.toHaveBeenCalled()
    expect(effects.setPerformanceRecordingEnabled).not.toHaveBeenCalled()
    expect(store.update).not.toHaveBeenCalled()
  })

  test('preserves the recording preference when shutdown starts during its initial read', async () => {
    const { controller, store, effects } = fixture({ performanceRecordingEnabled: true })
    const reading = deferred<Record<string, unknown>>()
    store.read.mockReturnValueOnce(reading.promise)

    const restoring = controller.restorePerformanceRecording()
    expect(store.read).toHaveBeenCalledOnce()
    effects.isShuttingDown.mockReturnValue(true)
    reading.resolve({ performanceRecordingEnabled: true })
    await restoring

    expect(effects.setPerformanceRecordingEnabled).not.toHaveBeenCalled()
    expect(store.update).not.toHaveBeenCalled()
    await expect(store.read()).resolves.toEqual({ performanceRecordingEnabled: true })
  })

  test('preserves the recording preference when enabling rejects during shutdown', async () => {
    const { controller, store, effects } = fixture({ performanceRecordingEnabled: true })
    const started = deferred<void>()
    const enabling = deferred<void>()
    effects.setPerformanceRecordingEnabled.mockImplementationOnce(() => {
      started.resolve()
      return enabling.promise
    })

    const restoring = controller.restorePerformanceRecording()
    await started.promise
    expect(effects.setPerformanceRecordingEnabled).toHaveBeenCalledWith(true)
    effects.isShuttingDown.mockReturnValue(true)
    enabling.reject(new Error('Performance recording cannot start during shutdown'))
    await expect(restoring).resolves.toBeUndefined()

    expect(store.update).not.toHaveBeenCalled()
    await expect(store.read()).resolves.toEqual({ performanceRecordingEnabled: true })
  })

  test('resumes recording only when saved, and clears a setting that cannot be restored', async () => {
    const disabled = fixture()
    await disabled.controller.restorePerformanceRecording()
    expect(disabled.effects.setPerformanceRecordingEnabled).not.toHaveBeenCalled()

    const enabled = fixture({ performanceRecordingEnabled: true })
    await enabled.controller.restorePerformanceRecording()
    expect(enabled.effects.setPerformanceRecordingEnabled).toHaveBeenCalledWith(true)
    enabled.effects.setPerformanceRecordingEnabled.mockRejectedValueOnce(
      new Error('log unavailable')
    )
    await expect(enabled.controller.restorePerformanceRecording()).rejects.toThrow(
      'log unavailable'
    )
    expect(enabled.store.update).toHaveBeenCalledWith({ performanceRecordingEnabled: false })
    await expect(enabled.store.read()).resolves.toEqual({ performanceRecordingEnabled: false })
  })
  test('applies performance recording before publishing the persisted preference', async () => {
    const { controller, store, effects } = fixture()
    await expect(controller.update({ performanceRecordingEnabled: true })).resolves.toEqual({
      performanceRecordingEnabled: true,
    })
    expect(effects.setPerformanceRecordingEnabled).toHaveBeenCalledWith(true)
    expect(effects.setPerformanceRecordingEnabled.mock.invocationCallOrder[0]).toBeLessThan(
      store.update.mock.invocationCallOrder[0]!
    )
    expect(effects.configurePopoutShortcut).not.toHaveBeenCalled()
  })

  test('restores recording and shortcut when persistence fails, then accepts later updates', async () => {
    const { controller, store, effects } = fixture({ performanceRecordingEnabled: true })
    store.update.mockRejectedValueOnce(new Error('disk full'))
    await expect(
      controller.update({
        performanceRecordingEnabled: false,
        popoutWindowShortcut: null,
      })
    ).rejects.toThrow('disk full')
    expect(effects.setPerformanceRecordingEnabled.mock.calls).toEqual([[false], [true]])
    expect(effects.configurePopoutShortcut.mock.calls).toEqual([[null], ['Alt+Shift+Space']])
    await expect(controller.update({ performanceRecordingEnabled: false })).resolves.toEqual({
      performanceRecordingEnabled: false,
    })
  })

  test('does not persist an enable request when the log cannot be opened', async () => {
    const { controller, store, effects } = fixture()
    effects.setPerformanceRecordingEnabled.mockRejectedValueOnce(new Error('log is read-only'))
    await expect(controller.update({ performanceRecordingEnabled: true })).rejects.toThrow(
      'read-only'
    )
    expect(store.update).not.toHaveBeenCalled()
    expect(effects.setPerformanceRecordingEnabled.mock.calls).toEqual([[true], [false]])
  })

  test('preserves both failures if a rejected update cannot restore the prior recording state', async () => {
    const { controller, store, effects } = fixture()
    const persistenceError = new Error('preference write failed')
    const rollbackError = new Error('recording restore failed')
    store.update.mockRejectedValueOnce(persistenceError)
    effects.setPerformanceRecordingEnabled
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(rollbackError)
    await expect(controller.update({ performanceRecordingEnabled: true })).rejects.toMatchObject({
      errors: [persistenceError, rollbackError],
      cause: rollbackError,
    })
  })

  test('serializes opposing updates from multiple windows', async () => {
    const { controller, store, effects } = fixture()
    let release!: () => void
    effects.setPerformanceRecordingEnabled.mockImplementationOnce(
      () =>
        new Promise<void>(resolve => {
          release = resolve
        })
    )
    const enable = controller.update({ performanceRecordingEnabled: true })
    const disable = controller.update({ performanceRecordingEnabled: false })
    await vi.waitFor(() => expect(release).toBeTypeOf('function'))
    expect(effects.setPerformanceRecordingEnabled.mock.calls).toEqual([[true]])
    release()
    await Promise.all([enable, disable])
    expect(effects.setPerformanceRecordingEnabled.mock.calls).toEqual([[true], [false]])
    await expect(store.read()).resolves.toEqual({ performanceRecordingEnabled: false })
  })

  test('rejects malformed toggles and leaves unrelated preference updates alone', async () => {
    const { controller, store, effects } = fixture()
    await expect(controller.update({ performanceRecordingEnabled: 'true' })).rejects.toThrow(
      'boolean'
    )
    expect(store.update).not.toHaveBeenCalled()
    await expect(controller.update({ language: 'en' })).resolves.toEqual({ language: 'en' })
    expect(effects.setPerformanceRecordingEnabled).not.toHaveBeenCalled()
    expect(store.read).not.toHaveBeenCalled()
  })

  test('preserves native shortcut defaults and disabled values', () => {
    expect(resolvePopoutShortcut({})).toBe('Alt+Shift+Space')
    expect(resolvePopoutShortcut({ popoutWindowShortcut: null })).toBeNull()
    expect(resolvePopoutShortcut({ popoutWindowShortcut: ' Ctrl+Space ' })).toBe('Ctrl+Space')
  })
})
