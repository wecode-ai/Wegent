import '@/i18n'
import { fireEvent, render, screen } from '@testing-library/react'
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

describe('DiffCommentComposer keyboard shortcuts', () => {
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
    render(
      <DiffCommentComposer
        selection={selection}
        comment={comment}
        onCommentChange={vi.fn()}
        onCancel={onCancel}
        onSubmit={onSubmit}
      />
    )
    return { onCancel, onSubmit, input: screen.getByTestId('file-changes-review-comment-input') }
  }

  test('cancels on Escape without reaching document listeners', async () => {
    const documentEscape = vi.fn()
    document.addEventListener('keydown', documentEscape)
    const { onCancel, onSubmit, input } = renderComposer('Looks good')

    expect(input).toHaveFocus()
    await userEvent.keyboard('{Escape}')

    expect(onCancel).toHaveBeenCalledTimes(1)
    expect(onSubmit).not.toHaveBeenCalled()
    expect(documentEscape).not.toHaveBeenCalled()
    document.removeEventListener('keydown', documentEscape)
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

  test('ignores shortcuts while an IME composition is active', () => {
    const { onCancel, onSubmit, input } = renderComposer('确认')

    fireEvent.keyDown(input, { key: 'Escape', isComposing: true })
    fireEvent.keyDown(input, { key: 'Enter', metaKey: true, isComposing: true })

    expect(onCancel).not.toHaveBeenCalled()
    expect(onSubmit).not.toHaveBeenCalled()
  })
})
