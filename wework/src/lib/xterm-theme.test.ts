import type { Terminal } from '@xterm/xterm'
import { resolveUiThemeVariables } from '@wegent/collaboration/theme'
import { afterEach, expect, test, vi } from 'vitest'
import { applyTerminalTheme, getTerminalTheme, observeTerminalTheme } from './xterm-theme'

afterEach(() => {
  document.documentElement.removeAttribute('style')
  document.documentElement.removeAttribute('data-theme')
  document.documentElement.removeAttribute('data-appearance-theme')
})

test.each(['light', 'dark'] as const)(
  'keeps zsh directory and Git prompt ANSI colors when switching %s themes',
  async mode => {
    document.documentElement.dataset.theme = mode
    const terminal = { options: {} } as Terminal
    const container = document.createElement('div')
    const applyThemeVariables = (themeId: string) => {
      document.documentElement.dataset.appearanceTheme = themeId
      Object.entries(resolveUiThemeVariables(mode, themeId)).forEach(([key, value]) => {
        document.documentElement.style.setProperty(key, value)
      })
    }
    applyThemeVariables('wework')
    applyTerminalTheme(terminal, container)
    const originalColors = {
      brightCyan: 'rgb(52, 226, 226)',
      brightBlue: 'rgb(114, 159, 207)',
      brightGreen: 'rgb(138, 226, 52)',
    }
    expect(terminal.options.theme).toMatchObject(originalColors)
    expect(terminal.options.minimumContrastRatio).toBe(mode === 'light' ? 4.5 : 1)

    const disconnect = observeTerminalTheme(theme => applyTerminalTheme(terminal, container, theme))
    try {
      applyThemeVariables('catppuccin')
      await new Promise<void>(resolve => queueMicrotask(resolve))
      expect(terminal.options.theme?.brightCyan).toBe(
        mode === 'light' ? 'rgb(45, 159, 168)' : 'rgb(107, 215, 202)'
      )
      expect(terminal.options.minimumContrastRatio).toBe(1)

      applyThemeVariables('wework')
      await new Promise<void>(resolve => queueMicrotask(resolve))
      expect(terminal.options.theme).toMatchObject(originalColors)
      expect(terminal.options.minimumContrastRatio).toBe(mode === 'light' ? 4.5 : 1)
    } finally {
      disconnect()
    }
  }
)

test('leaves transparent terminals at xterm default contrast without changing ANSI whites', () => {
  const terminal = { options: {} } as Terminal
  const container = document.createElement('div')
  const theme = { white: '#d3d7cf', brightWhite: '#eeeeec' }
  document.documentElement.dataset.theme = 'light'

  applyTerminalTheme(terminal, container, theme)
  expect(terminal.options.minimumContrastRatio).toBe(4.5)
  expect(terminal.options.theme).toMatchObject(theme)

  applyTerminalTheme(terminal, container, theme, true)
  expect(terminal.options.minimumContrastRatio).toBe(1)
  expect(terminal.options.theme).toMatchObject({ ...theme, background: 'rgba(0, 0, 0, 0)' })
})

test('applies all ANSI colors and updates a mounted terminal without resetting it', async () => {
  const tokens = [
    'black',
    'red',
    'green',
    'yellow',
    'blue',
    'magenta',
    'cyan',
    'white',
    'bright-black',
    'bright-red',
    'bright-green',
    'bright-yellow',
    'bright-blue',
    'bright-magenta',
    'bright-cyan',
    'bright-white',
  ]
  tokens.forEach((token, index) => {
    document.documentElement.style.setProperty(`--color-terminal-${token}`, `${index} 100 200`)
  })
  document.documentElement.style.setProperty('--color-bg-base', '26 27 38')
  document.documentElement.style.setProperty('--color-text-primary', '192 202 245')
  const terminal = { options: {} } as Terminal
  const container = document.createElement('div')
  container.innerHTML = '<div class="xterm"><div class="xterm-viewport"></div></div>'
  applyTerminalTheme(terminal, container)
  expect(terminal.options.theme).toMatchObject({
    black: 'rgb(0, 100, 200)',
    brightWhite: 'rgb(15, 100, 200)',
    background: 'rgb(26, 27, 38)',
    foreground: 'rgb(192, 202, 245)',
  })
  expect(Object.keys(terminal.options.theme ?? {})).toHaveLength(20)
  const onChange = vi.fn(theme => applyTerminalTheme(terminal, container, theme))
  const disconnect = observeTerminalTheme(onChange)
  document.documentElement.style.setProperty('--color-terminal-red', '247 118 142')
  await new Promise<void>(resolve => queueMicrotask(resolve))
  expect(onChange).toHaveBeenCalledOnce()
  expect(terminal.options.theme?.red).toBe('rgb(247, 118, 142)')
  expect(container.querySelector<HTMLElement>('.xterm-viewport')?.style.backgroundColor).toBe(
    'rgb(26, 27, 38)'
  )
  disconnect()
})

test('keeps workbench backgrounds transparent while preserving the terminal palette', () => {
  document.documentElement.style.setProperty('--color-terminal-cyan', '125 207 255')
  expect(getTerminalTheme(true)).toMatchObject({
    background: 'rgba(0, 0, 0, 0)',
    cyan: 'rgb(125, 207, 255)',
  })
})
