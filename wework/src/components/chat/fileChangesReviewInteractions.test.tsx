import '@/i18n'
import { fireEvent, render } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, test, vi } from 'vitest'
import { DiffCommentComposer } from './fileChangesReviewInteractions'
import {
  getDiffSelection,
  getHunkActionAnchor,
  getHunkPatches,
  getOpenSourceLine,
} from './fileChangesReviewUtils'

const patch = [
  'diff --git a/src/example.ts b/src/example.ts',
  '--- a/src/example.ts',
  '+++ b/src/example.ts',
  '@@ -1,2 +1,2 @@',
  '-old first',
  '+new first',
  ' context',
  '@@ -10 +10 @@',
  '-old second',
  '+new second',
  '',
].join('\n')

describe('fileChangesReviewInteractions', () => {
  test('builds individual hunk patches with the file header', () => {
    const hunks = getHunkPatches(patch)

    expect(hunks).toHaveLength(2)
    expect(hunks[1]).toContain('@@ -10 +10 @@')
    expect(hunks[1]).not.toContain('@@ -1,2 +1,2 @@')
  })

  test('maps a selected additions range back to source text and line numbers', () => {
    expect(
      getDiffSelection(patch, {
        start: 1,
        end: 2,
        side: 'additions',
        endSide: 'additions',
      })
    ).toEqual({
      selectedText: 'new first\ncontext',
      startLine: 1,
      endLine: 2,
    })
  })

  test('opens only addition-side line numbers in the current source file', () => {
    expect(getOpenSourceLine({ annotationSide: 'additions', lineNumber: 12 })).toBe(12)
    expect(getOpenSourceLine({ annotationSide: 'deletions', lineNumber: 8 })).toBeNull()
  })

  test('anchors hunk actions to the final changed line like ChatGPT', () => {
    expect(getHunkActionAnchor(getHunkPatches(patch)[0])).toEqual({
      side: 'additions',
      lineNumber: 1,
    })
    expect(
      getHunkActionAnchor(
        [
          'diff --git a/src/example.ts b/src/example.ts',
          '--- a/src/example.ts',
          '+++ b/src/example.ts',
          '@@ -7,2 +7,0 @@',
          '-removed one',
          '-removed two',
        ].join('\n')
      )
    ).toEqual({
      side: 'deletions',
      lineNumber: 8,
    })
  })
})

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

  test('closes an empty comment on Escape wherever focus is', async () => {
    const windowEscape = vi.fn()
    window.addEventListener('keydown', windowEscape)
    const { onCancel, input } = renderComposer('   ')

    expect(input).toHaveFocus()
    await userEvent.keyboard('{Escape}')
    input.blur()
    await userEvent.keyboard('{Escape}')

    expect(onCancel).toHaveBeenCalledTimes(2)
    expect(windowEscape).not.toHaveBeenCalled()
    window.removeEventListener('keydown', windowEscape)
  })

  test('keeps a draft open on Escape without reaching other listeners', async () => {
    const documentEscape = vi.fn()
    document.addEventListener('keydown', documentEscape)
    const { onCancel, cancelButton } = renderComposer('Looks good')

    await userEvent.keyboard('{Escape}')
    cancelButton.focus()
    await userEvent.keyboard('{Escape}')

    expect(onCancel).not.toHaveBeenCalled()
    expect(documentEscape).not.toHaveBeenCalled()
    document.removeEventListener('keydown', documentEscape)
  })

  test('closes an empty comment on outside clicks but not inside clicks', async () => {
    const { onCancel, cancelButton, input, outsideButton } = renderComposer('')

    await userEvent.click(input)
    expect(onCancel).not.toHaveBeenCalled()

    await userEvent.click(outsideButton)
    expect(onCancel).toHaveBeenCalledTimes(1)

    await userEvent.click(cancelButton)
    expect(onCancel).toHaveBeenCalledTimes(2)
  })

  test('stays open when an outside press starts a new diff line selection', () => {
    const { onCancel, outsideButton } = renderComposer('')
    outsideButton.addEventListener('pointerdown', event => event.preventDefault())

    fireEvent.pointerDown(outsideButton)

    expect(onCancel).not.toHaveBeenCalled()
  })

  test('keeps a draft open on outside clicks', async () => {
    const { onCancel, outsideButton } = renderComposer('Looks good')

    await userEvent.click(outsideButton)

    expect(onCancel).not.toHaveBeenCalled()
  })

  test('submits on Cmd+Enter or Ctrl+Enter when the comment has text', async () => {
    const { onSubmit } = renderComposer('Looks good')

    await userEvent.keyboard('{Meta>}{Enter}{/Meta}')
    await userEvent.keyboard('{Control>}{Enter}{/Control}')

    expect(onSubmit).toHaveBeenCalledTimes(2)
  })

  test('does not submit on plain Enter', async () => {
    const { onSubmit } = renderComposer('Looks good')
    await userEvent.keyboard('{Enter}')
    expect(onSubmit).not.toHaveBeenCalled()
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
