import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, test, vi } from 'vitest'
import { TextInputDialog } from './TextInputDialog'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

describe('TextInputDialog', () => {
  test('focuses the input and keeps actions touch friendly', () => {
    render(
      <TextInputDialog
        open
        title="重命名项目"
        label="项目名称"
        description="保持简短且易于识别"
        initialValue="hello"
        confirmLabel="保存"
        cancelLabel="取消"
        inputTestId="rename-project-input"
        confirmTestId="confirm-rename-project-button"
        maxLength={255}
        onClose={vi.fn()}
        onSubmit={vi.fn()}
      />
    )

    expect(screen.getByTestId('rename-project-input')).toHaveFocus()
    expect(screen.getByRole('textbox', { name: '项目名称' })).toHaveAccessibleDescription(
      '保持简短且易于识别'
    )
    expect(screen.getByRole('dialog')).toHaveClass(
      'bg-popover',
      'text-text-primary',
      'border-border'
    )
    expect(screen.getByTestId('rename-project-input')).toHaveClass(
      'bg-background',
      'text-text-primary',
      'border-border',
      'focus:border-blue-500',
      'focus:ring-blue-500/20'
    )
    expect(screen.getByTestId('rename-project-input')).toHaveAttribute('maxlength', '255')
    expect(screen.getByTestId('rename-project-input')).not.toHaveClass(
      'focus:border-primary',
      'focus:ring-primary/20'
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

  test('submits a trimmed non-empty value with Enter and ignores an empty value', async () => {
    const onClose = vi.fn()
    const onSubmit = vi.fn().mockResolvedValue(undefined)

    render(
      <TextInputDialog
        open
        title="重命名项目"
        label="项目名称"
        initialValue="   "
        confirmLabel="保存"
        cancelLabel="取消"
        inputTestId="rename-project-input"
        confirmTestId="confirm-rename-project-button"
        onClose={onClose}
        onSubmit={onSubmit}
      />
    )

    const input = screen.getByTestId('rename-project-input')
    await userEvent.keyboard('{Enter}')
    expect(onSubmit).not.toHaveBeenCalled()

    await userEvent.type(input, '  hello  ')
    await userEvent.keyboard('{Enter}')

    await waitFor(() => expect(onSubmit).toHaveBeenCalledWith('hello'))
    expect(onSubmit).toHaveBeenCalledTimes(1)
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  test('disables every action while submitting and ignores click plus Enter duplicate attempts', async () => {
    const submitRequest = deferred<void>()
    const onClose = vi.fn()
    const onSubmit = vi.fn(() => submitRequest.promise)

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
        onSubmit={onSubmit}
      />
    )

    const input = screen.getByTestId('rename-project-input')
    const closeButton = screen.getByTestId('rename-project-input-close-button')
    const cancelButton = screen.getByTestId('rename-project-input-cancel-button')
    const confirmButton = screen.getByTestId('confirm-rename-project-button')
    const form = confirmButton.closest('form')
    expect(form).not.toBeNull()

    act(() => {
      fireEvent.click(confirmButton)
      fireEvent.keyDown(input, { key: 'Enter', code: 'Enter' })
      fireEvent.submit(form!)
    })

    expect(onSubmit).toHaveBeenCalledTimes(1)
    expect(input).toBeDisabled()
    expect(closeButton).toBeDisabled()
    expect(cancelButton).toBeDisabled()
    expect(confirmButton).toBeDisabled()

    fireEvent.keyDown(document, { key: 'Escape' })
    fireEvent.click(screen.getByTestId('rename-project-input-overlay'))
    fireEvent.click(closeButton)
    fireEvent.click(cancelButton)
    expect(onClose).not.toHaveBeenCalled()

    await act(async () => {
      submitRequest.resolve(undefined)
    })

    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1))
  })

  test('preserves the edited value and error after rejection so submission can be retried', async () => {
    const onClose = vi.fn()
    const onSubmit = vi
      .fn<(value: string) => Promise<void>>()
      .mockRejectedValueOnce(new Error('名称已存在'))
      .mockResolvedValueOnce(undefined)

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
        onSubmit={onSubmit}
      />
    )

    const input = screen.getByTestId('rename-project-input')
    await userEvent.clear(input)
    await userEvent.type(input, '  retry name  ')
    await userEvent.click(screen.getByTestId('confirm-rename-project-button'))

    expect(await screen.findByRole('alert')).toHaveTextContent('名称已存在')
    expect(input).toHaveValue('  retry name  ')
    expect(screen.getByRole('dialog')).toBeInTheDocument()
    expect(onClose).not.toHaveBeenCalled()

    await userEvent.click(screen.getByTestId('confirm-rename-project-button'))
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1))
    expect(onSubmit).toHaveBeenNthCalledWith(1, 'retry name')
    expect(onSubmit).toHaveBeenNthCalledWith(2, 'retry name')
  })

  test('traps keyboard focus inside the dialog and restores focus after closing', async () => {
    const onClose = vi.fn()
    const view = (open: boolean) => (
      <>
        <button type="button" data-testid="background-trigger">
          Open
        </button>
        <button type="button" data-testid="background-action">
          Background action
        </button>
        <TextInputDialog
          open={open}
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
      </>
    )
    const { rerender } = render(view(false))
    const trigger = screen.getByTestId('background-trigger')
    trigger.focus()

    rerender(view(true))
    expect(screen.getByTestId('rename-project-input')).toHaveFocus()

    await userEvent.tab()
    expect(screen.getByTestId('rename-project-input-cancel-button')).toHaveFocus()
    await userEvent.tab()
    expect(screen.getByTestId('confirm-rename-project-button')).toHaveFocus()
    await userEvent.tab()
    expect(screen.getByTestId('rename-project-input-close-button')).toHaveFocus()
    await userEvent.tab({ shift: true })
    expect(screen.getByTestId('confirm-rename-project-button')).toHaveFocus()
    expect(screen.getByTestId('background-action')).not.toHaveFocus()

    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)
    rerender(view(false))
    expect(trigger).toHaveFocus()
  })
})
