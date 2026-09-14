import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import type { RuntimeGoal } from '@/types/api'
import { GoalStatusBar } from './GoalStatusBar'

vi.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => ({
    t: (_key: string, fallback: string) => fallback,
  }),
}))

const goal: RuntimeGoal = {
  threadId: 'thread-1',
  objective: '完成一段很长、在输入框上方会被截断但悬停时必须完整展示的目标内容',
  status: 'paused',
  tokenBudget: null,
  tokensUsed: 0,
  timeUsedSeconds: 12,
  createdAt: 1780000000000,
  updatedAt: 1780000000000,
}

describe('GoalStatusBar', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.advanceTimersByTime(301)
    vi.useRealTimers()
  })

  test('shows the full objective in a tooltip when hovering the truncated text', () => {
    render(<GoalStatusBar goal={goal} />)

    const objective = screen.getByTestId('goal-objective')
    expect(objective).toHaveClass('truncate')
    expect(screen.queryByTestId('goal-objective-tooltip')).not.toBeInTheDocument()

    fireEvent.pointerEnter(objective.parentElement as HTMLElement)
    act(() => {
      vi.advanceTimersByTime(700)
    })

    expect(screen.getByTestId('goal-objective-tooltip')).toHaveTextContent(goal.objective)
  })

  test('shows recovery state and exposes a resume action when attention is required', () => {
    const onResumeGoal = vi.fn()
    render(
      <GoalStatusBar
        goal={{ ...goal, status: 'active' }}
        executionStatus="needsAttention"
        onResumeGoal={onResumeGoal}
      />
    )

    expect(screen.getByTestId('goal-status-bar')).toHaveTextContent('需要恢复')
    fireEvent.click(screen.getByTestId('resume-goal-button'))
    expect(onResumeGoal).toHaveBeenCalledOnce()
  })

  test('shows an automatic restart recovery separately from normal execution', () => {
    render(<GoalStatusBar goal={{ ...goal, status: 'active' }} executionStatus="recovering" />)

    expect(screen.getByTestId('goal-status-bar')).toHaveTextContent('正在恢复')
  })
})
