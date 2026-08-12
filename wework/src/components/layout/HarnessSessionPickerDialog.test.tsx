import { act, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { describe, expect, test, vi } from 'vitest'
import '@/i18n'
import { HarnessSessionPickerDialog } from './HarnessSessionPickerDialog'

function createDeferred() {
  let resolve!: () => void
  const promise = new Promise<void>(resolvePromise => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}

describe('HarnessSessionPickerDialog', () => {
  test('does not let a completed stale submission close a reopened dialog', async () => {
    const submission = createDeferred()
    const onSelect = vi.fn(() => submission.promise)

    function TestDialog() {
      const [open, setOpen] = useState(true)

      return (
        <>
          <button type="button" onClick={() => setOpen(true)}>
            Reopen
          </button>
          <HarnessSessionPickerDialog
            open={open}
            options={[
              { id: 'opencode', disabled: false, models: [], selectedModel: null },
              { id: 'claude_code', disabled: false, models: [], selectedModel: null },
            ]}
            onClose={() => setOpen(false)}
            onSelect={onSelect}
          />
        </>
      )
    }

    render(<TestDialog />)

    await userEvent.click(screen.getByTestId('harness-session-picker-create-button'))
    await userEvent.click(screen.getByTestId('harness-session-picker-close-button'))
    await userEvent.click(screen.getByRole('button', { name: 'Reopen' }))
    await userEvent.click(screen.getByTestId('harness-session-picker-option-claude_code'))

    act(() => submission.resolve())

    expect(await screen.findByTestId('harness-session-picker')).toBeInTheDocument()
    expect(screen.getByTestId('harness-session-picker-option-claude_code')).toHaveAttribute(
      'aria-pressed',
      'true'
    )
  })
})
