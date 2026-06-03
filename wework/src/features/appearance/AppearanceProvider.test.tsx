import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import { AppearanceProvider } from './AppearanceProvider'
import { darkPalette, lightPalette } from './presets'
import { useAppearance } from './useAppearance'

let mediaQueryMatches = false
let mediaQueryListener: ((event: MediaQueryListEvent) => void) | null = null

function installMatchMedia() {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: vi.fn(() => ({
      matches: mediaQueryMatches,
      media: '(prefers-color-scheme: dark)',
      onchange: null,
      addEventListener: vi.fn((_event: string, listener: (event: MediaQueryListEvent) => void) => {
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
    </div>
  )
}

describe('AppearanceProvider', () => {
  beforeEach(() => {
    localStorage.clear()
    mediaQueryMatches = false
    mediaQueryListener = null
    document.documentElement.removeAttribute('data-theme')
    document.documentElement.removeAttribute('data-appearance-mode')
    document.documentElement.className = ''
    document.documentElement.removeAttribute('style')
    installMatchMedia()
  })

  test('applies and persists selected dark mode', async () => {
    render(
      <AppearanceProvider>
        <Harness />
      </AppearanceProvider>,
    )

    await userEvent.click(screen.getByTestId('set-dark'))

    expect(screen.getByTestId('resolved-mode')).toHaveTextContent('dark')
    expect(document.documentElement.dataset.theme).toBe('dark')
    expect(document.documentElement.classList.contains('dark')).toBe(true)
    expect(localStorage.getItem('wework.appearance')).toContain('"mode":"dark"')
  })

  test('updates system mode when system preference changes', async () => {
    render(
      <AppearanceProvider>
        <Harness />
      </AppearanceProvider>,
    )

    expect(screen.getByTestId('resolved-mode')).toHaveTextContent('light')

    act(() => {
      mediaQueryMatches = true
      mediaQueryListener?.({ matches: true } as MediaQueryListEvent)
    })

    await waitFor(() => {
      expect(screen.getByTestId('resolved-mode')).toHaveTextContent('dark')
    })
  })

  test('updates accent color and resets to defaults', async () => {
    render(
      <AppearanceProvider>
        <Harness />
      </AppearanceProvider>,
    )

    await userEvent.click(screen.getByTestId('set-accent'))
    expect(screen.getByTestId('accent-color')).toHaveTextContent('#0169cc')
    expect(document.documentElement.style.getPropertyValue('--color-primary')).toBe('1 105 204')

    await userEvent.click(screen.getByTestId('reset'))
    expect(screen.getByTestId('accent-color')).toHaveTextContent('#14b8a6')
  })

  test('keeps mobile drawer backgrounds opaque enough to hide page content', () => {
    expect(lightPalette.mobileDrawer).not.toContain('/')
    expect(darkPalette.mobileDrawer).not.toContain('/')
  })

  test('migrates old translucent mobile drawer values from storage', () => {
    localStorage.setItem(
      'wework.appearance',
      JSON.stringify({
        mode: 'dark',
        dark: {
          mobileDrawer: '29 45 66 / 0.94',
        },
      }),
    )

    render(
      <AppearanceProvider>
        <Harness />
      </AppearanceProvider>,
    )

    expect(document.documentElement.style.getPropertyValue('--color-mobile-drawer')).toBe(
      darkPalette.mobileDrawer,
    )
    expect(localStorage.getItem('wework.appearance')).toContain(
      `"mobileDrawer":"${darkPalette.mobileDrawer}"`,
    )
  })
})
