import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, test, vi } from 'vitest'
import { ConfirmDialog } from './ConfirmDialog'

describe('ConfirmDialog keyboard defaults', () => {
  test('bounds long descriptions in a scrollable body without shrinking the action row', async () => {
    const onClose = vi.fn()
    const description = 'Very long unbroken description'.repeat(2000)
    render(
      <ConfirmDialog
        open
        title="Verify authorization"
        description={description}
        cancelLabel="Cancel"
        confirmLabel="Retry"
        confirmTestId="verify"
        onConfirm={vi.fn()}
        onClose={onClose}
      />
    )
    const dialog = screen.getByRole('dialog')
    expect(dialog).toHaveClass('max-h-[calc(100dvh-2rem)]', 'flex-col')
    expect(dialog).toHaveAccessibleDescription(description)
    expect(screen.getByText(description)).toHaveClass('min-h-0', 'overflow-y-auto', 'break-words')
    expect(screen.getByTestId('verify').parentElement).toHaveClass('shrink-0', 'flex-wrap')
    await waitFor(() => expect(screen.getByTestId('verify')).toHaveFocus())
    await userEvent.keyboard('{Escape}')
    expect(onClose).toHaveBeenCalledOnce()
  })

  test.each([false, true])(
    'uses the appropriate default action when destructive=%s',
    async destructive => {
      const onConfirm = vi.fn()
      const onClose = vi.fn()
      render(
        <ConfirmDialog
          open
          title="Confirm"
          description="Description"
          cancelLabel="Cancel"
          confirmLabel="Confirm"
          confirmTestId="confirm"
          destructive={destructive}
          onConfirm={onConfirm}
          onClose={onClose}
        />
      )
      await waitFor(() =>
        expect(screen.getByTestId(destructive ? 'confirm-cancel-button' : 'confirm')).toHaveFocus()
      )
      await userEvent.keyboard('{Enter}')
      expect(destructive ? onClose : onConfirm).toHaveBeenCalledTimes(1)
      expect(destructive ? onConfirm : onClose).not.toHaveBeenCalled()
    }
  )
})
