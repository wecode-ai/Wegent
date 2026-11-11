import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createInteractionDraftStore } from './useInteractionDrafts'
import { readInteractionDraftState, saveInteractionState } from './interactionStorage'
import type { InteractionHistory } from './RuntimeInteractionsContext'

const flushStorage = vi.hoisted(() => vi.fn())
vi.mock('@/desktop/localStoragePersistence', () => ({
  flushDesktopLocalStoragePersistence: flushStorage,
}))

const prefix = 'wework.interactions:test:1:'
const draftsKey = `${prefix}drafts`
const historyKey = `${prefix}history`

const interaction: InteractionHistory = {
  id: 'reply',
  title: 'Review',
  question: 'Which behavior?',
  address: { deviceId: 'device', taskId: 'review' },
  answeredAt: 1,
}

beforeEach(() => {
  localStorage.clear()
  flushStorage.mockReset().mockResolvedValue(undefined)
  const locks = new Map<string, Promise<unknown>>()
  Object.defineProperty(navigator, 'locks', {
    configurable: true,
    value: {
      request: (name: string, callback: () => unknown) => {
        const previous = locks.get(name) ?? Promise.resolve()
        const next = previous.catch(() => undefined).then(callback)
        locks.set(name, next)
        return next
      },
    },
  })
})

afterEach(() => {
  vi.restoreAllMocks()
  Reflect.deleteProperty(navigator, 'locks')
})

it('merges edits from separate windows into the latest persisted draft map', async () => {
  const main = createInteractionDraftStore('test:1')
  const secondary = createInteractionDraftStore('test:1')
  const stopMain = main.activate()
  const stopSecondary = secondary.activate()

  secondary.setDraft('secondary', 'From the secondary window')
  await secondary.flush()
  main.setDraft('main', 'From the main window')
  await main.flush()

  expect(JSON.parse(localStorage.getItem(draftsKey)!)).toEqual({
    secondary: 'From the secondary window',
    main: 'From the main window',
  })
  stopMain()
  stopSecondary()
})

it('refreshes the local snapshot when another window persists a draft', async () => {
  const first = createInteractionDraftStore('test:1')
  const second = createInteractionDraftStore('test:1')
  const stopFirst = first.activate()
  const stopSecond = second.activate()
  const listener = vi.fn()
  first.subscribe(listener)

  second.setDraft('remote', 'Saved in another window')
  await second.flush()
  window.dispatchEvent(
    new StorageEvent('storage', { key: draftsKey, newValue: localStorage.getItem(draftsKey) })
  )

  expect(first.getSnapshot()).toEqual({ remote: 'Saved in another window' })
  expect(listener).toHaveBeenCalled()
  stopFirst()
  stopSecond()
})

it('does not overwrite a newer window snapshot when an older store activates', async () => {
  const stale = createInteractionDraftStore('test:1')
  const current = createInteractionDraftStore('test:1')
  const stopCurrent = current.activate()
  current.setDraft('retained', 'Keep this confirmed draft')
  await current.flush()

  const stopStale = stale.activate()

  expect(JSON.parse(localStorage.getItem(draftsKey)!)).toEqual({
    retained: 'Keep this confirmed draft',
  })
  expect(stale.getSnapshot()).toEqual({ retained: 'Keep this confirmed draft' })
  stopStale()
  stopCurrent()
})

it('retains recovery metadata from the latest persisted text, not a stale window snapshot', async () => {
  const main = createInteractionDraftStore('test:1')
  const secondary = createInteractionDraftStore('test:1')
  const stopMain = main.activate()
  const stopSecondary = secondary.activate()
  main.setDraft(interaction.id, 'Do not lose this reply')
  await main.flush()

  await secondary.retainDraft(interaction)

  expect(readInteractionDraftState(draftsKey, historyKey)[interaction.id]).toEqual({
    text: 'Do not lose this reply',
    interaction,
    nativeReplyIds: [],
  })
  stopMain()
  stopSecondary()
})

