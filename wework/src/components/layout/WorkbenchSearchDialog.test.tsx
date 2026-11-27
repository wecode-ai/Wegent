import '@/i18n'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { expect, test } from 'vitest'
import { WorkbenchSearchDialog } from './WorkbenchSearchDialog'

const search = async () => ({ items: [] })

function Workbench({ suspended }: { suspended: boolean }) {
  const [open, setOpen] = useState(false)
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        Open search
      </button>
      <input aria-label="Other tab note" />
      <WorkbenchSearchDialog
        open={open}
        suspended={suspended}
        onClose={() => setOpen(false)}
        onSearchRuntimeWork={search}
        onOpenRuntimeTask={() => {}}
      />
    </>
  )
}

test('releases focus to the active tab and restores the search draft and opener', async () => {
  const user = userEvent.setup()
  const { rerender } = render(<Workbench suspended={false} />)
  const opener = screen.getByRole('button', { name: 'Open search' })
  const note = screen.getByRole('textbox', { name: 'Other tab note' })
  await user.click(opener)
  const input = screen.getByTestId('workbench-search-input')
  await waitFor(() => {
    expect(input).toHaveFocus()
    expect(note.closest('[inert]')).not.toBeNull()
  })
  await user.type(input, 'video settings')

  rerender(<Workbench suspended />)
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  expect(note.closest('[inert]')).toBeNull()
  await user.click(note)
  expect(note).toHaveFocus()
  await user.keyboard('{Escape}other task')
  expect(note).toHaveValue('other task')

  rerender(<Workbench suspended={false} />)
  await waitFor(() => expect(screen.getByTestId('workbench-search-input')).toHaveFocus())
  expect(screen.getByTestId('workbench-search-input')).toHaveValue('video settings')
  await user.click(screen.getByTestId('workbench-search-close-button'))
  await waitFor(() => expect(opener).toHaveFocus())
  expect(screen.queryByRole('dialog')).toBeNull()
})
