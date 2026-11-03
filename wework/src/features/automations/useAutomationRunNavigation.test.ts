import { act, renderHook } from '@testing-library/react'
import { expect, it, vi } from 'vitest'
import type { AutomationRun } from '@/types/automation'
import { navigateTo } from '@/lib/navigation'
import { useAutomationRunNavigation } from './useAutomationRunNavigation'

vi.mock('@/lib/navigation', () => ({
  buildRuntimeTaskRoute: ({ taskId }: { taskId: string }) => `/tasks/${taskId}`,
  navigateTo: vi.fn(),
}))
const run = { taskId: 'original', deviceId: 'device' } as AutomationRun

it('checks newly edited drafts after a delayed work open instead of navigating with an old guard', async () => {
  let finish!: () => void
  const openRuntimeTask = vi.fn(
    () =>
      new Promise<void>(resolve => {
        finish = resolve
      })
  )
  const first = vi.fn((action: () => void) => action())
  const onError = vi.fn()
  const view = renderHook(
    ({ requestLeave }) => useAutomationRunNavigation({ openRuntimeTask, requestLeave, onError }),
    { initialProps: { requestLeave: first } }
  )
  act(() => view.result.current(run))
  expect(openRuntimeTask).toHaveBeenCalledOnce()
  let confirm!: () => void
  const latestGuard = vi.fn((action: () => void) => {
    confirm = action
  })
  view.rerender({ requestLeave: latestGuard })
  await act(async () => finish())
  expect(latestGuard).toHaveBeenCalledOnce()
  expect(navigateTo).not.toHaveBeenCalled()
  act(() => confirm())
  expect(navigateTo).toHaveBeenCalledWith('/tasks/original')
})

it('does not navigate after the user has already left the calendar', async () => {
  vi.mocked(navigateTo).mockClear()
  let finish!: () => void
  const view = renderHook(() =>
    useAutomationRunNavigation({
      openRuntimeTask: () =>
        new Promise<void>(resolve => {
          finish = resolve
        }),
      requestLeave: action => action(),
      onError: vi.fn(),
    })
  )
  act(() => view.result.current(run))
  view.unmount()
  await act(async () => finish())
  expect(navigateTo).not.toHaveBeenCalled()
})
