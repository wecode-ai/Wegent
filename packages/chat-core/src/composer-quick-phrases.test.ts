import { describe, expect, it, vi } from 'vitest'
import { createQuickPhrasePreferencesStore, defaultQuickPhrases } from './composer-quick-phrases'

describe('composer quick phrase preferences', () => {
  it('coalesces loads and keeps authoritative empty preferences', async () => {
    const load = vi.fn().mockResolvedValue([])
    const store = createQuickPhrasePreferencesStore({ load, save: vi.fn() })
    const first = store.load()
    expect(store.load()).toBe(first)
    await first
    expect(load).toHaveBeenCalledTimes(1)
    expect(store.getSnapshot()).toEqual({ loaded: true, pending: false, phrases: [], error: null })
  })
  it('retains data on failed saves and exposes load failures without substituting defaults', async () => {
    const load = vi
      .fn()
      .mockRejectedValueOnce(new Error('Offline'))
      .mockResolvedValue(defaultQuickPhrases)
    const save = vi.fn().mockRejectedValueOnce(new Error('Cannot save')).mockResolvedValue([])
    const store = createQuickPhrasePreferencesStore({ load, save })
    await store.load()
    expect(store.getSnapshot()).toMatchObject({ loaded: false, error: 'Offline', phrases: [] })
    await store.load()
    await expect(store.save([])).rejects.toThrow('Cannot save')
    expect(store.getSnapshot()).toMatchObject({
      phrases: defaultQuickPhrases,
      error: 'Cannot save',
      pending: false,
    })
    await store.save([])
    expect(store.getSnapshot()).toMatchObject({ phrases: [], error: null })
  })
  it('does not start a stale reload or a second save while a save is pending', async () => {
    let finish!: (phrases: typeof defaultQuickPhrases) => void
    const load = vi.fn().mockResolvedValue(defaultQuickPhrases)
    const store = createQuickPhrasePreferencesStore({
      load,
      save: () =>
        new Promise(resolve => {
          finish = resolve
        }),
    })
    await store.load()
    const saving = store.save([])
    expect(store.load()).toBe(saving)
    await expect(store.save(defaultQuickPhrases)).rejects.toThrow('not ready')
    finish([])
    await saving
    expect(load).toHaveBeenCalledTimes(1)
    expect(store.getSnapshot().phrases).toEqual([])
  })
})
