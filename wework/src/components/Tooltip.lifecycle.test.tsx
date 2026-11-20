import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { Tooltip } from '../../../packages/collaboration/src/issue-detail/Tooltip'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.useRealTimers()
})

it.each(['resize', 'scroll'])('dismisses on native %s events', event => {
  vi.useFakeTimers()
  render(
    <Tooltip label="Description">
      <button>Action</button>
    </Tooltip>
  )
  fireEvent.focus(screen.getByRole('button'))
  act(() => vi.advanceTimersByTime(700))
  expect(screen.getByRole('tooltip')).toHaveTextContent('Description')
  fireEvent(window, new Event(event))
  expect(screen.queryByRole('tooltip')).not.toBeInTheDocument()
})

it('cancels a pending show timer when its trigger unmounts', () => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-11-17T12:00:00Z'))
  const { unmount } = render(
    <Tooltip label="Description">
      <button>Action</button>
    </Tooltip>
  )
  fireEvent.focus(screen.getByRole('button'))
  expect(vi.getTimerCount()).toBe(1)
  unmount()
  expect(vi.getTimerCount()).toBe(0)
  act(() => vi.advanceTimersByTime(700))
  expect(screen.queryByRole('tooltip')).not.toBeInTheDocument()
})
