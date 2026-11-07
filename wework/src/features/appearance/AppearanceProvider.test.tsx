import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import { AppearanceProvider } from './AppearanceProvider'
import { useAppearance } from './useAppearance'
import { defaultAppearance } from './presets'
import { mergeAppearance, writeStoredAppearance } from './storage'

const { getAppPreferencesMock, updateAppPreferencesMock } = vi.hoisted(() => ({
  getAppPreferencesMock: vi.fn(),
  updateAppPreferencesMock: vi.fn(),
}))

vi.mock('@/desktop/appPreferences', () => ({
  updateAppPreferences: updateAppPreferencesMock,
  getAppPreferences: getAppPreferencesMock,
  APP_PREFERENCES_CHANGED_EVENT: 'wework:app-preferences-changed',
}))

let mediaQueryMatches = false
let mediaQueryListener: (() => void) | undefined

function installMatchMedia() {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: vi.fn(() => ({
      matches: mediaQueryMatches,
      media: '(prefers-color-scheme: dark)',
      onchange: null,
      addEventListener: vi.fn((_event: string, listener: () => void) => {
        mediaQueryListener = listener
      }),
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
      <span data-testid="dark-theme">{appearance.darkThemeId}</span>
      <span data-testid="light-theme">{appearance.lightThemeId}</span>
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
        data-testid="set-tokyo"
        onClick={() => setAppearance({ darkThemeId: 'tokyo-night' })}
      >
        Tokyo Night
      </button>
      <button
        type="button"
        data-testid="set-proof"
        onClick={() => setAppearance({ lightThemeId: 'proof' })}
      >
        Proof
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
    window.__WEWORK_RUNTIME_CONFIG__ = {
      ...window.__WEWORK_RUNTIME_CONFIG__,
      desktopHost: 'electron',
    }
    mediaQueryMatches = false
    mediaQueryListener = undefined
    document.documentElement.removeAttribute('data-theme')
    document.documentElement.removeAttribute('data-appearance-mode')
    document.documentElement.removeAttribute('data-appearance-theme')
    document.documentElement.className = ''
    document.documentElement.removeAttribute('style')
    installMatchMedia()
    updateAppPreferencesMock.mockReset()
    updateAppPreferencesMock.mockResolvedValue(undefined)
    getAppPreferencesMock.mockReset()
    getAppPreferencesMock.mockImplementation(() => new Promise(() => {}))
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
      expect(updateAppPreferencesMock).toHaveBeenLastCalledWith(
        expect.objectContaining({
          appearanceMode: 'dark',
          appearanceThemeSnapshot: expect.objectContaining({
            light: expect.objectContaining({ themeId: 'codex' }),
            dark: expect.objectContaining({ themeId: 'codex' }),
          }),
        })
      )
    })
  })

  test('follows the system using independently selected light and dark themes', async () => {
    render(
      <AppearanceProvider>
        <Harness />
      </AppearanceProvider>
    )
    await userEvent.click(screen.getByTestId('set-tokyo'))
    await userEvent.click(screen.getByTestId('set-proof'))
    expect(document.documentElement.dataset.appearanceTheme).toBe('proof')
    act(() => {
      mediaQueryMatches = true
      mediaQueryListener?.()
    })
    expect(screen.getByTestId('resolved-mode')).toHaveTextContent('dark')
    expect(document.documentElement.dataset.appearanceTheme).toBe('tokyo-night')
    expect(document.documentElement.style.getPropertyValue('--color-bg-base')).toBe('26 27 38')
    expect(screen.getByTestId('accent-color')).toHaveTextContent('#7aa2f7')
    await waitFor(() => {
      expect(updateAppPreferencesMock).toHaveBeenLastCalledWith(
        expect.objectContaining({
          appearanceThemeSnapshot: expect.objectContaining({
            light: expect.objectContaining({ themeId: 'proof' }),
            dark: expect.objectContaining({ themeId: 'tokyo-night' }),
          }),
        })
      )
    })
  })

  test('applies another window’s saved theme immediately without retaining stale configuration', () => {
    render(
      <AppearanceProvider persist={false}>
        <Harness />
      </AppearanceProvider>
    )
    const incoming = mergeAppearance({
      ...defaultAppearance,
      mode: 'dark',
      darkThemeId: 'tokyo-night',
    })
    act(() => {
      writeStoredAppearance(incoming)
      window.dispatchEvent(new StorageEvent('storage', { key: 'wework.appearance' }))
    })
    expect(screen.getByTestId('dark-theme')).toHaveTextContent('tokyo-night')
    expect(document.documentElement.dataset.appearanceTheme).toBe('tokyo-night')
    expect(document.documentElement.style.getPropertyValue('--color-syntax-string')).toBe(
      '158 206 106'
    )
    expect(updateAppPreferencesMock).not.toHaveBeenCalled()
  })

  test('keeps custom accents scoped to their mode and resets theme selection', async () => {
    render(
      <AppearanceProvider>
        <Harness />
      </AppearanceProvider>
    )
    await userEvent.click(screen.getByTestId('set-tokyo'))
    await userEvent.click(screen.getByTestId('set-dark'))
    await userEvent.click(screen.getByTestId('set-accent'))
    expect(document.documentElement.style.getPropertyValue('--color-primary')).toBe('1 105 204')
    expect(
      JSON.parse(localStorage.getItem('wework.appearance')!).themeOverrides.dark.accentColor
    ).toBe('#0169cc')
    await userEvent.click(screen.getByTestId('reset'))
    expect(screen.getByTestId('dark-theme')).toHaveTextContent('codex')
    expect(screen.getByTestId('light-theme')).toHaveTextContent('codex')
    expect(document.documentElement.dataset.appearanceTheme).toBe('codex')
  })

  test.each([true, false])(
    'retains the named theme during another window’s storage bootstrap (persist=%s)',
    async persist => {
      writeStoredAppearance(mergeAppearance({ mode: 'dark', darkThemeId: 'tokyo-night' }))
      render(
        <AppearanceProvider persist={persist}>
          <Harness />
        </AppearanceProvider>
      )
      await waitFor(() => {
        expect(document.documentElement.dataset.appearanceTheme).toBe('tokyo-night')
      })
      const stored = localStorage.getItem('wework.appearance')!
      updateAppPreferencesMock.mockClear()

      act(() => {
        localStorage.clear()
        window.dispatchEvent(new StorageEvent('storage', { key: null }))
      })
      expect(document.documentElement.dataset.appearanceTheme).toBe('tokyo-night')
      expect(screen.getByTestId('resolved-mode')).toHaveTextContent('dark')
      expect(updateAppPreferencesMock).not.toHaveBeenCalled()

      act(() => {
        localStorage.setItem('wework.appearance', stored)
        window.dispatchEvent(new StorageEvent('storage', { key: 'wework.appearance' }))
      })
      expect(document.documentElement.dataset.appearanceTheme).toBe('tokyo-night')
      expect(screen.getByTestId('dark-theme')).toHaveTextContent('tokyo-night')
    }
  )

  test('honors native preference changes while retaining selected light and dark themes', () => {
    writeStoredAppearance(
      mergeAppearance({
        ...defaultAppearance,
        mode: 'light',
        lightThemeId: 'proof',
        darkThemeId: 'tokyo-night',
      })
    )
    render(
      <AppearanceProvider persist={false}>
        <Harness />
      </AppearanceProvider>
    )
    act(() => {
      window.dispatchEvent(
        new CustomEvent('wework:app-preferences-changed', {
          detail: { appearanceMode: 'dark' },
        })
      )
    })
    expect(screen.getByTestId('resolved-mode')).toHaveTextContent('dark')
    expect(document.documentElement.dataset.appearanceTheme).toBe('tokyo-night')
    act(() => {
      window.dispatchEvent(
        new CustomEvent('wework:app-preferences-changed', {
          detail: { appearanceMode: 'light' },
        })
      )
    })
    expect(document.documentElement.dataset.appearanceTheme).toBe('proof')
    expect(screen.getByTestId('dark-theme')).toHaveTextContent('tokyo-night')
    expect(updateAppPreferencesMock).not.toHaveBeenCalled()
  })

  test('initializes auxiliary windows from the native mode selected before opening them', async () => {
    writeStoredAppearance(
      mergeAppearance({
        ...defaultAppearance,
        mode: 'light',
        lightThemeId: 'proof',
        darkThemeId: 'tokyo-night',
      })
    )
    getAppPreferencesMock.mockResolvedValue({ appearanceMode: 'dark' })
    render(
      <AppearanceProvider persist={false}>
        <Harness />
      </AppearanceProvider>
    )
    await waitFor(() => {
      expect(document.documentElement.dataset.appearanceTheme).toBe('tokyo-night')
    })
    expect(updateAppPreferencesMock).not.toHaveBeenCalled()
  })

  test('keeps the owning window on its selected mode when native preferences echo an older mode', async () => {
    render(
      <AppearanceProvider>
        <Harness />
      </AppearanceProvider>
    )
    await userEvent.click(screen.getByTestId('set-dark'))
    const persistedCalls = updateAppPreferencesMock.mock.calls.length
    act(() => {
      window.dispatchEvent(
        new CustomEvent('wework:app-preferences-changed', {
          detail: { appearanceMode: 'light' },
        })
      )
    })
    expect(screen.getByTestId('resolved-mode')).toHaveTextContent('dark')
    expect(updateAppPreferencesMock).toHaveBeenCalledTimes(persistedCalls)
  })
})
