import '@/i18n'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeAll, beforeEach, expect, test, vi } from 'vitest'
import { getSharedHighlighter } from '@pierre/diffs'
import { Editor } from '@pierre/diffs/edit'
import type { ReactNode } from 'react'
import { WorkspaceFilePreview } from './WorkspaceFilePreview'
import { SELECTED_TEXT_CHANGED_EVENT } from '@/lib/selected-text-drag'

vi.mock('@/components/code/PierreCodeProvider', () => ({
  PierreCodeProvider: ({ children }: { children: ReactNode }) => children,
}))
vi.mock('@/components/chat/AssistantMarkdown', () => ({ AssistantMarkdown: () => null }))

const editSpy = vi.spyOn(Editor.prototype, 'edit')
const file = {
  path: '/workspace/auth.ts',
  name: 'auth.ts',
  content: 'export const authenticated = false',
  revision: 'revision-1',
  editable: true,
  truncated: false,
  size: 34,
}
const props = { file, loading: false, onRetry: vi.fn(), onSave: vi.fn() }

beforeAll(async () => {
  await getSharedHighlighter({
    langs: ['typescript', 'text'],
    themes: ['pierre-light', 'pierre-dark'],
    preferredHighlighter: 'highlights',
  })
})
beforeEach(() => {
  document.documentElement.dataset.theme = 'light'
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(600)
  Element.prototype.scrollIntoView = vi.fn()
  HTMLElement.prototype.scrollTo = function (options?: ScrollToOptions | number) {
    if (typeof options === 'object') this.scrollTop = options.top ?? this.scrollTop
  }
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
    measureText: (text: string) => ({ width: text.length * 8 }),
  } as CanvasRenderingContext2D)
  editSpy.mockClear()
})
async function currentEditor() {
  await waitFor(() =>
    expect(
      document
        .querySelector('diffs-container')
        ?.shadowRoot?.querySelector('[data-testid="workspace-file-editor-content"]')
    ).not.toBeNull()
  )
  return editSpy.mock.contexts.at(-1) as Editor
}
function replaceText(editor: Editor, text: string) {
  const lines = editor.getText().split('\n')
  act(() =>
    editor.applyEdits([
      {
        range: {
          start: { line: 0, character: 0 },
          end: { line: lines.length - 1, character: lines.at(-1)!.length },
        },
        newText: text,
      },
    ])
  )
}

test('uses the same CodeView for reading and editing, with an existing draft', async () => {
  const { rerender } = render(<WorkspaceFilePreview {...props} />)
  const view = screen.getByTestId('workspace-file-preview-code-view')
  rerender(<WorkspaceFilePreview {...props} editing editedContent="const draft = 1" />)
  const editor = await currentEditor()
  expect(screen.getByTestId('workspace-file-preview-code-view')).toBe(view)
  expect(screen.getByTestId('workspace-file-editor')).toHaveAttribute('data-pierre-editor-surface')
  expect(editor.getText()).toBe('const draft = 1')
  expect(
    view
      .querySelector('diffs-container')
      ?.shadowRoot?.querySelector('[data-testid="workspace-file-editor-content"]')
  ).not.toBeNull()
  rerender(
    <WorkspaceFilePreview
      {...props}
      file={{ ...file, content: 'const draft = 1', revision: 'saved' }}
    />
  )
  await waitFor(() =>
    expect(
      view
        .querySelector('diffs-container')
        ?.shadowRoot?.querySelector('[data-testid="workspace-file-editor-content"]')
    ).toBeNull()
  )
  expect(screen.getByTestId('workspace-file-preview-code-view')).toBe(view)
  expect(view.querySelector('diffs-container')?.shadowRoot?.textContent).toContain(
    'const draft = 1'
  )
})

