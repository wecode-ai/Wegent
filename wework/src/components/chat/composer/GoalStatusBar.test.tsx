import type { RuntimeGoal } from '@/types/api'
import { act, fireEvent, render, screen } from '@testing-library/react'
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
  test('uses authoritative elapsed updates and stops ticking when paused or unmounted', () => {
    vi.setSystemTime(10000)
    const { rerender, unmount } = render(<GoalStatusBar goal={{ ...goal, status: 'active' }} />)
    expect(screen.getByTestId('goal-status-bar')).toHaveTextContent('12s')
    act(() => vi.advanceTimersByTime(3000))
    expect(screen.getByTestId('goal-status-bar')).toHaveTextContent('15s')
    rerender(
      <GoalStatusBar goal={{ ...goal, status: 'active', timeUsedSeconds: 20, updatedAt: 13000 }} />
    )
    expect(screen.getByTestId('goal-status-bar')).toHaveTextContent('20s')
    act(() => vi.advanceTimersByTime(1000))
    expect(screen.getByTestId('goal-status-bar')).toHaveTextContent('21s')
    rerender(<GoalStatusBar goal={{ ...goal, status: 'paused', timeUsedSeconds: 21 }} />)
    expect(vi.getTimerCount()).toBe(0)
    act(() => vi.advanceTimersByTime(10000))
    expect(screen.getByTestId('goal-status-bar')).toHaveTextContent('21s')
    rerender(<GoalStatusBar goal={{ ...goal, status: 'active', timeUsedSeconds: 21 }} />)
    act(() => vi.advanceTimersByTime(2000))
    expect(screen.getByTestId('goal-status-bar')).toHaveTextContent('23s')
    unmount()
    expect(vi.getTimerCount()).toBe(0)
  })

  test('does not restart elapsed time on an unrelated render but resets for a different conversation', () => {
    const { rerender } = render(<GoalStatusBar goal={{ ...goal, status: 'active' }} />)
    act(() => vi.advanceTimersByTime(2000))
    rerender(<GoalStatusBar goal={{ ...goal, status: 'active' }} continuing />)
    expect(screen.getByTestId('goal-status-bar')).toHaveTextContent('14s')
    rerender(<GoalStatusBar goal={{ ...goal, status: 'active', threadId: 'thread-2' }} />)
    expect(screen.getByTestId('goal-status-bar')).toHaveTextContent('12s')
    act(() => vi.advanceTimersByTime(1000))
    expect(screen.getByTestId('goal-status-bar')).toHaveTextContent('13s')
  })
})
