import { act, fireEvent, render, screen } from '@testing-library/react'
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

  test('submits the trimmed name on Enter and blocks repeat submission and dismissal while saving', async () => {
    let resolveSave!: () => void
    const onSubmit = vi.fn(
      () =>
        new Promise<void>(resolve => {
          resolveSave = resolve
        })
    )
    const onClose = vi.fn()
    render(<TextInputDialog {...props} onSubmit={onSubmit} onClose={onClose} />)
    const input = screen.getByTestId('rename-input')
    await userEvent.clear(input)
    await userEvent.type(input, '  Renamed  {Enter}')
    expect(onSubmit).toHaveBeenCalledExactlyOnceWith('Renamed')
    expect(onClose).not.toHaveBeenCalled()
    expect(input).toBeDisabled()
    await userEvent.keyboard('{Enter}{Escape}')
    expect(onSubmit).toHaveBeenCalledTimes(1)
    expect(onClose).not.toHaveBeenCalled()
    await act(async () => resolveSave())
    expect(onClose).toHaveBeenCalledTimes(1)
  })

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

  test('focuses the input and keeps actions touch friendly', () => {
    render(
      <TextInputDialog
        open
        title="重命名项目"
        label="项目名称"
        initialValue="hello"
        confirmLabel="保存"
        cancelLabel="取消"
        inputTestId="rename-project-input"
        confirmTestId="confirm-rename-project-button"
        onClose={vi.fn()}
        onSubmit={vi.fn()}
      />
    )

    expect(screen.getByTestId('rename-project-input')).toHaveFocus()
    expect(screen.getByRole('dialog')).toHaveClass(
      'bg-popover',
      'text-text-primary',
      'border-border'
    )
    expect(screen.getByTestId('rename-project-input')).toHaveClass(
      'bg-background',
      'text-text-primary',
      'border-border'
    )
    expect(screen.getByTestId('confirm-rename-project-button')).toHaveClass(
      'h-11',
      'bg-text-primary',
      'text-background'
    )
    expect(screen.getByTestId('confirm-rename-project-button')).not.toHaveClass(
      'bg-[#14b8a6]',
      'hover:bg-[#0f9f93]'
    )
    expect(screen.getByRole('dialog')).not.toHaveClass('bg-white')
    expect(screen.getByTestId('rename-project-input-cancel-button')).toHaveClass(
      'h-11',
      'text-text-primary',
      'border-border'
    )
  })

  test('closes when Escape is pressed', () => {
    const onClose = vi.fn()

    render(
      <TextInputDialog
        open
        title="重命名项目"
        label="项目名称"
        initialValue="hello"
        confirmLabel="保存"
        cancelLabel="取消"
        inputTestId="rename-project-input"
        confirmTestId="confirm-rename-project-button"
        onClose={onClose}
        onSubmit={vi.fn()}
      />
    )

    expect(screen.getByTestId('rename-project-input')).toBeInTheDocument()

    fireEvent.keyDown(document, { key: 'Escape' })

    expect(onClose).toHaveBeenCalledTimes(1)
  })
})
