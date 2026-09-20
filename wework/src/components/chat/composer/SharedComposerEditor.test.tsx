import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { createRef } from 'react'
import { describe, expect, test, vi } from 'vitest'
import {
  ComposerProseMirrorEditor,
  LinkEditPopover,
  type ComposerEditorHandle,
  type ComposerEditorServices,
} from '@wegent/collaboration/composer'
import { ConversationTranslationProvider } from '@wegent/collaboration/conversation'
import { createCollaborationTranslator } from '@wegent/collaboration'
import { CollaborationTheme } from '@wegent/collaboration/theme'
import { MarkdownServicesProvider, browserMarkdownServices } from '@wegent/collaboration/markdown'

function renderEditor(value = '', services?: ComposerEditorServices) {
  const ref = createRef<ComposerEditorHandle>()
  const textareaRef = createRef<HTMLElement>()
  const onChange = vi.fn()
  const result = render(
    <ComposerProseMirrorEditor
      ref={ref}
      services={services}
      value={value}
      onChange={onChange}
      onSnapshotChange={vi.fn()}
      onKeyDown={() => false}
      onBeforeInput={() => false}
      onKeyUp={vi.fn()}
      onCompositionStart={vi.fn()}
      onCompositionEnd={vi.fn()}
      onPaste={() => false}
      onDrop={() => false}
      onClick={vi.fn()}
      onFocus={vi.fn()}
      placeholder="Message"
      testId="shared-editor"
      rows={2}
      textareaRef={textareaRef}
      className="min-h-12"
    />
  )
  return { ...result, ref, onChange, editor: screen.getByTestId('shared-editor') }
}

describe('shared rich editor in a browser host', () => {
  test.each([
    '[test-label](~/workspace/skills/test-skill/SKILL.md)',
    '**bold**',
    '# Heading',
    '- List item',
    '> Quote',
  ])('keeps the caret and subsequent input after a Markdown line break: %s', markdown => {
    const { ref, editor } = renderEditor(markdown, {
      preserveNativeEmptyCaret: false,
      isWindowFocused: () => true,
      subscribeWindowFocus: () => () => undefined,
    })
    act(() => {
      ref.current!.setValue(markdown, markdown.length)
      ref.current!.focus()
      ref.current!.insertLineBreak()
    })
    expect(editor).toHaveFocus()
    expect(editor).toHaveAttribute('data-composer-focus-visible')
    expect(editor.querySelector('.composer-empty-caret')).not.toBeNull()
    expect(editor.contains(window.getSelection()!.anchorNode)).toBe(true)
    fireEvent.paste(editor, {
      clipboardData: { types: ['text/plain'], getData: () => 'next line' },
    })
    expect(ref.current!.getSnapshot().value).toContain('next line')
    expect(editor).toHaveFocus()
  })

  test('keeps the sole empty browser caret native and round-trips rich Markdown', () => {
    const { ref, editor } = renderEditor()
    expect(editor.querySelector('.composer-empty-caret')).toBeNull()
    const markdown = '| Name | Value |\n| --- | --- |\n| **bold** |  |'
    act(() => ref.current!.setValue(markdown))
    expect(within(editor).getAllByRole('row')).toHaveLength(2)
    expect(within(editor).getByText('bold').tagName).toBe('STRONG')
    expect(ref.current!.getSnapshot().value).toContain('**bold**')
    expect(within(editor).getAllByRole('cell')[1]).toHaveTextContent('')
  })

  test('uses injected window focus and unsubscribes when the editor unmounts', () => {
    let notifyFocus: (value: boolean) => void = () => undefined
    const unsubscribe = vi.fn()
    const { editor, unmount } = renderEditor('text', {
      preserveNativeEmptyCaret: false,
      isWindowFocused: () => true,
      subscribeWindowFocus(callback) {
        notifyFocus = callback
        return unsubscribe
      },
    })
    act(() => editor.focus())
    expect(editor).toHaveAttribute('data-composer-focus-visible')
    act(() => notifyFocus(false))
    expect(editor).not.toHaveAttribute('data-composer-focus-visible')
    act(() => notifyFocus(true))
    expect(editor).toHaveAttribute('data-composer-focus-visible')
    unmount()
    expect(unsubscribe).toHaveBeenCalledTimes(1)
  })

  test('renders host catalog icons through the shared mention node', () => {
    const resolveMentionIcon = vi.fn(() => ({ url: '/plugin.svg', contrastPad: true }))
    const { editor } = renderEditor('[$example](plugin://example@marketplace)', {
      preserveNativeEmptyCaret: true,
      isWindowFocused: () => true,
      subscribeWindowFocus: () => () => undefined,
      resolveMentionIcon,
    })
    expect(resolveMentionIcon).toHaveBeenCalledWith('plugin://example@marketplace')
    expect(editor.querySelector('img')).toHaveAttribute('src', '/plugin.svg')
    expect(editor.querySelector('.composer-mention-icon-slot')).toHaveClass(
      'composer-mention-icon-slot--contrast-pad'
    )
  })

  test('retains theme and real URL actions throughout the link editing popover', () => {
    const anchor = document.createElement('button')
    document.body.append(anchor)
    const openExternalUrl = vi.fn()
    const onChange = vi.fn()
    const { unmount } = render(
      <CollaborationTheme mode="dark">
        <ConversationTranslationProvider translate={createCollaborationTranslator('en')}>
          <MarkdownServicesProvider value={{ ...browserMarkdownServices, openExternalUrl }}>
            <LinkEditPopover
              payload={{ url: 'https://example.com', label: 'Example' }}
              anchor={anchor}
              onClose={vi.fn()}
              onChange={onChange}
              onRemove={vi.fn()}
            />
          </MarkdownServicesProvider>
        </ConversationTranslationProvider>
      </CollaborationTheme>
    )
    expect(screen.getByTestId('link-edit-popover')).toHaveAttribute('data-theme', 'dark')
    fireEvent.click(screen.getByTestId('link-edit-open-link'))
    expect(openExternalUrl).toHaveBeenCalledWith('https://example.com')
    fireEvent.click(screen.getByTestId('link-edit-edit-url'))
    expect(screen.getByTestId('link-edit-popover')).toHaveAttribute('data-theme', 'dark')
    fireEvent.change(screen.getByTestId('link-edit-url-input'), { target: { value: 'invalid' } })
    fireEvent.click(screen.getByTestId('link-edit-confirm-url'))
    expect(onChange).not.toHaveBeenCalled()
    fireEvent.change(screen.getByTestId('link-edit-url-input'), {
      target: { value: 'https://example.org' },
    })
    fireEvent.click(screen.getByTestId('link-edit-confirm-url'))
    expect(onChange).toHaveBeenCalledWith({ url: 'https://example.org', label: 'Example' })
    unmount()
    anchor.remove()
  })
})
