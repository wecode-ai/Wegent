import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import { AppearanceProvider } from './AppearanceProvider'
import { useAppearance } from './useAppearance'

const updateAppPreferencesMock = vi.hoisted(() => vi.fn())

vi.mock('@/desktop/appPreferences', () => ({
  updateAppPreferences: updateAppPreferencesMock,
}))

let mediaQueryMatches = false

function installMatchMedia() {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: vi.fn(() => ({
      matches: mediaQueryMatches,
      media: '(prefers-color-scheme: dark)',
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  })
}

function Harness() {
  const { appearance, resolvedMode, setAppearance, resetAppearance } = useAppearance()

  return (
    <div>
      <span data-testid="resolved-mode">{resolvedMode}</span>
      <span data-testid="appearance-mode">{appearance.mode}</span>
      <span data-testid="accent-color">{appearance.accentColor}</span>
      <span data-testid="ui-font-size">{appearance.uiFontSize}</span>
      <span data-testid="code-font-size">{appearance.codeFontSize}</span>
      <span data-testid="background-path">{appearance.backgroundImagePath ?? 'none'}</span>
      <span data-testid="light-background-path">
        {appearance.lightBackground.imagePath ?? 'none'}
      </span>
      <span data-testid="dark-background-path">
        {appearance.darkBackground.imagePath ?? 'none'}
      </span>
      <span data-testid="background-visibility">{appearance.backgroundVisibility}</span>
      <span data-testid="background-blur">{appearance.backgroundBlur}</span>
      <span data-testid="background-in-main">{String(appearance.backgroundInMain)}</span>
      <button type="button" data-testid="set-dark" onClick={() => setAppearance({ mode: 'dark' })}>
        dark
      </button>
      <button
        type="button"
        data-testid="set-system"
        onClick={() => setAppearance({ mode: 'system' })}
      >
        system
      </button>
      <button
        type="button"
        data-testid="set-accent"
        onClick={() => setAppearance({ accentColor: '#0169cc' })}
      >
        accent
      </button>
      <button type="button" data-testid="reset" onClick={resetAppearance}>
        reset
      </button>
      <button
        type="button"
        data-testid="set-font-sizes"
        onClick={() => setAppearance({ uiFontSize: 16, codeFontSize: 15 })}
      >
        font sizes
      </button>
    </div>
  )
}

describe('AppearanceProvider', () => {
  beforeEach(() => {
    localStorage.clear()
    mediaQueryMatches = false
    document.documentElement.removeAttribute('data-theme')
    document.documentElement.removeAttribute('data-appearance-mode')
    document.documentElement.className = ''
    document.documentElement.removeAttribute('style')
    installMatchMedia()
    updateAppPreferencesMock.mockReset()
    updateAppPreferencesMock.mockResolvedValue(undefined)
  })

  test('applies and persists selected dark mode', async () => {
    window.__WEWORK_RUNTIME_CONFIG__ = {
      ...window.__WEWORK_RUNTIME_CONFIG__,
      desktopHost: 'electron',
    }
    render(
      <AppearanceProvider>
        <Harness />
      </AppearanceProvider>
    )

    await userEvent.click(screen.getByTestId('set-dark'))

    expect(screen.getByTestId('resolved-mode')).toHaveTextContent('dark')
    expect(document.documentElement.dataset.theme).toBe('dark')
    expect(document.documentElement.classList.contains('dark')).toBe(true)
    expect(localStorage.getItem('wework.appearance')).toContain('"mode":"dark"')
    await waitFor(() => {
      expect(updateAppPreferencesMock).toHaveBeenLastCalledWith({ appearanceMode: 'dark' })
    })
  })
})
