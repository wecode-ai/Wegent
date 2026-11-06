import type { Terminal } from '@xterm/xterm'
import { afterEach, expect, test, vi } from 'vitest'
import { applyTerminalTheme, getTerminalTheme, observeTerminalTheme } from './xterm-theme'

afterEach(() => {
  document.documentElement.removeAttribute('style')
  document.documentElement.removeAttribute('data-theme')
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
