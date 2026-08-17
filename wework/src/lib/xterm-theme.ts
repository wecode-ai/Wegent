import type { ITheme, Terminal } from '@xterm/xterm'

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
  background: '#111316',
  foreground: '#f1f5f9',
  cursor: '#2dd4bf',
  selectionBackground: 'rgba(45, 212, 191, 0.28)',
}

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

export function createTerminalThemeScheduler(
  terminal: Terminal,
  container: HTMLElement,
  transparentBackground = false
): () => void {
  let frameId: number | null = null

  return () => {
    if (frameId != null) return

    frameId = window.requestAnimationFrame(() => {
      frameId = null
      applyTerminalTheme(terminal, container, getTerminalTheme(), transparentBackground)
    })
  }
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
    attributeFilter: ['class', 'data-theme', 'style'],
  })

  return () => observer.disconnect()
}
