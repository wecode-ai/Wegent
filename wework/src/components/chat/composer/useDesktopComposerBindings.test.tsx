import { act, renderHook } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
import type { ComposerEditorHandle } from './ComposerProseMirrorEditor'
import { useDesktopComposerBindings } from './useDesktopComposerBindings'
import { OPEN_COMPOSER_SLASH_MENU_EVENT } from './composerEvents'
import { FOCUS_PLUGIN_TRIAL_COMPOSER_EVENT } from '@/features/plugins/pluginTrial'

vi.mock('@/features/dsh-runtime/dshExtensions', () => ({ getDshExtensionHost: () => undefined }))
const editorElements: HTMLElement[] = []
afterEach(() => {
  for (const element of editorElements) element.remove()
  editorElements.length = 0
  vi.restoreAllMocks()
})

function fixture(value = 'hello old tail', selectionStart = 6, selectionEnd = 9) {
  const element = document.createElement('div')
  element.contentEditable = 'true'
  document.body.append(element)
  editorElements.push(element)
  const editor = {
    element,
    focus: vi.fn(),
    setValue: vi.fn(),
    getSnapshot: vi.fn(() => ({ value, selectionStart, selectionEnd })),
  }
  const textareaFocus = vi.fn()
  const props = {
    value,
    valueRef: { current: value },
    editorRef: { current: editor as unknown as ComposerEditorHandle },
    textareaRef: { current: { focus: textareaFocus } as unknown as HTMLElement },
    commitEditorValue: vi.fn(),
    closeAutocompleteMenu: vi.fn(),
  }
  return { editor, textareaFocus, props }
}

test.each([
  ['hello old tail', 6, 9, 'hello / tail', 7],
  ['hello', 5, 5, 'hello /', 7],
] as const)(
  'opens the native slash menu preserving selection and whitespace for %s',
  (value, start, end, expected, cursor) => {
    const f = fixture(value, start, end)
    renderHook(useDesktopComposerBindings, { initialProps: f.props })
    act(() => window.dispatchEvent(new Event(OPEN_COMPOSER_SLASH_MENU_EVENT)))
    expect(f.props.commitEditorValue).toHaveBeenCalledExactlyOnceWith(expected, cursor)
    expect(f.editor.focus).toHaveBeenCalledOnce()
    expect(f.textareaFocus).toHaveBeenCalledOnce()
  }
)

test('uses the latest commit handler without changing native listener ordering', () => {
  const f = fixture()
  const addListener = vi.spyOn(window, 'addEventListener')
  const view = renderHook(useDesktopComposerBindings, { initialProps: f.props })
  const nextCommit = vi.fn()
  view.rerender({ ...f.props, commitEditorValue: nextCommit })
  act(() => window.dispatchEvent(new Event(OPEN_COMPOSER_SLASH_MENU_EVENT)))
  expect(f.props.commitEditorValue).not.toHaveBeenCalled()
  expect(nextCommit).toHaveBeenCalledExactlyOnceWith('hello / tail', 7)
  expect(
    addListener.mock.calls.filter(([type]) => type === OPEN_COMPOSER_SLASH_MENU_EVENT)
  ).toHaveLength(1)
})

test('waits for the requested trial text before focusing the latest editor content', () => {
  const f = fixture()
  const view = renderHook(useDesktopComposerBindings, { initialProps: f.props })
  act(() =>
    window.dispatchEvent(
      new CustomEvent(FOCUS_PLUGIN_TRIAL_COMPOSER_EVENT, { detail: { expectedValue: 'new draft' } })
    )
  )
  expect(f.editor.focus).not.toHaveBeenCalled()
  f.props.valueRef.current = 'new draft'
  view.rerender({ ...f.props, value: 'new draft' })
  expect(f.editor.setValue).toHaveBeenCalledExactlyOnceWith('new draft', 9)
  expect(f.editor.focus).toHaveBeenCalledOnce()
  expect(f.props.closeAutocompleteMenu).toHaveBeenCalledOnce()
})

test('does not mutate or focus the former editor after its host unmounts', () => {
  const f = fixture()
  const view = renderHook(useDesktopComposerBindings, { initialProps: f.props })
  view.unmount()
  act(() => {
    window.dispatchEvent(new Event(OPEN_COMPOSER_SLASH_MENU_EVENT))
    window.dispatchEvent(new CustomEvent(FOCUS_PLUGIN_TRIAL_COMPOSER_EVENT))
  })
  expect(f.props.commitEditorValue).not.toHaveBeenCalled()
  expect(f.editor.setValue).not.toHaveBeenCalled()
  expect(f.editor.focus).not.toHaveBeenCalled()
})
