import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useExperienceDraftInput } from '../useExperienceDraftInput'
import { privateDraftPersistence } from './privateDraftPersistence'

beforeEach(() => localStorage.clear())
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

it('restores exact unsent scopes after a new hook instance and preserves independent writes', () => {
  const adapter = privateDraftPersistence('account-1', 'task-1')
  const first = renderHook(() =>
    useExperienceDraftInput({ accountKey: 'account-1', scopeKey: 'task-1', inputKey: 'discussion' })
  )
  act(() => first.result.current.setValue('Unsent private text'))
  adapter.write('conclusion:source-1', 'Confirmed draft')
  act(() => first.result.current.setValue('Revised private text'))
  first.unmount()
  const restarted = renderHook(() =>
    useExperienceDraftInput({ accountKey: 'account-1', scopeKey: 'task-1', inputKey: 'discussion' })
  )
  expect(restarted.result.current.value).toBe('Revised private text')
  expect(adapter.read()).toMatchObject({
    discussion: 'Revised private text',
    'conclusion:source-1': 'Confirmed draft',
  })
  expect(privateDraftPersistence('account-2', 'task-1').read()).toEqual({})
  expect(privateDraftPersistence('account-1', 'task-2').read()).toEqual({})
  act(() => restarted.result.current.setValue(''))
  expect(adapter.read().discussion).toBeUndefined()
  expect(adapter.read()['conclusion:source-1']).toBe('Confirmed draft')
})

it('retains editable text and reports storage failure instead of claiming a durable draft', () => {
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
    throw new Error('Storage unavailable')
  })
  const hook = renderHook(() =>
    useExperienceDraftInput({ accountKey: 'account-1', scopeKey: 'task-1', inputKey: 'discussion' })
  )
  act(() => hook.result.current.setValue('Keep this unsaved text'))
  expect(hook.result.current.value).toBe('Keep this unsaved text')
  expect(hook.result.current.persistenceError).toBeInstanceOf(Error)
})

it('reports corrupt saved state without overwriting it or blocking the component', () => {
  const adapter = privateDraftPersistence('account-1', 'task-1')
  adapter.write('discussion', 'Valid text')
  const key = localStorage.key(0)!
  localStorage.setItem(key, '{invalid')
  const hook = renderHook(() =>
    useExperienceDraftInput({ accountKey: 'account-1', scopeKey: 'task-1', inputKey: 'discussion' })
  )
  expect(hook.result.current.value).toBe('')
  expect(hook.result.current.persistenceError).toBeInstanceOf(Error)
  act(() => hook.result.current.setValue('Recovered in memory'))
  expect(localStorage.getItem(key)).toBe('{invalid')
  expect(hook.result.current.value).toBe('Recovered in memory')
})