it('persists upgraded legacy drafts together with a later edit', async () => {
  saveInteractionState(draftsKey, { [interaction.id]: 'Legacy reply' })
  saveInteractionState(historyKey, [interaction])
  const store = createInteractionDraftStore('test:1')
  const stop = store.activate()
  expect(store.getSnapshot()[interaction.id]).toMatchObject({
    text: 'Legacy reply',
    interaction,
  })

  store.setDraft('another', 'New reply')
  await store.flush()

  expect(JSON.parse(localStorage.getItem(draftsKey)!)).toEqual({
    [interaction.id]: { text: 'Legacy reply', interaction, nativeReplyIds: [] },
    another: 'New reply',
  })
  stop()
})

it('keeps the draft visible when discard cannot be persisted', async () => {
  vi.spyOn(console, 'error').mockImplementation(() => {})
  const store = createInteractionDraftStore('test:1')
  const stop = store.activate()
  store.setDraft('reply', 'Keep until discard commits')
  await store.flush()
  const original = Storage.prototype.setItem
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (key, value) {
    if (key === draftsKey) throw new Error('Quota exceeded')
    return original.call(this, key, value)
  })

  expect(await store.discardDraft('reply')).toBe(false)
  expect(store.getSnapshot()).toEqual({ reply: 'Keep until discard commits' })
  stop()
})

it('keeps the visible draft when discard cannot be flushed to disk', async () => {
  vi.spyOn(console, 'error').mockImplementation(() => {})
  const store = createInteractionDraftStore('test:1')
  const stop = store.activate()
  store.setDraft('reply', 'Keep until discard commits')
  await store.flush()
  flushStorage.mockRejectedValueOnce(new Error('Disk unavailable'))

  expect(await store.discardDraft('reply')).toBe(false)
  expect(store.getSnapshot()).toEqual({ reply: 'Keep until discard commits' })
  expect(await store.discardDraft('reply')).toBe(true)
  expect(store.getSnapshot()).toEqual({})
  stop()
})

it('retains an unsaved local draft after its write fails', async () => {
  vi.spyOn(console, 'error').mockImplementation(() => {})
  const store = createInteractionDraftStore('test:1')
  const stop = store.activate()
  const original = Storage.prototype.setItem
  const write = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (key, value) {
    if (key === draftsKey) throw new Error('Quota exceeded')
    return original.call(this, key, value)
  })
  store.setDraft(interaction.id, 'Write failed but keep this reply')
  await store.flush()
  write.mockRestore()
  saveInteractionState(draftsKey, { remote: 'Another window' })
  window.dispatchEvent(
    new StorageEvent('storage', { key: draftsKey, newValue: localStorage.getItem(draftsKey) })
  )
  expect(store.getSnapshot()).toMatchObject({
    [interaction.id]: 'Write failed but keep this reply',
    remote: 'Another window',
  })

  await store.retainDraft(interaction)

  expect(store.getSnapshot()[interaction.id]).toEqual({
    text: 'Write failed but keep this reply',
    interaction,
    nativeReplyIds: [],
  })
  expect(JSON.parse(localStorage.getItem(draftsKey)!)[interaction.id]).toEqual({
    text: 'Write failed but keep this reply',
    interaction,
    nativeReplyIds: [],
  })
  stop()
})

it('keeps a failed clear hidden when settlement has no new native text', async () => {
  vi.spyOn(console, 'error').mockImplementation(() => {})
  const store = createInteractionDraftStore('test:1')
  const stop = store.activate()
  store.setDraft(interaction.id, 'Old draft')
  await store.flush()
  const original = Storage.prototype.setItem
  const write = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (key, value) {
    if (key === draftsKey) throw new Error('Quota exceeded')
    return original.call(this, key, value)
  })
  store.setDraft(interaction.id, '')
  await store.flush()
  write.mockRestore()

  await store.retainDraft(interaction)

  expect(store.getSnapshot()).toEqual({})
  window.dispatchEvent(
    new StorageEvent('storage', { key: draftsKey, newValue: localStorage.getItem(draftsKey) })
  )
  expect(store.getSnapshot()).toEqual({})
  stop()
})
