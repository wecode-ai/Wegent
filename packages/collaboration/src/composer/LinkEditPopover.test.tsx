// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import { ConversationTranslationProvider } from '../conversation/ConversationTranslation'
import { createCollaborationTranslator } from '../i18n'
import { LinkEditPopover } from './LinkEditPopover'

it('preserves the editor selection until URL editing then focuses the real URL input', async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  const editor = document.createElement('div')
  editor.contentEditable = 'true'
  editor.textContent = 'before link after'
  editor.tabIndex = 0
  document.body.append(editor)
  editor.focus()
  window
    .getSelection()!
    .setBaseAndExtent(editor.firstChild!, 7, editor.firstChild!, 11)
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  const change = vi.fn()
  const close = vi.fn()
  const query = (id: string) =>
    document.querySelector<HTMLElement>(`[data-testid="${id}"]`)!
  try {
    await act(async () =>
      root.render(
        <ConversationTranslationProvider
          translate={createCollaborationTranslator('en')}
        >
          <LinkEditPopover
            anchor={editor}
            payload={{ url: 'https://example.com', label: 'Example' }}
            onClose={close}
            onChange={change}
            onRemove={vi.fn()}
          />
        </ConversationTranslationProvider>,
      ),
    )
    expect(document.activeElement).toBe(editor)
    expect(window.getSelection()!.toString()).toBe('link')
    await act(async () => query('link-edit-edit-url').click())
    const input = query('link-edit-url-input') as HTMLInputElement
    expect(document.activeElement).toBe(input)
    expect(input.value).toBe('https://example.com')
    await act(async () =>
      input.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'Escape',
          bubbles: true,
          cancelable: true,
        }),
      ),
    )
    expect(query('link-edit-url-input')).toBeNull()
    expect(close).not.toHaveBeenCalled()
    expect(change).not.toHaveBeenCalled()
    expect(query('link-edit-edit-url')).not.toBeNull()
  } finally {
    await act(async () => root.unmount())
    container.remove()
    editor.remove()
  }
})
