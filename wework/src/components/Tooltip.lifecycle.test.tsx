import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, expect, it, vi } from 'vitest'
import { Tooltip } from '@wegent/collaboration/controls/Tooltip'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.useRealTimers()
})

it.each(['resize', 'scroll'])('dismisses on native %s events', async event => {
  const user = userEvent.setup()
  render(
    <Tooltip label="Description">
      <button>Action</button>
    </Tooltip>
  )
  await user.tab()
  expect(await screen.findByRole('tooltip')).toHaveTextContent('Description')
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
  fireEvent.pointerOver(screen.getByRole('button'), { pointerType: 'mouse' })
  expect(screen.queryByRole('tooltip')).not.toBeInTheDocument()
  unmount()
  act(() => vi.advanceTimersByTime(700))
  expect(screen.queryByRole('tooltip')).not.toBeInTheDocument()
})
