import { fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, test, vi } from 'vitest'
import { TextInputDialog } from './TextInputDialog'

describe('TextInputDialog', () => {
  const props = {
    open: true,
    title: 'Rename',
    label: 'Name',
    initialValue: 'Original',
    confirmLabel: 'Save',
    cancelLabel: 'Cancel',
    inputTestId: 'rename-input',
    confirmTestId: 'rename-save',
  }

  test('keeps the draft after a failed Enter submission and allows retry', async () => {
    const onSubmit = vi
      .fn()
      .mockRejectedValueOnce(new Error('Save failed'))
      .mockResolvedValueOnce(undefined)
    const onClose = vi.fn()
    render(<TextInputDialog {...props} onSubmit={onSubmit} onClose={onClose} />)
    await userEvent.keyboard('{Enter}')
    expect(await screen.findByText('Save failed')).toBeInTheDocument()
    expect(screen.getByTestId('rename-input')).toHaveValue('Original')
    expect(onClose).not.toHaveBeenCalled()
    await userEvent.click(screen.getByTestId('rename-input'))
    await userEvent.keyboard('{Enter}')
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  test('does not submit empty names, IME confirmation, modified Enter, or key repeat', async () => {
    const onSubmit = vi.fn()
    render(<TextInputDialog {...props} onSubmit={onSubmit} onClose={vi.fn()} />)
    const input = screen.getByTestId('rename-input')
    for (const detail of [
      { isComposing: true },
      { keyCode: 229 },
      { repeat: true },
      { shiftKey: true },
      { metaKey: true },
    ]) {
      expect(fireEvent.keyDown(input, { key: 'Enter', ...detail })).toBe(false)
    }
    await userEvent.clear(input)
    await userEvent.type(input, '   {Enter}')
    expect(onSubmit).not.toHaveBeenCalled()
  })
})
