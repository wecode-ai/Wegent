import '@/i18n'
import { fireEvent, render } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, test, vi } from 'vitest'
import { DiffCommentComposer } from './fileChangesReviewInteractions'

describe('DiffCommentComposer dismissal and shortcuts', () => {
  const selection = {
    key: 'src/example.ts:1-2',
    path: 'src/example.ts',
    range: { start: 1, end: 2, side: 'additions', endSide: 'additions' },
    selectedText: 'new first\ncontext',
    startLine: 1,
    endLine: 2,
  } as const

  function renderComposer(comment: string) {
    const onCancel = vi.fn()
    const onSubmit = vi.fn()
    const view = render(
      <div>
        <button type="button" data-testid="outside-button">
          Outside
        </button>
        <DiffCommentComposer
          selection={selection}
          comment={comment}
          onCommentChange={vi.fn()}
          onCancel={onCancel}
          onSubmit={onSubmit}
        />
      </div>
    )
    return {
      onCancel,
      onSubmit,
      input: view.getByTestId('file-changes-review-comment-input'),
      cancelButton: view.getByTestId('file-changes-review-comment-cancel-button'),
      outsideButton: view.getByTestId('outside-button'),
    }
  }

  test('submits on Cmd+Enter or Ctrl+Enter when the comment has text', async () => {
    const { onSubmit } = renderComposer('Looks good')

    await userEvent.keyboard('{Meta>}{Enter}{/Meta}')
    await userEvent.keyboard('{Control>}{Enter}{/Control}')

    expect(onSubmit).toHaveBeenCalledTimes(2)
  })

  test('does not submit a whitespace-only comment', async () => {
    const { onSubmit } = renderComposer('   ')
    await userEvent.keyboard('{Meta>}{Enter}{/Meta}')
    expect(onSubmit).not.toHaveBeenCalled()
  })

  test('ignores Escape while an IME composition is active', () => {
    const { onCancel, input } = renderComposer('')

    fireEvent.keyDown(input, { key: 'Escape', isComposing: true })

    expect(onCancel).not.toHaveBeenCalled()
  })

  test('ignores Cmd+Enter while an IME composition is active', () => {
    const { onSubmit, input } = renderComposer('确认')

    fireEvent.keyDown(input, { key: 'Enter', metaKey: true, isComposing: true })

    expect(onSubmit).not.toHaveBeenCalled()
  })
})
