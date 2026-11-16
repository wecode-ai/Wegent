import { act, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import '@/i18n'
import { IssueWaitingTime } from './IssueWaitingTime'

afterEach(() => vi.useRealTimers())
it('counts from the handoff timestamp and advances at minute granularity', () => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-11-08T03:02:00Z'))
  render(<IssueWaitingTime since="2026-11-08T01:00:00Z" />)
  expect(screen.getByTestId('issue-waiting-time')).toHaveAttribute(
    'datetime',
    '2026-11-08T01:00:00Z'
  )
  const before = screen.getByTestId('issue-waiting-time').textContent
  act(() => vi.advanceTimersByTime(60_000))
  expect(screen.getByTestId('issue-waiting-time').textContent).not.toBe(before)
})
it('does not invent a timer for an unknown historical handoff', () => {
  render(<IssueWaitingTime since={null} />)
  expect(screen.queryByTestId('issue-waiting-time')).not.toBeInTheDocument()
})
