import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import { AppearanceProvider } from './AppearanceProvider'
import { darkPalette, lightPalette } from './presets'
import { useAppearance } from './useAppearance'
import { WEWORK_RESET_FONT_SIZE_EVENT, WEWORK_STEP_FONT_SIZE_EVENT } from '@/lib/keybindings'

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
      </AppearanceProvider>
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
      </AppearanceProvider>
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
      </AppearanceProvider>
    )

    await userEvent.click(screen.getByTestId('set-accent'))
    expect(screen.getByTestId('accent-color')).toHaveTextContent('#0169cc')
    expect(document.documentElement.style.getPropertyValue('--color-primary')).toBe('1 105 204')

    await userEvent.click(screen.getByTestId('reset'))
    expect(screen.getByTestId('accent-color')).toHaveTextContent('#2563eb')
  })

  test('applies and persists Codex typography variables', async () => {
    render(
      <AppearanceProvider>
        <Harness />
      </AppearanceProvider>
    )

    expect(document.documentElement.style.getPropertyValue('--text-base')).toBe('14px')
    expect(document.documentElement.style.getPropertyValue('--text-code')).toBe('12px')

    await userEvent.click(screen.getByTestId('set-font-sizes'))

    expect(screen.getByTestId('ui-font-size')).toHaveTextContent('16')
    expect(screen.getByTestId('code-font-size')).toHaveTextContent('15')
    expect(document.documentElement.style.getPropertyValue('--text-base')).toBe('16px')
    expect(document.documentElement.style.getPropertyValue('--text-sm')).toBe('15px')
    expect(document.documentElement.style.getPropertyValue('--text-code')).toBe('15px')
    expect(localStorage.getItem('wework.appearance')).toContain('"uiFontSize":16')
    expect(localStorage.getItem('wework.appearance')).toContain('"codeFontSize":15')
  })

  test('steps UI and code font sizes together within their own bounds', async () => {
    render(
      <AppearanceProvider>
        <Harness />
      </AppearanceProvider>
    )

    act(() => {
      window.dispatchEvent(new CustomEvent(WEWORK_STEP_FONT_SIZE_EVENT, { detail: { delta: 1 } }))
    })

    expect(screen.getByTestId('ui-font-size')).toHaveTextContent('15')
    expect(screen.getByTestId('code-font-size')).toHaveTextContent('13')
    expect(document.documentElement.style.getPropertyValue('--text-base')).toBe('15px')

    act(() => {
      window.dispatchEvent(new CustomEvent(WEWORK_STEP_FONT_SIZE_EVENT, { detail: { delta: -1 } }))
    })

    expect(screen.getByTestId('ui-font-size')).toHaveTextContent('14')
    expect(screen.getByTestId('code-font-size')).toHaveTextContent('12')
  })

  test('resets UI and code font sizes without changing other appearance settings', async () => {
    render(
      <AppearanceProvider>
        <Harness />
      </AppearanceProvider>
    )

    await userEvent.click(screen.getByTestId('set-font-sizes'))
    act(() => {
      window.dispatchEvent(new CustomEvent(WEWORK_RESET_FONT_SIZE_EVENT))
    })

    expect(screen.getByTestId('ui-font-size')).toHaveTextContent('14')
    expect(screen.getByTestId('code-font-size')).toHaveTextContent('12')
    expect(document.documentElement.style.getPropertyValue('--text-base')).toBe('14px')
    expect(document.documentElement.style.getPropertyValue('--text-code')).toBe('12px')
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
      })
    )

    render(
      <AppearanceProvider>
        <Harness />
      </AppearanceProvider>
    )

    expect(document.documentElement.style.getPropertyValue('--color-mobile-drawer')).toBe(
      darkPalette.mobileDrawer
    )
    expect(localStorage.getItem('wework.appearance')).toContain(
      `"mobileDrawer":"${darkPalette.mobileDrawer}"`
    )
  })

  test('normalizes stored background settings and preserves old configuration defaults', () => {
    localStorage.setItem(
      'wework.appearance',
      JSON.stringify({
        backgroundImagePath: '/tmp/background.png',
        backgroundVisibility: 140,
        backgroundBlur: 99,
      })
    )

    render(
      <AppearanceProvider>
        <Harness />
      </AppearanceProvider>
    )

    expect(screen.getByTestId('background-path')).toHaveTextContent('/tmp/background.png')
    expect(screen.getByTestId('light-background-path')).toHaveTextContent('none')
    expect(screen.getByTestId('dark-background-path')).toHaveTextContent('none')
    expect(screen.getByTestId('background-visibility')).toHaveTextContent('100')
    expect(screen.getByTestId('background-blur')).toHaveTextContent('20')
    expect(screen.getByTestId('background-in-main')).toHaveTextContent('true')
  })
})
