import type { Terminal } from '@xterm/xterm'

const instances = new WeakMap<Terminal, number>()
let nextInstance = 0

export function traceTerminal(
  terminal: Terminal,
  stage: string,
  details: Record<string, unknown> = {}
) {
  if (import.meta.env.VITE_WEWORK_E2E !== 'true') return
  console.info(
    '[desktop-e2e-terminal] ' +
      JSON.stringify({
        stage,
        timestamp: Date.now(),
        instance: instances.get(terminal),
        rows: terminal.rows,
        cols: terminal.cols,
        base: terminal.buffer.active.baseY,
        viewport: terminal.buffer.active.viewportY,
        focused: terminal.textarea === document.activeElement,
        ...details,
      })
  )
}

export function observeTerminalDiagnostics(terminal: Terminal) {
  if (import.meta.env.VITE_WEWORK_E2E !== 'true') return () => {}
  instances.set(terminal, ++nextInstance)
  traceTerminal(terminal, 'created')
  const scroll = terminal.onScroll(() => traceTerminal(terminal, 'scroll'))
  const written = terminal.onWriteParsed(() => traceTerminal(terminal, 'written'))
  let active = true
  const key = (event: KeyboardEvent) => {
    if (!['PageUp', 'PageDown', 'Home', 'End', 'ArrowUp', 'ArrowDown'].includes(event.key)) return
    const details = { key: event.key, code: event.keyCode, shift: event.shiftKey }
    traceTerminal(terminal, 'key', details)
    queueMicrotask(() => {
      if (active)
        traceTerminal(terminal, 'key-handled', { ...details, prevented: event.defaultPrevented })
    })
  }
  terminal.textarea?.addEventListener('keydown', key, true)
  return () => {
    active = false
    traceTerminal(terminal, 'disposed')
    scroll.dispose()
    written.dispose()
    terminal.textarea?.removeEventListener('keydown', key, true)
  }
}
