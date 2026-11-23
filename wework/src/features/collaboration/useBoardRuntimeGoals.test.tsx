import { act, renderHook, waitFor } from '@testing-library/react'
import { expect, test, vi } from 'vitest'
import { useBoardRuntimeGoals } from '../../../../packages/collaboration/src/issue-card/useBoardRuntimeGoals'
import type { RuntimeGoalGetResponse } from '@wegent/chat-core/runtime-task-api-types'

const first = { deviceId: 'device', taskId: 'first' },
  second = { deviceId: 'device', taskId: 'second' }

test('deduplicates addresses and retries their failed goal reads', async () => {
  const getRuntimeGoal = vi
    .fn()
    .mockResolvedValueOnce({
      accepted: false,
      taskId: 'first',
      goal: null,
      error: 'Device offline',
    })
    .mockResolvedValue({ accepted: true, taskId: 'first', goal: null })
  const api = { getRuntimeGoal }
  const { result } = renderHook(() => useBoardRuntimeGoals(api, [first, first], 'Load failed'))
  await waitFor(() => expect(result.current.get(first)?.error).toBe('Device offline'))
  expect(getRuntimeGoal).toHaveBeenCalledTimes(1)
  await act(async () => {
    result.current.retry()
  })
  await waitFor(() => expect(result.current.get(first)).toEqual({ goal: null, error: null }))
  expect(getRuntimeGoal).toHaveBeenCalledTimes(2)
})

test('isolates a late goal response after the addressed task changes', async () => {
  let finishOld!: (value: RuntimeGoalGetResponse) => void
  const getRuntimeGoal = vi
    .fn()
    .mockReturnValueOnce(
      new Promise<RuntimeGoalGetResponse>(resolve => {
        finishOld = resolve
      })
    )
    .mockResolvedValue({ accepted: true, taskId: 'second', goal: null })
  const api = { getRuntimeGoal }
  const { result, rerender } = renderHook(
    ({ address }) => useBoardRuntimeGoals(api, [address], 'Load failed'),
    { initialProps: { address: first } }
  )
  rerender({ address: second })
  await waitFor(() => expect(result.current.get(second)).toEqual({ goal: null, error: null }))
  await act(async () => {
    finishOld({ accepted: false, taskId: 'first', goal: null, error: 'Old error' })
  })
  expect(result.current.get(first)).toBeUndefined()
  expect(result.current.get(second)).toEqual({ goal: null, error: null })
})
