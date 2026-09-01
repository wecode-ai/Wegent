import { fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, test, vi } from 'vitest'
import { WorkspaceTextFileEditor } from './WorkspaceTextFileEditor'
import { SELECTED_TEXT_CHANGED_EVENT } from '@/lib/selected-text-drag'

describe('WorkspaceTextFileEditor', () => {
  test('drags the selected editor text as plain text', async () => {
    const user = userEvent.setup()
    render(
      <WorkspaceTextFileEditor
        path="/workspace/auth.ts"
        value="export const authenticated = true"
        themeType="light"
        onChange={vi.fn()}
        onSave={vi.fn()}
      />
    )
    const content = screen
      .getByTestId('workspace-file-editor')
      .querySelector<HTMLElement>('.cm-content')
    expect(content).toBeInstanceOf(HTMLElement)

    await user.click(content as HTMLElement)
    await user.keyboard('{Control>}a{/Control}')
    const setData = vi.fn()
    const dataTransfer = { setData, effectAllowed: 'none' } as unknown as DataTransfer
    fireEvent.dragStart(content as HTMLElement, { dataTransfer })

    expect(setData).toHaveBeenCalledWith('text/plain', 'export const authenticated = true')
  })

  test('publishes CodeMirror selection changes immediately', async () => {
    const user = userEvent.setup()
    const selections: Array<string | null> = []
    const handleSelection = (event: Event) => {
      selections.push((event as CustomEvent<{ text: string | null }>).detail.text)
    }
    window.addEventListener(SELECTED_TEXT_CHANGED_EVENT, handleSelection)

    const { unmount } = render(
      <WorkspaceTextFileEditor
        path="/workspace/auth.ts"
        value="export const authenticated = true"
        themeType="light"
        onChange={vi.fn()}
        onSave={vi.fn()}
      />
    )
    const content = screen
      .getByTestId('workspace-file-editor')
      .querySelector<HTMLElement>('.cm-content')
    await user.click(content as HTMLElement)
    await user.keyboard('{Control>}a{/Control}')

    expect(selections).toContain('export const authenticated = true')
    unmount()
    expect(selections.at(-1)).toBeNull()
    window.removeEventListener(SELECTED_TEXT_CHANGED_EVENT, handleSelection)
  })

  test('preserves unsaved content and undo history when the theme changes', async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()
    const { rerender } = render(
      <WorkspaceTextFileEditor
        path="/workspace/auth.ts"
        value="export const authenticated = false"
        themeType="light"
        onChange={onChange}
        onSave={vi.fn()}
      />
    )
    const content = screen.getByTestId('workspace-file-editor').querySelector('.cm-content')
    expect(content).toBeInstanceOf(HTMLElement)

    await user.click(content as HTMLElement)
    await user.keyboard('{Control>}a{/Control}')
    await user.paste('export const authenticated = true')
    expect(onChange).toHaveBeenLastCalledWith('export const authenticated = true')

    rerender(
      <WorkspaceTextFileEditor
        path="/workspace/auth.ts"
        value="export const authenticated = true"
        themeType="dark"
        onChange={onChange}
        onSave={vi.fn()}
      />
    )

    expect(screen.getByTestId('workspace-file-editor')).toHaveAttribute('data-theme', 'dark')
    expect(content).toHaveTextContent('export const authenticated = true')

    await user.keyboard('{Control>}z{/Control}')
    expect(onChange).toHaveBeenLastCalledWith('export const authenticated = false')
    expect(content).toHaveTextContent('export const authenticated = false')
  })
})
