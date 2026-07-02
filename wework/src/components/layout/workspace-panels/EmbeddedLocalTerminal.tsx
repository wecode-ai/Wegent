import { FitAddon } from '@xterm/addon-fit'
import { Terminal } from '@xterm/xterm'
import '@xterm/xterm/css/xterm.css'
import { useEffect, useRef } from 'react'
import {
  listenLocalTerminalExit,
  listenLocalTerminalOutput,
  resizeLocalTerminal,
  writeLocalTerminal,
} from '@/lib/local-terminal'

interface EmbeddedLocalTerminalProps {
  sessionId: string
  active: boolean
  testIdsEnabled?: boolean
}

export function EmbeddedLocalTerminal({
  sessionId,
  active,
  testIdsEnabled = true,
}: EmbeddedLocalTerminalProps) {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const terminalRef = useRef<Terminal | null>(null)
  const fitAddonRef = useRef<FitAddon | null>(null)

  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    const terminal = new Terminal({
      cursorBlink: true,
      convertEol: true,
      fontFamily: 'Menlo, Monaco, "Courier New", monospace',
      fontSize: 13,
      lineHeight: 1.2,
      scrollback: 2000,
      theme: {
        background: '#ffffff',
        foreground: '#1a1a1a',
        cursor: '#14b8a6',
        selectionBackground: '#d8f3ee',
      },
    })
    const fitAddon = new FitAddon()
    const dataDisposable = terminal.onData(data => {
      void writeLocalTerminal(sessionId, data)
    })
    let disposed = false
    const unlisteners: Array<() => void> = []

    terminal.loadAddon(fitAddon)
    terminal.open(container)
    terminalRef.current = terminal
    fitAddonRef.current = fitAddon

    const fitAndResize = () => {
      if (disposed || !container.isConnected) return
      try {
        fitAddon.fit()
        void resizeLocalTerminal(sessionId, terminal.rows, terminal.cols)
      } catch (error) {
        console.error('Failed to resize local terminal:', error)
      }
    }

    const resizeObserver = new ResizeObserver(fitAndResize)
    resizeObserver.observe(container)
    requestAnimationFrame(fitAndResize)

    void listenLocalTerminalOutput(payload => {
      if (!disposed && payload.session_id === sessionId) {
        terminal.write(payload.data)
      }
    }).then(unlisten => {
      if (disposed) {
        unlisten()
      } else {
        unlisteners.push(unlisten)
      }
    })

    void listenLocalTerminalExit(payload => {
      if (!disposed && payload.session_id === sessionId) {
        terminal.writeln('\r\n[Process exited]')
      }
    }).then(unlisten => {
      if (disposed) {
        unlisten()
      } else {
        unlisteners.push(unlisten)
      }
    })

    return () => {
      disposed = true
      resizeObserver.disconnect()
      dataDisposable.dispose()
      unlisteners.forEach(unlisten => unlisten())
      terminal.dispose()
      terminalRef.current = null
      fitAddonRef.current = null
    }
  }, [sessionId])

  useEffect(() => {
    if (!active) return

    const frame = requestAnimationFrame(() => {
      const terminal = terminalRef.current
      const fitAddon = fitAddonRef.current
      if (!terminal || !fitAddon) return

      try {
        fitAddon.fit()
        terminal.focus()
        void resizeLocalTerminal(sessionId, terminal.rows, terminal.cols)
      } catch (error) {
        console.error('Failed to activate local terminal:', error)
      }
    })

    return () => {
      cancelAnimationFrame(frame)
    }
  }, [active, sessionId])

  return (
    <div
      ref={containerRef}
      data-testid={testIdsEnabled ? 'embedded-local-terminal' : undefined}
      className="h-full min-h-0 w-full overflow-hidden bg-white px-2 py-2"
      hidden={!active}
    />
  )
}
