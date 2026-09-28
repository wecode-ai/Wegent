import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, test, vi } from 'vitest'
import { ConfirmDialog } from './ConfirmDialog'

describe('ConfirmDialog keyboard defaults', () => {
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
