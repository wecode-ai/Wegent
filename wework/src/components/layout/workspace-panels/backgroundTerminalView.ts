import { FitAddon } from '@xterm/addon-fit'
import { Terminal } from '@xterm/xterm'
import type { NativeTerminalElement } from '@/e2e/native-terminal-diagnostics'
import { applyTerminalTheme, getTerminalTheme, observeTerminalTheme } from '@/lib/xterm-theme'
import { createXtermWebLinksAddon } from './xtermLinks'
import { logRuntimeTaskCreateStage } from '@/lib/runtime-create-diagnostics'
import { registerNativeTerminalViewport } from '@/e2e/native-key-observation'

export interface BackgroundTerminalBindingInput {
  scopeKey: string
  terminalId?: string
  output: string
  active: boolean
  fontFamily: string
  fontSize: number
}

function openBackgroundTerminal(
  container: NativeTerminalElement,
  input: BackgroundTerminalBindingInput
) {
  const xterm = new Terminal({
    disableStdin: true,
    screenReaderMode: true,
    cursorBlink: false,
    cursorInactiveStyle: 'none',
    convertEol: true,
    fontFamily: input.fontFamily,
    fontSize: input.fontSize,
    lineHeight: 1.2,
    theme: getTerminalTheme(),
    scrollback: 5000,
  })
  const fit = new FitAddon()
  xterm.loadAddon(fit)
  xterm.loadAddon(createXtermWebLinksAddon())
  xterm.open(container)
  applyTerminalTheme(xterm, container)
  const disposeViewport =
    import.meta.env.VITE_WEWORK_E2E === 'true'
      ? registerNativeTerminalViewport(container, () => xterm.buffer.active.viewportY + 1)
      : null
  let lastHistoryKeyAt = 0
  const logViewport = (stage: string) =>
    logRuntimeTaskCreateStage(stage, {
      terminalId: input.terminalId,
      viewportY: xterm.buffer.active.viewportY,
      baseY: xterm.buffer.active.baseY,
    })
  const scrollDiagnostic =
    import.meta.env.VITE_WEWORK_E2E === 'true'
      ? xterm.onScroll(() => {
          if (Date.now() - lastHistoryKeyAt < 2000) logViewport('background-terminal-scroll')
        })
      : null
  if (import.meta.env.VITE_WEWORK_E2E === 'true') {
    container.__weworkViewportForE2E = () => ({
      viewportY: xterm.buffer.active.viewportY,
      baseY: xterm.buffer.active.baseY,
      length: xterm.buffer.active.length,
      rows: xterm.rows,
    })
    xterm.attachCustomKeyEventHandler(event => {
      if (event.type === 'keydown' && ['PageUp', 'PageDown'].includes(event.key)) {
        lastHistoryKeyAt = Date.now()
        logViewport(`background-terminal-${event.key}`)
      }
      return true
    })
  }
  const disposeTheme = observeTerminalTheme(theme => applyTerminalTheme(xterm, container, theme))
  const observer = new ResizeObserver(() => {
    if (container.clientWidth > 0 && container.clientHeight > 0) fit.fit()
  })
  observer.observe(container)
  return {
    terminal: xterm,
    fit,
    output: '',
    scopeKey: input.scopeKey,
    dispose() {
      observer.disconnect()
      scrollDiagnostic?.dispose()
      disposeViewport?.()
      disposeTheme()
      delete container.__weworkViewportForE2E
      xterm.dispose()
    },
  }
}

/** The terminal node owns disposal; its enclosing viewport commits renderer inputs. */
export function createBackgroundTerminalBinding() {
  let container: NativeTerminalElement | null = null
  let viewport: HTMLElement | null = null
  let input: BackgroundTerminalBindingInput | undefined
  let current: ReturnType<typeof openBackgroundTerminal> | undefined
  const sync = () => {
    if (!container || !viewport?.contains(container) || !input) return
    if (current && (!input.output || current.scopeKey !== input.scopeKey)) {
      current.dispose()
      current = undefined
    }
    if (!input.output) return
    current ??= openBackgroundTerminal(container, input)
    current.terminal.options.fontFamily = input.fontFamily
    current.terminal.options.fontSize = input.fontSize
    if (input.output.startsWith(current.output)) {
      const delta = input.output.slice(current.output.length)
      if (delta) current.terminal.write(delta)
    } else {
      if (import.meta.env.VITE_WEWORK_E2E === 'true')
        logRuntimeTaskCreateStage('background-terminal-output-reset', {
          terminalId: input.terminalId,
          previousLength: current.output.length,
          nextLength: input.output.length,
          viewportY: current.terminal.buffer.active.viewportY,
          baseY: current.terminal.buffer.active.baseY,
        })
      current.terminal.reset()
      current.terminal.write(input.output)
    }
    current.output = input.output
    if (input.active && container.clientWidth) current.fit.fit()
  }
  return {
    updateViewport(node: HTMLElement, next: BackgroundTerminalBindingInput) {
      viewport = node
      input = next
      sync()
    },
    attach(node: HTMLDivElement | null) {
      container = node as NativeTerminalElement | null
      if (!container) return
      sync()
      return () => {
        const previous = current
        current = undefined
        container = null
        previous?.dispose()
      }
    },
  }
}
