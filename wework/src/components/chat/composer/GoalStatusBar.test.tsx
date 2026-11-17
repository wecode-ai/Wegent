import type { RuntimeGoal } from '@/types/api'
import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
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
  test('keeps a human pause visible beside the resume control', () => {
    render(<GoalStatusBar goal={goal} onResumeGoal={vi.fn()} />)
    expect(screen.getByTestId('goal-status-bar')).toHaveTextContent('已暂停')
    expect(screen.getByTestId('resume-goal-button')).toBeInTheDocument()
  })
  test('explains an event wait and allows the user to pause automatic recovery', () => {
    const onPauseGoal = vi.fn()
    render(
      <GoalStatusBar
        goal={{ ...goal, status: 'blocked' }}
        eventWaitState="waiting"
        onPauseGoal={onPauseGoal}
      />
    )
    expect(screen.getByTestId('goal-status-bar')).toHaveTextContent('等待事件')
    expect(screen.queryByTestId('resume-goal-button')).not.toBeInTheDocument()
    fireEvent.click(screen.getByTestId('pause-goal-button'))
    expect(onPauseGoal).toHaveBeenCalledOnce()
  })
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.advanceTimersByTime(301)
    vi.useRealTimers()
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

  test('preserves canonical execution recovery when an event wait projection is stale', () => {
    const onResumeGoal = vi.fn()
    render(
      <GoalStatusBar
        goal={{ ...goal, status: 'blocked' }}
        eventWaitState="received"
        executionStatus="needsAttention"
        onResumeGoal={onResumeGoal}
      />
    )
    expect(screen.getByTestId('goal-status-bar')).toHaveTextContent('需要恢复')
    expect(screen.queryByText('等待继续执行')).not.toBeInTheDocument()
    fireEvent.click(screen.getByTestId('resume-goal-button'))
    expect(onResumeGoal).toHaveBeenCalledOnce()
  })
})
