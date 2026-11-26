import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createScopedDraftStore } from './scopedDraftStore'

beforeEach(() => localStorage.clear())
afterEach(() => {
  vi.useRealTimers()
  localStorage.clear()
})

it('restores persisted drafts by account and workspace tab', () => {
  const store = createScopedDraftStore({ storageScope: 'account:one:tab:main' })
  store.write('blank:0', 'First draft')
  store.write('runtime:device-1:task-1', 'Follow-up')
  store.flush()

  const restored = createScopedDraftStore({ storageScope: 'account:one:tab:main' })
  expect(restored.exportInputs()).toEqual({
    'blank:0': 'First draft',
    'runtime:device-1:task-1': 'Follow-up',
  })
  expect(createScopedDraftStore({ storageScope: 'account:two:tab:main' }).exportInputs()).toEqual(
    {}
  )
})

it('coalesces editor persistence until the debounce window closes', () => {
  vi.useFakeTimers()
  const storageScope = 'account:one:tab:main'
  const store = createScopedDraftStore({ storageScope })

  store.persistDraft('blank:0', 'First input')
  vi.advanceTimersByTime(100)
  store.persistDraft('blank:0', 'Latest input')
  expect(createScopedDraftStore({ storageScope }).read('blank:0').value).toBe('')

  vi.advanceTimersByTime(249)
  expect(createScopedDraftStore({ storageScope }).read('blank:0').value).toBe('')

  vi.advanceTimersByTime(1)
  expect(createScopedDraftStore({ storageScope }).read('blank:0').value).toBe('Latest input')
})

it('removes empty drafts immediately', () => {
  vi.useFakeTimers()
  const storageScope = 'account:one:tab:main'
  const store = createScopedDraftStore({ storageScope })
  store.persistDraft('blank:0', 'Draft')
  store.flush()

  store.persistDraft('blank:0', '')
  expect(createScopedDraftStore({ storageScope }).read('blank:0').value).toBe('')
})

it('ignores malformed persisted drafts without blocking startup', () => {
  const storageScope = 'account:one:tab:main'
  const store = createScopedDraftStore({ storageScope })
  store.persistDraft('blank:0', 'Draft')
  store.flush()
  const key = localStorage.key(0)
  if (key == null) throw new Error('Expected a persisted draft key')
  localStorage.setItem(key, '{')

  expect(() => createScopedDraftStore({ storageScope })).not.toThrow()
  expect(createScopedDraftStore({ storageScope }).exportInputs()).toEqual({})
})
