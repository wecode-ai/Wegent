import { act, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { expect, it } from 'vitest'
import { AnchorPopover } from './AnchorPopover'

it('preserves contents across focus transfer while honoring the anchor, outside press and Escape', async () => {
  function Example() {
    const [anchor, setAnchor] = useState<HTMLButtonElement | null>(null)
    return (
      <>
        <button type="button" onClick={event => setAnchor(anchor ? null : event.currentTarget)}>
          Details
        </button>
        <button type="button">Outside</button>
        {anchor && (
          <AnchorPopover
            anchor={anchor}
            title="Details"
            testId="example-popover"
            onClose={() => setAnchor(null)}
          >
            <button type="button">Edit</button>
          </AnchorPopover>
        )}
      </>
    )
  }

  const user = userEvent.setup()
  render(<Example />)
  const trigger = screen.getByRole('button', { name: 'Details' })
  const outside = screen.getByRole('button', { name: 'Outside' })

  await user.click(trigger)
  act(() => screen.getByRole('button', { name: 'Edit' }).focus())
  act(() => outside.focus())
  expect(screen.getByRole('dialog', { name: 'Details' })).toBeInTheDocument()
  expect(outside).toHaveFocus()
  await user.click(trigger)
  expect(screen.queryByRole('dialog', { name: 'Details' })).not.toBeInTheDocument()

  await user.click(trigger)
  act(() => screen.getByRole('button', { name: 'Edit' }).focus())
  await user.keyboard('{Escape}')
  expect(screen.queryByRole('dialog', { name: 'Details' })).not.toBeInTheDocument()

  await user.click(trigger)
  await user.click(outside)
  expect(screen.queryByRole('dialog', { name: 'Details' })).not.toBeInTheDocument()
})
