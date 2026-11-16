import { act, renderHook } from '@testing-library/react'
import { expect, test } from 'vitest'
import { useScopedDraftInput } from './useScopedDraftInput'

test('invalidates old draft acknowledgements when a transfer replaces or removes a scope', () => {
  const { result } = renderHook(() =>
    useScopedDraftInput(() => ({ 'blank:0': 'Old draft', 'task:old': 'Old task draft' }))
  )
  const priorRevision = result.current.getRevision('blank:0')
  act(() => {
    result.current.replaceInputs({ 'blank:0': 'Incoming draft', 'task:new': 'New task draft' })
  })
  expect(result.current.inputs).toEqual({
    'blank:0': 'Incoming draft',
    'task:new': 'New task draft',
  })
  expect(result.current.getRevision('blank:0')).toBeGreaterThan(priorRevision)
  expect(result.current.getRevision('task:old')).toBe(1)
  expect(result.current.getRevision('task:new')).toBe(1)
  const acceptedRevision = result.current.getRevision('blank:0')
  act(() => {
    result.current.replaceInputs({ 'blank:0': 'Incoming draft', 'task:new': 'New task draft' })
  })
  expect(result.current.getRevision('blank:0')).toBe(acceptedRevision)
})
