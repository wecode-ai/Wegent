import { act, cleanup, renderHook } from '@testing-library/react'
import { StrictMode } from 'react'
import { afterEach, beforeEach, expect, test } from 'vitest'
import {
  acceptWorkspaceTabTransfer,
  consumeWorkspaceTabTransfer,
  publishWorkspaceTabTransferState,
  stageWorkspaceTabTransfer,
} from '@/features/workspace-tabs/workspaceTabTransfer'
import { useWorkspaceTabDraftInput } from './useWorkspaceTabDraftInput'

beforeEach(() => localStorage.clear())
afterEach(cleanup)

test.each(['', 'Unsent objective'])(
  'transfers goal mode together with its scoped draft (%s)',
  text => {
    const source = renderHook(() => useWorkspaceTabDraftInput('goal-source'))
    act(() => {
      source.result.current.setInput('task-a', text)
      source.result.current.setGoalDraftActiveForScope('task-a', true)
      source.result.current.setInput('task-b', 'Ordinary draft')
    })
    stageWorkspaceTabTransfer('goal-source')
    source.unmount()

    const destination = renderHook(() => useWorkspaceTabDraftInput('goal-source'), {
      wrapper: StrictMode,
    })
    expect(destination.result.current.inputs['task-a'] ?? '').toBe(text)
    expect(destination.result.current.inputs['task-b']).toBe('Ordinary draft')
    expect(destination.result.current.goalDraftActiveByScope).toEqual({ 'task-a': true })
    expect(consumeWorkspaceTabTransfer('goal-source')).toBeNull()

    act(() => destination.result.current.setGoalDraftActiveForScope('task-a', false))
    stageWorkspaceTabTransfer('goal-source')
    expect(consumeWorkspaceTabTransfer('goal-source')).toEqual({
      draftInputByScope: destination.result.current.inputs,
      goalDraftActiveByScope: {},
    })
    expect(destination.result.current.inputs['task-a'] ?? '').toBe(text)
  }
)

test('replaces returned goal modes in a mounted owner without changing other tabs', () => {
  const owner = renderHook(() => useWorkspaceTabDraftInput('goal-returned'))
  const other = renderHook(() => useWorkspaceTabDraftInput('goal-unrelated'))
  act(() => {
    owner.result.current.setGoalDraftActiveForScope('old-task', true)
    other.result.current.setGoalDraftActiveForScope('other-task', true)
  })
  publishWorkspaceTabTransferState('goal-returned', {
    draftInputByScope: { 'new-task': 'Returned objective' },
    goalDraftActiveByScope: { 'new-task': true },
  })
  stageWorkspaceTabTransfer('goal-returned')
  act(() => acceptWorkspaceTabTransfer('goal-returned'))

  expect(owner.result.current.inputs).toEqual({ 'new-task': 'Returned objective' })
  expect(owner.result.current.goalDraftActiveByScope).toEqual({ 'new-task': true })
  expect(other.result.current.goalDraftActiveByScope).toEqual({ 'other-task': true })

  publishWorkspaceTabTransferState('goal-returned', { draftInputByScope: {} })
  stageWorkspaceTabTransfer('goal-returned')
  act(() => acceptWorkspaceTabTransfer('goal-returned'))
  expect(owner.result.current.inputs).toEqual({})
  expect(owner.result.current.goalDraftActiveByScope).toEqual({})
})
