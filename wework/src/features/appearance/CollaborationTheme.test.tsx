import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, test } from 'vitest'
import {
  CollaborationTheme,
  defaultThemeAppearance,
  resolveThemeVariables,
  useDocumentTheme,
} from '@wegent/collaboration/theme'
import { ProjectBoardGroupPicker } from '@wegent/collaboration/project-board'
import { applyAppearance } from './applyAppearance'
import { defaultAppearance } from './presets'

const originalStyle = document.documentElement.getAttribute('style')
afterEach(() => {
  document.documentElement.setAttribute('style', originalStyle ?? '')
  delete document.documentElement.dataset.theme
  delete document.documentElement.dataset.appearanceMode
  delete document.documentElement.dataset.sidebarTranslucent
  document.documentElement.classList.remove('dark')
})

function Picker() {
  return (
    <ProjectBoardGroupPicker
      fields={[{ id: 'status', name: '状态' }]}
      value="status"
      onChange={() => undefined}
    />
  )
}

describe('shared desktop collaboration theme', () => {
  test.each(['light', 'dark'] as const)(
    'uses the desktop appearance in the %s Web scope and portal',
    mode => {
      applyAppearance(defaultAppearance, mode)
      const desktopStyle = document.documentElement.style
      const expected = Object.fromEntries(
        Object.keys(resolveThemeVariables(mode)).map(key => [
          key,
          desktopStyle.getPropertyValue(key),
        ])
      )
      desktopStyle.setProperty('--color-primary', '93 94 201')
      const { container } = render(
        <CollaborationTheme mode={mode}>
          <Picker />
        </CollaborationTheme>
      )
      fireEvent.click(screen.getByTestId('dingtalk-board-group-by'))
      const menu = screen.getByRole('listbox')
      const scope = container.querySelector<HTMLElement>('.collaboration-theme')!
      expect(container.contains(menu)).toBe(false)
      expect(scope.style.display).toBe('contents')
      expect(menu.style.display).toBe('')
      expect(menu.style.left).toBe('8px')
      expect(menu.style.top).toBe('4px')
      for (const [key, value] of Object.entries(expected)) {
        expect(scope.style.getPropertyValue(key), key).toBe(value)
        expect(menu.style.getPropertyValue(key), key).toBe(value)
      }
      expect(menu.dataset.theme).toBe(mode)
      expect(desktopStyle.getPropertyValue('--color-primary')).toBe('93 94 201')
    }
  )

  test('updates an open portal when the document switches theme', async () => {
    function WebTheme() {
      const mode = useDocumentTheme()
      return (
        <CollaborationTheme mode={mode}>
          <Picker />
        </CollaborationTheme>
      )
    }
    render(<WebTheme />)
    fireEvent.click(screen.getByTestId('dingtalk-board-group-by'))
    const menu = screen.getByRole('listbox')
    expect(menu.dataset.theme).toBe('light')
    await act(async () => {
      document.documentElement.dataset.theme = 'dark'
    })
    await waitFor(() => expect(menu.dataset.theme).toBe('dark'))
    expect(menu.style.getPropertyValue('--color-bg-base')).toBe('24 24 24')
    expect(screen.getByRole('listbox')).toBe(menu)
  })

  test('preserves custom desktop appearance and keeps aliases in sync', () => {
    applyAppearance(
      {
        ...defaultAppearance,
        accentColor: '#123456',
        uiFontSize: 16,
        codeFontSize: 18,
        uiFont: 'Custom UI',
        codeFont: 'Custom Code',
        light: { ...defaultThemeAppearance.light, bgMuted: '1 2 3' },
      },
      'light'
    )
    const style = document.documentElement.style
    expect(style.getPropertyValue('--color-primary')).toBe('18 52 86')
    expect(style.getPropertyValue('--color-muted')).toBe('1 2 3')
    expect(style.getPropertyValue('--color-bg-muted')).toBe('1 2 3')
    expect(style.getPropertyValue('--font-ui')).toBe('Custom UI')
    expect(style.getPropertyValue('--font-code')).toBe('Custom Code')
    expect(style.getPropertyValue('--text-sm')).toBe('15px')
    expect(style.getPropertyValue('--text-code')).toBe('18px')
    render(<Picker />)
    fireEvent.click(screen.getByTestId('dingtalk-board-group-by'))
    const menu = screen.getByRole('listbox')
    expect(menu.hasAttribute('data-theme')).toBe(false)
    expect(menu.style.getPropertyValue('--color-primary')).toBe('')
  })
})
