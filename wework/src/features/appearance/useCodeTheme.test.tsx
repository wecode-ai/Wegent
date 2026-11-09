import { render, screen } from '@testing-library/react'
import { expect, test, vi } from 'vitest'
import { AppearanceContext } from './context'
import { defaultAppearance } from './presets'
import { useCodeTheme } from './useCodeTheme'
import { WEWORK_CODE_THEME } from '@/lib/code-theme'

function CodeSurface() {
  const theme = useCodeTheme()
  return (
    <div>
      <output>{JSON.stringify(theme)}</output>
      <input data-testid="code-surface-draft" aria-label="draft" defaultValue="keep edits" />
    </div>
  )
}

test('switches mounted code surfaces back to Wework independently in both modes', () => {
  const context = {
    appearance: { ...defaultAppearance, lightThemeId: 'github', darkThemeId: 'tokyo-night' },
    resolvedMode: 'dark' as const,
    setAppearance: vi.fn(),
    resetAppearance: vi.fn(),
  }
  const { rerender } = render(
    <AppearanceContext.Provider value={context}>
      <CodeSurface />
    </AppearanceContext.Provider>
  )
  const draft = screen.getByRole('textbox')
  expect(screen.getByRole('status')).toHaveTextContent(JSON.stringify(WEWORK_CODE_THEME))
  rerender(
    <AppearanceContext.Provider
      value={{ ...context, appearance: { ...context.appearance, darkThemeId: 'wework' } }}
    >
      <CodeSurface />
    </AppearanceContext.Provider>
  )
  expect(screen.getByRole('status')).toHaveTextContent(
    JSON.stringify({ light: WEWORK_CODE_THEME, dark: 'pierre-dark' })
  )
  rerender(
    <AppearanceContext.Provider value={{ ...context, appearance: defaultAppearance }}>
      <CodeSurface />
    </AppearanceContext.Provider>
  )
  expect(screen.getByRole('status')).toHaveTextContent(
    JSON.stringify({ light: 'pierre-light', dark: 'pierre-dark' })
  )
  expect(screen.getByRole('textbox')).toBe(draft)
  expect(draft).toHaveValue('keep edits')
})
