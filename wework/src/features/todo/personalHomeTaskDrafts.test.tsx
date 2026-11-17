import { cleanup, renderHook } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'
import { createPersonalHomeTaskDraftStore } from './personalHomeTaskDrafts'

afterEach(cleanup)

it('keeps unfinished starts across renders in the same account and sources', () => {
  const api = {}
  const local = {}
  const store = createPersonalHomeTaskDraftStore()
  const { result, rerender } = renderHook(() => store.get('account', [api, local]))
  const initial = result.current
  initial.set('issue', {} as never)
  rerender()
  expect(result.current).toBe(initial)
  expect(result.current.has('issue')).toBe(true)
})

it('retains the complete unfinished start after its composer unmounts', () => {
  const store = createPersonalHomeTaskDraftStore()
  const api = {}
  const first = renderHook(() => store.get('account', [api]))
  const draft = {
    value: 'Review feedback',
    goalDraftActive: true,
    pendingFiles: [new File(['notes'], 'notes.txt')],
  }
  first.result.current.set('project', draft as never)
  first.unmount()
  const second = renderHook(() => store.get('account', [api]))
  expect(second.result.current.get('project')).toBe(draft)
})

it.each(['account', 'cloud', 'local'])(
  'isolates unfinished starts after a %s boundary changes',
  boundary => {
    const initial = { scope: 'first', cloud: {}, local: {} }
    const store = createPersonalHomeTaskDraftStore()
    const { result, rerender } = renderHook(
      ({ scope, cloud, local }) => store.get(scope, [cloud, local]),
      { initialProps: initial }
    )
    const old = result.current
    old.set('private', {} as never)
    rerender({ ...initial, ...(boundary === 'account' ? { scope: 'second' } : { [boundary]: {} }) })
    expect(result.current).not.toBe(old)
    expect(result.current.size).toBe(0)
  }
)
