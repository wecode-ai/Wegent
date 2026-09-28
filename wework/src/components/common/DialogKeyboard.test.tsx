import { useState } from 'react'
import { fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, test, vi } from 'vitest'
import { CloudTodoModal } from '@/features/todo/CloudTodoModal'
import { MenuSelect } from './MenuSelect'
import { DialogForm } from './DialogForm'
import { TextInputDialog } from './TextInputDialog'
import '@/i18n'

function NestedDialogs({ onClose, pending = false }: { onClose: () => void; pending?: boolean }) {
  const [child, setChild] = useState(false)
  return (
    <CloudTodoModal title="Parent" onClose={onClose}>
      <button type="button" onClick={() => setChild(true)}>
        Open child
      </button>
      {child && (
        <CloudTodoModal title="Child" onClose={() => setChild(false)} pending={pending}>
          <input aria-label="Child name" />
        </CloudTodoModal>
      )}
    </CloudTodoModal>
  )
}

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

  test('closes only the top dialog after parent rerenders and restores the trigger focus', async () => {
    const onClose = vi.fn()
    const { rerender } = render(<NestedDialogs onClose={onClose} />)
    const trigger = screen.getByRole('button', { name: 'Open child' })
    await userEvent.click(trigger)
    expect(screen.getByLabelText('Child name')).toHaveFocus()
    rerender(<NestedDialogs onClose={onClose} />)
    await userEvent.keyboard('{Escape}')
    expect(screen.queryByRole('dialog', { name: 'Child' })).not.toBeInTheDocument()
    expect(onClose).not.toHaveBeenCalled()
    expect(trigger).toHaveFocus()
    await userEvent.keyboard('{Escape}')
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  test('a busy dialog consumes Escape without closing its parent', async () => {
    const onClose = vi.fn()
    render(<NestedDialogs onClose={onClose} pending />)
    await userEvent.click(screen.getByRole('button', { name: 'Open child' }))
    await userEvent.keyboard('{Escape}')
    expect(screen.getByRole('dialog', { name: 'Child' })).toBeInTheDocument()
    expect(onClose).not.toHaveBeenCalled()
  })

  test('a menu inside a dialog consumes the first Escape', async () => {
    const onClose = vi.fn()
    render(
      <CloudTodoModal title="Settings" onClose={onClose}>
        <MenuSelect
          testId="dialog-select"
          value="one"
          onChange={vi.fn()}
          options={[
            { value: 'one', label: 'One' },
            { value: 'two', label: 'Two' },
          ]}
        />
      </CloudTodoModal>
    )
    await userEvent.click(screen.getByTestId('dialog-select'))
    expect(screen.getByText('Two')).toBeInTheDocument()
    await userEvent.keyboard('{Escape}')
    expect(screen.queryByText('Two')).not.toBeInTheDocument()
    expect(onClose).not.toHaveBeenCalled()
    await userEvent.keyboard('{Escape}')
    expect(onClose).toHaveBeenCalledTimes(1)
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

  test('Enter adds a newline in a multiline field and does not submit a parent from a child dialog', async () => {
    const onSubmit = vi.fn(event => event.preventDefault())
    render(
      <DialogForm role="dialog" onSubmit={onSubmit}>
        <textarea aria-label="Description" />
        <div role="dialog">
          <input aria-label="Nested name" />
        </div>
        <button type="submit">Save</button>
      </DialogForm>
    )
    await userEvent.type(screen.getByLabelText('Description'), 'First{Enter}Second')
    expect(screen.getByLabelText('Description')).toHaveValue('First\nSecond')
    await userEvent.type(screen.getByLabelText('Nested name'), 'Child{Enter}')
    expect(onSubmit).not.toHaveBeenCalled()
  })
})
