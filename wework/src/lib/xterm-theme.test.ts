import { afterEach, describe, expect, test, vi } from 'vitest'
import { applyTerminalTheme, getTerminalTheme, observeTerminalTheme } from './xterm-theme'

function setThemeVariables() {
  const root = document.documentElement
  root.style.setProperty('--color-bg-base', '24 24 24')
  root.style.setProperty('--color-text-primary', '255 255 255')
  root.style.setProperty('--color-primary', '51 156 255')
}

describe('xterm-theme', () => {
  afterEach(() => {
    document.documentElement.removeAttribute('data-theme')
    document.documentElement.removeAttribute('class')
    document.documentElement.removeAttribute('style')
    vi.restoreAllMocks()
  })

  test('builds terminal colors from active theme tokens', () => {
    document.documentElement.dataset.theme = 'dark'
    setThemeVariables()

    expect(getTerminalTheme()).toEqual({
      background: 'rgb(24, 24, 24)',
      foreground: 'rgb(255, 255, 255)',
      cursor: 'rgb(51, 156, 255)',
      selectionBackground: 'rgba(51, 156, 255, 0.28)',
    })
  })

  test('observes root appearance changes', async () => {
    const onChange = vi.fn()
    const disconnect = observeTerminalTheme(onChange)

    document.documentElement.dataset.theme = 'dark'
    setThemeVariables()
    await new Promise(resolve => setTimeout(resolve, 0))

    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({
        background: 'rgb(24, 24, 24)',
        foreground: 'rgb(255, 255, 255)',
      })
    )

    disconnect()
  })

  test('applies terminal background to generated xterm nodes', () => {
    document.documentElement.dataset.theme = 'dark'
    setThemeVariables()
    const terminal = { options: {} }
    const container = document.createElement('div')
    container.innerHTML = `
      <div class="xterm">
        <div class="xterm-viewport"></div>
        <div class="xterm-screen"></div>
      </div>
    `

    applyTerminalTheme(terminal as never, container)

    expect(terminal.options).toEqual({
      theme: expect.objectContaining({ background: 'rgb(24, 24, 24)' }),
    })
    expect(container.style.backgroundColor).toBe('rgb(24, 24, 24)')
    expect(container.querySelector<HTMLElement>('.xterm-viewport')?.style.backgroundColor).toBe(
      'rgb(24, 24, 24)'
    )
    expect(container.querySelector<HTMLElement>('.xterm-screen')?.style.backgroundColor).toBe(
      'rgb(24, 24, 24)'
    )
  })

  test('applies a transparent background to the terminal and generated nodes', () => {
    const terminal = { options: {} }
    const container = document.createElement('div')
    container.innerHTML = '<div class="xterm"><div class="xterm-viewport"></div></div>'

    applyTerminalTheme(terminal as never, container, getTerminalTheme(), true)

    expect(terminal.options).toEqual({
      theme: expect.objectContaining({ background: 'rgba(0, 0, 0, 0)' }),
    })
    expect(container.style.backgroundColor).toBe('rgba(0, 0, 0, 0)')
    expect(container.querySelector<HTMLElement>('.xterm-viewport')?.style.backgroundColor).toBe(
      'rgba(0, 0, 0, 0)'
    )
  })
})
