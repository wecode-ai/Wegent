import { afterEach, describe, expect, test, vi } from 'vitest'
import { applyTerminalTheme, getTerminalTheme, observeTerminalTheme } from './xterm-theme'

function setThemeVariables() {
  const root = document.documentElement
  root.style.setProperty('--color-bg-base', '17 19 22')
  root.style.setProperty('--color-text-primary', '241 245 249')
  root.style.setProperty('--color-primary', '45 212 191')
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
      background: 'rgb(17, 19, 22)',
      foreground: 'rgb(241, 245, 249)',
      cursor: 'rgb(45, 212, 191)',
      selectionBackground: 'rgba(45, 212, 191, 0.28)',
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
        background: 'rgb(17, 19, 22)',
        foreground: 'rgb(241, 245, 249)',
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
      theme: expect.objectContaining({ background: 'rgb(17, 19, 22)' }),
    })
    expect(container.style.backgroundColor).toBe('rgb(17, 19, 22)')
    expect(container.querySelector<HTMLElement>('.xterm-viewport')?.style.backgroundColor).toBe(
      'rgb(17, 19, 22)'
    )
    expect(container.querySelector<HTMLElement>('.xterm-screen')?.style.backgroundColor).toBe(
      'rgb(17, 19, 22)'
    )
  })
})
