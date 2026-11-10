import type { ITheme, Terminal } from '@xterm/xterm'
import { DEFAULT_UI_THEME_ID } from '@wegent/collaboration/theme'

type RequiredTerminalTheme = Required<
  Pick<ITheme, 'background' | 'foreground' | 'cursor' | 'selectionBackground'>
>

const LIGHT_TERMINAL_THEME: RequiredTerminalTheme = {
  background: '#ffffff',
  foreground: '#1a1a1a',
  cursor: '#14b8a6',
  selectionBackground: 'rgba(20, 184, 166, 0.2)',
}

const DARK_TERMINAL_THEME: RequiredTerminalTheme = {
  background: '#181818',
  foreground: '#ffffff',
  cursor: '#339cff',
  selectionBackground: 'rgba(51, 156, 255, 0.28)',
}

const ANSI_COLORS = {
  black: 'black',
  red: 'red',
  green: 'green',
  yellow: 'yellow',
  blue: 'blue',
  magenta: 'magenta',
  cyan: 'cyan',
  white: 'white',
  brightBlack: 'bright-black',
  brightRed: 'bright-red',
  brightGreen: 'bright-green',
  brightYellow: 'bright-yellow',
  brightBlue: 'bright-blue',
  brightMagenta: 'bright-magenta',
  brightCyan: 'bright-cyan',
  brightWhite: 'bright-white',
} as const

function isDarkAppearance(): boolean {
  if (typeof document === 'undefined') return false

  const root = document.documentElement
  if (root.dataset.theme === 'dark' || root.classList.contains('dark')) {
    return true
  }
  if (root.dataset.theme === 'light') {
    return false
  }

  return Boolean(window.matchMedia?.('(prefers-color-scheme: dark)').matches)
}

function cssVariableColor(name: string, fallback: string, alpha?: number): string {
  if (typeof document === 'undefined') return fallback

  const rawValue = window.getComputedStyle(document.documentElement).getPropertyValue(name).trim()
  if (!rawValue) return fallback

  const channels = rawValue
    .split('/')[0]
    .trim()
    .split(/\s+/)
    .map(channel => Number(channel))

  if (channels.length !== 3 || channels.some(channel => Number.isNaN(channel))) {
    return fallback
  }

  const [red, green, blue] = channels
  if (alpha != null) return `rgba(${red}, ${green}, ${blue}, ${alpha})`
  return `rgb(${red}, ${green}, ${blue})`
}

export function getTerminalTheme(transparentBackground = false): ITheme {
  const fallbackTheme = isDarkAppearance() ? DARK_TERMINAL_THEME : LIGHT_TERMINAL_THEME

  return {
    ...Object.fromEntries(
      Object.entries(ANSI_COLORS).flatMap(([key, token]) => {
        const color = cssVariableColor(`--color-terminal-${token}`, '')
        return color ? [[key, color]] : []
      })
    ),
    background: transparentBackground
      ? 'rgba(0, 0, 0, 0)'
      : cssVariableColor('--color-bg-base', fallbackTheme.background),
    foreground: cssVariableColor('--color-text-primary', fallbackTheme.foreground),
    cursor: cssVariableColor('--color-primary', fallbackTheme.cursor),
    selectionBackground: cssVariableColor(
      '--color-primary',
      fallbackTheme.selectionBackground ?? DARK_TERMINAL_THEME.selectionBackground,
      isDarkAppearance() ? 0.28 : 0.2
    ),
  }
}

export function applyTerminalTheme(
  terminal: Terminal,
  container: HTMLElement,
  theme = getTerminalTheme(),
  transparentBackground = false
): ITheme {
  const appliedTheme = {
    ...theme,
    ...(transparentBackground ? { background: 'rgba(0, 0, 0, 0)' } : {}),
  }
  terminal.options.theme = appliedTheme
  // ANSI whites need contrast correction on the default opaque light background.
  const themeId = container.ownerDocument.documentElement.dataset.appearanceTheme
  terminal.options.minimumContrastRatio =
    !transparentBackground &&
    !isDarkAppearance() &&
    (themeId ?? DEFAULT_UI_THEME_ID) === DEFAULT_UI_THEME_ID
      ? 4.5
      : 1

  if (appliedTheme.background) {
    container.style.backgroundColor = appliedTheme.background
    container
      .querySelectorAll<HTMLElement>(
        '.xterm, .xterm-viewport, .xterm-screen, .xterm-scrollable-element'
      )
      .forEach(element => {
        element.style.backgroundColor = appliedTheme.background ?? ''
      })
  }

  return appliedTheme
}

export function observeTerminalTheme(onChange: (theme: ITheme) => void): () => void {
  if (typeof document === 'undefined' || typeof MutationObserver === 'undefined') {
    return () => undefined
  }

  const observer = new MutationObserver(() => {
    onChange(getTerminalTheme())
  })

  observer.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['class', 'data-theme', 'data-appearance-theme', 'style'],
  })

  return () => observer.disconnect()
}
