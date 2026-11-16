import { CloudTodoModal } from '@/features/todo/CloudTodoModal'
import '@/i18n'
import { fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, test, vi } from 'vitest'
import { TextInputDialog } from './TextInputDialog'

describe('dialog keyboard behavior', () => {
  test('submits a project-space form from its name input', async () => {
    const onSubmit = vi.fn()
    render(
      <CloudTodoModal title="Project" onClose={vi.fn()} onSubmit={onSubmit}>
        <input aria-label="Project name" />
        <button type="submit">Save</button>
      </CloudTodoModal>
    )
    await userEvent.type(screen.getByLabelText('Project name'), 'Project{Enter}')
    expect(onSubmit).toHaveBeenCalledTimes(1)
  })

  test('keeps Tab inside the dialog and ignores IME Escape', async () => {
    const onClose = vi.fn()
    render(
      <TextInputDialog
        open
        title="Name"
        label="Name"
        initialValue="Original"
        confirmLabel="Save"
        cancelLabel="Cancel"
        inputTestId="input"
        confirmTestId="save"
        onSubmit={vi.fn()}
        onClose={onClose}
      />
    )
    fireEvent.keyDown(screen.getByTestId('input'), { key: 'Escape', isComposing: true })
    expect(onClose).not.toHaveBeenCalled()
    screen.getByTestId('save').focus()
    await userEvent.tab()
    expect(screen.getByTestId('input-close-button')).toHaveFocus()
    await userEvent.tab({ shift: true })
    expect(screen.getByTestId('save')).toHaveFocus()
  })
})
