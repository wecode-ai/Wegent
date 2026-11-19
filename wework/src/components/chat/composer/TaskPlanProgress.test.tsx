import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import type { RuntimePlanEventPayload } from '@/types/api'
import { TaskPlanProgress } from './TaskPlanProgress'

vi.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))

const plan: RuntimePlanEventPayload = {
  taskId: 'task-1',
  turnId: 'turn-1',
  plan: [{ step: 'Implement', status: 'completed' }],
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(10000)
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

test('expires the completed notice without extending it on repeated plan messages', () => {
  const { rerender, unmount } = render(<TaskPlanProgress plan={plan} />)
  expect(screen.getByTestId('runtime-plan-progress')).toBeInTheDocument()
  act(() => vi.advanceTimersByTime(2000))
  rerender(<TaskPlanProgress plan={{ ...plan, plan: [...plan.plan] }} />)
  act(() => vi.advanceTimersByTime(199))
  expect(screen.getByTestId('runtime-plan-progress')).toBeInTheDocument()
  act(() => vi.advanceTimersByTime(1))
  expect(screen.queryByTestId('runtime-plan-progress')).toBeNull()
  expect(vi.getTimerCount()).toBe(0)
  rerender(<TaskPlanProgress plan={{ ...plan, turnId: 'turn-2' }} />)
  expect(screen.getByTestId('runtime-plan-progress')).toBeInTheDocument()
  unmount()
  expect(vi.getTimerCount()).toBe(0)
})

test('cancels completion expiration when a plan returns to work', () => {
  const { rerender } = render(<TaskPlanProgress plan={plan} />)
  act(() => vi.advanceTimersByTime(1000))
  rerender(
    <TaskPlanProgress plan={{ ...plan, plan: [{ step: 'Implement', status: 'inProgress' }] }} />
  )
  expect(vi.getTimerCount()).toBe(0)
  act(() => vi.advanceTimersByTime(5000))
  expect(screen.getByTestId('runtime-plan-progress')).toBeInTheDocument()
  rerender(<TaskPlanProgress plan={plan} />)
  act(() => vi.advanceTimersByTime(2199))
  expect(screen.getByTestId('runtime-plan-progress')).toBeInTheDocument()
  act(() => vi.advanceTimersByTime(1))
  expect(screen.queryByTestId('runtime-plan-progress')).toBeNull()
})
