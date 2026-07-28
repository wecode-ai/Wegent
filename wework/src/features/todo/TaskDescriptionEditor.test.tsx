import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { TaskDescriptionEditor } from './TaskDescriptionEditor'
import { normalizeTaskDescription } from './taskDescription'

describe('TaskDescriptionEditor', () => {
  it('treats legacy empty HTML as an empty description', async () => {
    render(<TaskDescriptionEditor value="<p></p>" onChange={vi.fn()} />)

    const editor = await screen.findByTestId('cloud-todo-detail-description')
    expect(normalizeTaskDescription('<p></p>')).toBe('')
    expect(normalizeTaskDescription('&lt;p&gt;&lt;br&gt;&lt;/p&gt;')).toBe('')
    expect(editor).not.toHaveTextContent('<p></p>')
  })

  it('edits Markdown content and exposes rich text commands', async () => {
    const onChange = vi.fn()
    const user = userEvent.setup()
    render(<TaskDescriptionEditor value="**Existing description**" onChange={onChange} />)

    const editor = await screen.findByTestId('cloud-todo-detail-description')
    await user.click(editor)
    await user.click(screen.getByTestId('cloud-todo-description-task-list'))

    expect(onChange).toHaveBeenCalled()
    expect(screen.getByTestId('cloud-todo-description-toolbar')).toHaveClass('opacity-100')
    expect(screen.getByTestId('cloud-todo-description-bold')).toBeEnabled()
    expect(onChange.mock.calls.at(-1)?.[0]).toContain('[ ]')
  })

  it('keeps the editor focused and editable after applying a block format', async () => {
    const onChange = vi.fn()
    const user = userEvent.setup()
    render(<TaskDescriptionEditor value="" onChange={onChange} />)

    const editor = await screen.findByTestId('cloud-todo-detail-description')
    await user.click(editor)
    await user.click(screen.getByTestId('cloud-todo-description-bullet-list'))

    expect(editor).toHaveFocus()
    await user.keyboard('List item')
    expect(onChange.mock.calls.at(-1)?.[0]).toContain('List item')
  })
})
