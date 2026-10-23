import type { Terminal } from '@xterm/xterm'

export function installXtermHistoryDiagnostics(terminal: Terminal, terminalId: string) {
  if (import.meta.env.VITE_WEWORK_E2E !== 'true') return () => {}

  const record = (phase: string) => {
    const buffer = terminal.buffer.active
    console.info('[Wework][TerminalHistory]', {
      at: new Date().toISOString(),
      terminalId,
      phase,
      viewportY: buffer.viewportY,
      baseY: buffer.baseY,
      rows: terminal.rows,
      cols: terminal.cols,
      accessibleRow: terminal.element
        ?.querySelector('.xterm-accessibility-tree > [role="listitem"]')
        ?.getAttribute('aria-posinset'),
    })
  }
  const scroll = terminal.onScroll(() => record('scroll'))
  const resize = terminal.onResize(() => record('resize'))
  const output = terminal.onWriteParsed(() => record('output'))
  const keydown = (event: KeyboardEvent) => {
    if (event.key !== 'PageUp' && event.key !== 'PageDown') return
    record(`before-${event.shiftKey ? 'Shift+' : ''}${event.key}`)
    queueMicrotask(() => record(`after-${event.shiftKey ? 'Shift+' : ''}${event.key}`))
  }
  terminal.element?.addEventListener('keydown', keydown, true)
  return () => {
    scroll.dispose()
    resize.dispose()
    output.dispose()
    terminal.element?.removeEventListener('keydown', keydown, true)
  }
}
