import { act, fireEvent, render, screen } from '@testing-library/react'
import type { ReactElement } from 'react'
import { expect, test, vi } from 'vitest'
import type { TaskDescriptionEditorProps } from './TaskDescriptionEditorContent'
import { TaskDescriptionEditor } from './TaskDescriptionEditor'

const loading = vi.hoisted(() =>
  Promise.withResolvers<{
    TaskDescriptionEditor: (props: TaskDescriptionEditorProps) => ReactElement
  }>()
)

vi.mock('./TaskDescriptionEditorContent', () => loading.promise)

test('retains current description and callbacks while the editor is loading', async () => {
  const previousChange = vi.fn()
  const currentChange = vi.fn()
  const { rerender } = render(
    <TaskDescriptionEditor value="old" onChange={previousChange} className="min-h-20" />
  )
  expect(screen.getByTestId('cloud-todo-detail-description-loading')).toHaveAttribute(
    'aria-busy',
    'true'
  )
  rerender(<TaskDescriptionEditor value="current" onChange={currentChange} />)

  await act(async () => {
    loading.resolve({
      TaskDescriptionEditor: props => (
        <button data-testid="loaded-editor" onClick={() => props.onChange(props.value)}>
          {props.value}
        </button>
      ),
    })
  })
  fireEvent.click(await screen.findByTestId('loaded-editor'))

  expect(currentChange).toHaveBeenCalledWith('current')
  expect(previousChange).not.toHaveBeenCalled()
  expect(screen.queryByTestId('cloud-todo-detail-description-loading')).not.toBeInTheDocument()
})
