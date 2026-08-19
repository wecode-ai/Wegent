import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, test, vi } from 'vitest'
import { WorkspaceTextFileEditor } from './WorkspaceTextFileEditor'

describe('WorkspaceTextFileEditor', () => {
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