test('preserves edits and undo history across theme changes and an older save response', async () => {
  const onChange = vi.fn()
  const { rerender } = render(
    <WorkspaceFilePreview {...props} editing onEditedContentChange={onChange} />
  )
  const editor = await currentEditor()
  replaceText(editor, 'const first = 1')
  replaceText(editor, 'const second = 2')
  document.documentElement.dataset.theme = 'dark'
  rerender(
    <WorkspaceFilePreview
      {...props}
      editing
      file={{ ...file, content: 'const first = 1', revision: 'saved' }}
      editedContent="const second = 2"
      onEditedContentChange={onChange}
    />
  )
  expect(screen.getByTestId('workspace-file-editor')).toHaveAttribute('data-theme', 'dark')
  expect(editor.getText()).toBe('const second = 2')
  act(() => editor.undo())
  expect(editor.getText()).toBe('const first = 1')
  act(() => editor.undo())
  expect(editor.getText()).toBe(file.content)
  act(() => editor.redo())
  expect(onChange).toHaveBeenLastCalledWith('const first = 1')
  fireEvent.keyDown(screen.getByTestId('workspace-file-editor'), { key: 's', metaKey: true })
  expect(props.onSave).toHaveBeenCalled()
})

test('selects the requested line and publishes draggable text, clearing it on unmount', async () => {
  const selection = vi.fn()
  window.addEventListener(SELECTED_TEXT_CHANGED_EVENT, selection)
  const { unmount } = render(
    <WorkspaceFilePreview
      {...props}
      editing
      file={{ ...file, content: 'first\nsecond\nthird' }}
      targetLineStart={2}
      targetLineEnd={2}
    />
  )
  const editor = await currentEditor()
  expect(editor.getViewState().selections?.[0]).toMatchObject({
    start: { line: 1, character: 0 },
    end: { line: 1, character: 6 },
  })
  expect(selection.mock.calls.some(([event]) => event.detail.text === 'second')).toBe(true)
  const setData = vi.fn()
  fireEvent.dragStart(screen.getByTestId('workspace-file-editor'), { dataTransfer: { setData } })
  expect(setData).toHaveBeenCalledWith('text/plain', 'second')
  unmount()
  expect(selection.mock.lastCall?.[0].detail.text).toBeNull()
  window.removeEventListener(SELECTED_TEXT_CHANGED_EVENT, selection)
})

test('replaces the document on an accepted external reload of the same path', async () => {
  const onChange = vi.fn()
  const { rerender } = render(
    <WorkspaceFilePreview {...props} editing loadVersion={1} onEditedContentChange={onChange} />
  )
  const view = screen.getByTestId('workspace-file-preview-code-view')
  const original = await currentEditor()
  replaceText(original, 'const local = 1')
  const external = 'const external = 2'
  rerender(
    <WorkspaceFilePreview
      {...props}
      file={{ ...file, content: external, revision: 'external-revision' }}
      editing
      editedContent={external}
      loadVersion={2}
      onEditedContentChange={onChange}
    />
  )
  await waitFor(() => expect((editSpy.mock.contexts.at(-1) as Editor).getText()).toBe(external))
  const refreshed = await currentEditor()
  expect(screen.getByTestId('workspace-file-preview-code-view')).toBe(view)
  act(() => refreshed.undo())
  expect(refreshed.getText()).toBe(external)
  replaceText(refreshed, `${external}\nconst next = 3`)
  expect(onChange).toHaveBeenLastCalledWith(`${external}\nconst next = 3`)
})

test('refreshes readonly content even when the new revision has the same length', async () => {
  const { rerender } = render(<WorkspaceFilePreview {...props} />)
  const view = screen.getByTestId('workspace-file-preview-code-view')
  rerender(
    <WorkspaceFilePreview
      {...props}
      file={{ ...file, content: 'export const authenticated = true ', revision: 'revision-2' }}
    />
  )
  await waitFor(() =>
    expect(view.querySelector('diffs-container')?.shadowRoot?.textContent).toContain(
      'authenticated = true'
    )
  )
})
