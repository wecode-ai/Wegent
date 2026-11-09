import { act, waitFor } from '@testing-library/react'
import { getSharedHighlighter } from '@pierre/diffs'
import { Editor } from '@pierre/diffs/edit'
import { expect, vi } from 'vitest'
import { WEWORK_CODE_THEME } from '@/lib/code-theme'

let editSpy = vi.spyOn(Editor.prototype, 'edit')

/** Supply browser measurement APIs absent from jsdom; keep the real Pierre editor. */
export async function installPierreEditorTestPlatform() {
  editSpy = vi.spyOn(Editor.prototype, 'edit')
  vi.stubGlobal(
    'IntersectionObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
  )
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
    measureText: (text: string) => ({ width: text.length * 8 }),
  } as CanvasRenderingContext2D)
  Element.prototype.scrollIntoView ??= vi.fn()
  Element.prototype.scrollTo ??= vi.fn()
  await getSharedHighlighter({
    langs: ['typescript', 'text'],
    themes: [WEWORK_CODE_THEME],
    preferredHighlighter: 'highlights',
  })
}

export function getWorkspaceCodeText() {
  return Array.from(
    document.querySelectorAll('[data-testid="workspace-file-preview-code-view"] diffs-container')
  )
    .map(container => container.shadowRoot?.querySelector('[data-code]')?.textContent ?? '')
    .join('\n')
}

export async function replaceWorkspaceEditorText(root: HTMLElement, text: string) {
  await waitFor(() =>
    expect(
      root
        .querySelector('diffs-container')
        ?.shadowRoot?.querySelector('[data-testid="workspace-file-editor-content"]')
    ).not.toBeNull()
  )
  const editor = editSpy.mock.contexts.at(-1) as Editor
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
  return root
    .querySelector('diffs-container')!
    .shadowRoot!.querySelector<HTMLElement>('[data-testid="workspace-file-editor-content"]')!
}
