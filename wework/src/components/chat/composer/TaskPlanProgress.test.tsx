import { act, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { TaskPlanProgress } from './TaskPlanProgress'

describe('TaskPlanProgress', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  test('dismisses a completed plan while keeping active progress visible', () => {
    vi.useFakeTimers()
    const activePlan = {
      plan: [{ step: 'Implement the fix', status: 'inProgress' as const }],
    }
    const completedPlan = {
      plan: [{ step: 'Implement the fix', status: 'completed' as const }],
    }
    const { rerender } = render(<TaskPlanProgress plan={activePlan} />)

    act(() => {
      vi.advanceTimersByTime(2200)
    })
    expect(screen.getByTestId('runtime-plan-progress-button')).toBeInTheDocument()

    rerender(<TaskPlanProgress plan={completedPlan} />)
    expect(screen.getByTestId('runtime-plan-progress-button')).toBeInTheDocument()

    act(() => {
      vi.advanceTimersByTime(2200)
    })
    expect(screen.queryByTestId('runtime-plan-progress-button')).not.toBeInTheDocument()

    rerender(
      <TaskPlanProgress
        plan={{
          ...completedPlan,
          plan: completedPlan.plan.map(step => ({ ...step })),
        }}
      />
    )
    expect(screen.queryByTestId('runtime-plan-progress-button')).not.toBeInTheDocument()

    rerender(<TaskPlanProgress plan={activePlan} />)
    expect(screen.getByTestId('runtime-plan-progress-button')).toBeInTheDocument()

    rerender(
      <TaskPlanProgress
        plan={{
          ...completedPlan,
          plan: completedPlan.plan.map(step => ({ ...step })),
        }}
      />
    )
    expect(screen.getByTestId('runtime-plan-progress-button')).toBeInTheDocument()
  })

  test('cancels the dismissal when a new active plan arrives', () => {
    vi.useFakeTimers()
    const completedPlan = {
      plan: [{ step: 'Inspect the result', status: 'completed' as const }],
    }
    const activePlan = {
      plan: [{ step: 'Handle follow-up work', status: 'inProgress' as const }],
    }
    const { rerender } = render(<TaskPlanProgress plan={completedPlan} />)

    act(() => {
      vi.advanceTimersByTime(1000)
    })
    rerender(<TaskPlanProgress plan={activePlan} />)

    act(() => {
      vi.advanceTimersByTime(2200)
    })
    expect(screen.getByTestId('runtime-plan-progress-button')).toBeInTheDocument()
    expect(screen.getByTestId('runtime-plan-popover')).toHaveTextContent('Handle follow-up work')
  })
})
