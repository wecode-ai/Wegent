import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, expect, it, vi } from 'vitest'
import { StandInReviewDialog } from './StandInReviewDialog'

afterEach(cleanup)

it('dismisses on the first Escape from its focused close button', async () => {
  const user = userEvent.setup()
  const onClose = vi.fn()
  render(
    <StandInReviewDialog open title="Schedule" testId="schedule" onClose={onClose}>
      <button>Continue editing</button>
    </StandInReviewDialog>
  )
  const close = screen.getByTestId('schedule-close')
  await user.click(screen.getByRole('button', { name: 'Continue editing' }))
  await user.tab({ shift: true })
  expect(close).toHaveFocus()
  await user.keyboard('{Escape}')
  expect(onClose).toHaveBeenCalledOnce()
})
