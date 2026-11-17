import { afterEach, describe, expect, it, vi } from 'vitest'
import { DiagnosticsPreferences, parseDiagnosticPreference } from './diagnosticPreferences'
import { diagnosticsEnabled, setDiagnosticRecording } from './mobileDiagnostics'

afterEach(() => setDiagnosticRecording(false))

describe('diagnostic preferences', () => {
  it('defaults only absent preferences and rejects malformed stored values', () => {
    expect(parseDiagnosticPreference(null)).toBe(false)
    expect(parseDiagnosticPreference('false')).toBe(false)
    expect(parseDiagnosticPreference('true')).toBe(true)
    expect(() => parseDiagnosticPreference('broken')).toThrow('Invalid diagnostic preference')
  })
  it('restores the persisted opt-in without affecting executor availability', async () => {
    const storage = { read: vi.fn(async () => true), write: vi.fn(async () => undefined) }
    const preferences = new DiagnosticsPreferences(async () => storage)
    expect(preferences.snapshot().enabled).toBe(false)
    await Promise.all([preferences.load(), preferences.load()])
    expect(storage.read).toHaveBeenCalledOnce()
    expect(preferences.snapshot()).toMatchObject({ enabled: true, ready: true, error: null })
    expect(diagnosticsEnabled()).toBe(true)
  })

  it('serializes changes and exposes a value only after storage succeeds', async () => {
    let finish!: () => void
    const storage = {
      read: vi.fn(async () => false),
      write: vi
        .fn<(enabled: boolean) => Promise<void>>()
        .mockImplementationOnce(
          () =>
            new Promise<void>(resolve => {
              finish = resolve
            })
        )
        .mockResolvedValue(undefined),
    }
    const preferences = new DiagnosticsPreferences(async () => storage)
    await preferences.load()
    const first = preferences.change(true)
    const second = preferences.change(false)
    await vi.waitFor(() => expect(storage.write).toHaveBeenCalledOnce())
    expect(preferences.snapshot()).toMatchObject({ enabled: false, changing: true })
    expect(diagnosticsEnabled()).toBe(false)
    finish()
    await Promise.all([first, second])
    expect(storage.write.mock.calls).toEqual([[true], [false]])
    expect(preferences.snapshot()).toMatchObject({ enabled: false, changing: false })
    expect(diagnosticsEnabled()).toBe(false)
  })

  it('keeps the previous value after a failed write and accepts the next explicit change', async () => {
    const failure = new Error('Storage unavailable')
    const storage = {
      read: async () => false,
      write: vi.fn().mockRejectedValueOnce(failure).mockResolvedValue(undefined),
    }
    const preferences = new DiagnosticsPreferences(async () => storage)
    await expect(preferences.change(true)).rejects.toBe(failure)
    expect(preferences.snapshot()).toMatchObject({ enabled: false, changing: false })
    expect(diagnosticsEnabled()).toBe(false)
    await preferences.change(true)
    expect(diagnosticsEnabled()).toBe(true)
  })

  it('reports unreadable preferences without enabling logs or blocking the app', async () => {
    const failure = new Error('Preferences unavailable')
    const storage = {
      read: vi.fn().mockRejectedValueOnce(failure).mockResolvedValue(false),
      write: vi.fn(),
    }
    const preferences = new DiagnosticsPreferences(async () => storage)
    await preferences.load()
    expect(preferences.snapshot()).toMatchObject({ ready: true, enabled: false, error: failure })
    await expect(preferences.change(true)).rejects.toBe(failure)
    expect(storage.write).not.toHaveBeenCalled()
    await preferences.retry()
    expect(preferences.snapshot().error).toBeNull()
  })
})
