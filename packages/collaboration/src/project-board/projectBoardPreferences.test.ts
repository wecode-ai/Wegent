// @vitest-environment jsdom
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import {
  boardSortStorageChanged,
  createBoardFocusPreference,
  createBoardSortPreferences,
} from './projectBoardPreferences'

const lane = JSON.stringify(['status', 'open'])
const other = JSON.stringify(['priority', 'high'])
beforeEach(() => localStorage.clear())
afterEach(() => {
  localStorage.clear()
  vi.restoreAllMocks()
})

test('reads legacy preferences without writes and migrates only on subscription, preserving newer lanes', () => {
  localStorage.setItem(
    'board',
    JSON.stringify({ [lane]: ['priority-desc'], [other]: ['created-asc'] })
  )
  localStorage.setItem(`board:${lane}`, JSON.stringify(['updated-desc']))
  const store = createBoardSortPreferences('board')
  expect(store.getSnapshot()).toEqual({ [lane]: ['updated-desc'], [other]: ['created-asc'] })
  expect(localStorage.getItem('board')).not.toBeNull()
  expect(localStorage.getItem(`board:${other}`)).toBeNull()
  const stop = store.subscribe(vi.fn())
  expect(localStorage.getItem('board')).toBeNull()
  expect(JSON.parse(localStorage.getItem(`board:${other}`)!)).toEqual(['created-asc'])
  expect(store.getSnapshot()[lane]).toEqual(['updated-desc'])
  stop()
})

test('same-window writes synchronize observers without overwriting other lanes', () => {
  const first = createBoardSortPreferences('board'),
    second = createBoardSortPreferences('board')
  const stopFirst = first.subscribe(vi.fn()),
    stopSecond = second.subscribe(vi.fn())
  first.select(lane, ['updated-desc'])
  second.select(other, ['priority-asc'])
  expect(first.getSnapshot()).toEqual(second.getSnapshot())
  expect(first.getSnapshot()).toEqual({ [lane]: ['updated-desc'], [other]: ['priority-asc'] })
  stopFirst()
  stopSecond()
})

test('native storage events refresh only their own local-storage scope and stop after detach', () => {
  const store = createBoardSortPreferences('board'),
    changed = vi.fn()
  const stop = store.subscribe(changed)
  const initial = store.getSnapshot()
  localStorage.setItem(`board:${lane}`, JSON.stringify(['updated-desc']))
  window.dispatchEvent(new StorageEvent('storage', { key: 'unrelated' }))
  window.dispatchEvent(
    new StorageEvent('storage', { key: `board:${lane}`, storageArea: sessionStorage })
  )
  expect(store.getSnapshot()).toBe(initial)
  window.dispatchEvent(
    new StorageEvent('storage', { key: `board:${lane}`, storageArea: localStorage })
  )
  expect(store.getSnapshot()[lane]).toEqual(['updated-desc'])
  expect(changed).toHaveBeenCalledTimes(1)
  stop()
  localStorage.removeItem(`board:${lane}`)
  window.dispatchEvent(new StorageEvent('storage', { key: null }))
  expect(changed).toHaveBeenCalledTimes(1)
  const stopAgain = store.subscribe(changed)
  expect(store.getSnapshot()).toEqual({})
  stopAgain()
})

test('ignores corrupt lane values without reviving the older preference for the lane', () => {
  localStorage.setItem('board', JSON.stringify({ [lane]: ['priority-desc'] }))
  localStorage.setItem(`board:${lane}`, 'broken json')
  const store = createBoardSortPreferences('board')
  expect(store.getSnapshot()).toEqual({})
  const stop = store.subscribe(vi.fn())
  expect(store.getSnapshot()).toEqual({})
  stop()
})

test('local-only sorts never write storage and snapshots remain stable on unrelated events', () => {
  const store = createBoardSortPreferences(null)
  const changed = vi.fn(),
    stop = store.subscribe(changed)
  store.select(lane, ['created-asc'])
  const current = store.getSnapshot()
  window.dispatchEvent(new CustomEvent(boardSortStorageChanged, { detail: 'other' }))
  expect(store.getSnapshot()).toBe(current)
  expect(localStorage.length).toBe(0)
  expect(changed).toHaveBeenCalledTimes(1)
  stop()
})

test('focus toggles read the latest value synchronously and own their persistence', () => {
  localStorage.setItem('focus', 'true')
  const store = createBoardFocusPreference('focus')
  const changed = vi.fn(),
    stop = store.subscribe(changed)
  expect(store.getSnapshot()).toBe(true)
  store.toggle()
  store.toggle()
  expect(store.getSnapshot()).toBe(true)
  expect(localStorage.getItem('focus')).toBe('true')
  expect(changed).toHaveBeenCalledTimes(2)
  stop()
  const memory = createBoardFocusPreference(null)
  memory.toggle()
  expect(memory.getSnapshot()).toBe(true)
  expect(localStorage.length).toBe(1)
})
