import { cleanup, renderHook } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'
import { usePersonalHomeTaskDrafts } from './personalHomeTaskDrafts'

afterEach(cleanup)

it('keeps unfinished starts across renders in the same account and sources', () => {
  const api = {}
  const local = {}
  const { result, rerender } = renderHook(() => usePersonalHomeTaskDrafts('account', [api, local]))
  const initial = result.current
  initial.set('issue', {} as never)
  rerender()
  expect(result.current).toBe(initial)
  expect(result.current.has('issue')).toBe(true)
})

it.each(['account', 'cloud', 'local'])(
  'isolates unfinished starts after a %s boundary changes',
  boundary => {
    const initial = { scope: 'first', cloud: {}, local: {} }
    const { result, rerender } = renderHook(
      ({ scope, cloud, local }) => usePersonalHomeTaskDrafts(scope, [cloud, local]),
      { initialProps: initial }
    )
    const old = result.current
    old.set('private', {} as never)
    rerender({ ...initial, ...(boundary === 'account' ? { scope: 'second' } : { [boundary]: {} }) })
    expect(result.current).not.toBe(old)
    expect(result.current.size).toBe(0)
  }
)
