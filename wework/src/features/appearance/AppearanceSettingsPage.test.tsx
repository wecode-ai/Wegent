import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import { UI_THEME_CATALOGUE } from '@wegent/collaboration/theme'
import { AppearanceProvider } from './AppearanceProvider'
import { AppearanceSettingsPage } from './AppearanceSettingsPage'

vi.mock('@/telemetry/client', () => ({ track: vi.fn() }))
vi.mock('@/desktop/appPreferences', () => ({
  getAppPreferences: vi.fn().mockResolvedValue({ appearanceMode: 'system' }),
  updateAppPreferences: vi.fn().mockResolvedValue(undefined),
  APP_PREFERENCES_CHANGED_EVENT: 'wework:app-preferences-changed',
}))

describe('appearance theme selection', () => {
  beforeEach(() => {
    localStorage.clear()
    document.documentElement.removeAttribute('style')
    window.matchMedia = vi.fn().mockReturnValue({
      matches: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })
  })

  test('offers every supported variant through the visible selectors', () => {
    render(
      <AppearanceProvider>
        <AppearanceSettingsPage />
      </AppearanceProvider>
    )
    for (const mode of ['light', 'dark'] as const) {
      const select = screen.getByTestId(`appearance-theme-select-${mode}`) as HTMLSelectElement
      expect([...select.options].map(option => option.value)).toEqual(
        UI_THEME_CATALOGUE.filter(theme => theme.variants[mode]).map(theme => theme.id)
      )
      expect(select).toHaveValue('wework')
    }
  })

  test('switches live, preserves the other mode, and restores preset accents', async () => {
    render(
      <AppearanceProvider>
        <AppearanceSettingsPage />
      </AppearanceProvider>
    )
    await userEvent.selectOptions(screen.getByTestId('appearance-theme-select-light'), 'proof')
    await userEvent.selectOptions(screen.getByTestId('appearance-theme-select-dark'), 'tokyo-night')
    expect(document.documentElement.dataset.appearanceTheme).toBe('proof')
    await userEvent.click(screen.getByTestId('appearance-mode-dark'))
    expect(document.documentElement.dataset.appearanceTheme).toBe('tokyo-night')
    expect(screen.getByTestId('appearance-accent-input')).toHaveValue('#7aa2f7')
    expect(screen.getByTestId('appearance-theme-select-light')).toHaveValue('proof')
    expect(
      screen.getByTestId('appearance-theme-preview-dark').style.getPropertyValue('--color-bg-base')
    ).toBe('26 27 38')
    await userEvent.selectOptions(screen.getByTestId('appearance-theme-select-dark'), 'nord')
    expect(screen.getByTestId('appearance-accent-input')).toHaveValue('#88c0d0')
    expect(screen.getByTestId('appearance-theme-select-light')).toHaveValue('proof')
  })

  test('restores both Wework palettes through the visible reset control', async () => {
    render(
      <AppearanceProvider>
        <AppearanceSettingsPage />
      </AppearanceProvider>
    )
    await userEvent.selectOptions(screen.getByTestId('appearance-theme-select-light'), 'codex')
    await userEvent.selectOptions(screen.getByTestId('appearance-theme-select-dark'), 'tokyo-night')
    await userEvent.click(screen.getByTestId('appearance-reset-button'))
    expect(screen.getByTestId('appearance-theme-select-light')).toHaveValue('wework')
    expect(screen.getByTestId('appearance-theme-select-dark')).toHaveValue('wework')
    expect(document.documentElement.dataset.appearanceTheme).toBe('wework')
    expect(screen.getByTestId('appearance-accent-input')).toHaveValue('#2563eb')
  })
})
