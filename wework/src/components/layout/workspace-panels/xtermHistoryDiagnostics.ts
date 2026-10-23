import type { Terminal } from '@xterm/xterm'
import { logRuntimeTaskCreateStage } from '@/lib/runtime-create-diagnostics'

export function installXtermHistoryDiagnostics(terminal: Terminal, terminalId: string) {
  if (import.meta.env.VITE_WEWORK_E2E !== 'true') return () => {}

  let disposed = false
  const record = (phase: string) => {
    if (disposed) return
    const buffer = terminal.buffer.active
    logRuntimeTaskCreateStage('terminal-history', {
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
    disposed = true
    scroll.dispose()
    resize.dispose()
    output.dispose()
    terminal.element?.removeEventListener('keydown', keydown, true)
  }
}
