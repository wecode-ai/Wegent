import { FitAddon } from '@xterm/addon-fit'
import { Terminal } from '@xterm/xterm'
import '@xterm/xterm/css/xterm.css'
import { useEffect, useRef } from 'react'
import { createRemoteTerminalClient, type RemoteTerminalClient } from '@/lib/remote-terminal-socket'

interface RemoteTerminalProps {
  sessionId: string
  active: boolean
  testIdsEnabled?: boolean
}

export function RemoteTerminal({ sessionId, active, testIdsEnabled = true }: RemoteTerminalProps) {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const terminalRef = useRef<Terminal | null>(null)
  const fitAddonRef = useRef<FitAddon | null>(null)
  const clientRef = useRef<RemoteTerminalClient | null>(null)

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
    const client = createRemoteTerminalClient(sessionId)
    let disposed = false

    const dataDisposable = terminal.onData(data => {
      void client.write(data).catch(error => {
        if (!disposed) {
          console.error('Failed to write to remote terminal:', error)
        }
      })
    })
    const unsubscribeOutput = client.onOutput(payload => {
      if (!disposed && payload.session_id === sessionId) {
        terminal.write(payload.data)
      }
    })
    const unsubscribeExit = client.onExit(payload => {
      if (!disposed && payload.session_id === sessionId) {
        terminal.writeln('\r\n[Process exited]')
      }
    })

    terminal.loadAddon(fitAddon)
    terminal.open(container)
    terminalRef.current = terminal
    fitAddonRef.current = fitAddon
    clientRef.current = client

    const fitAndResize = () => {
      if (disposed || !container.isConnected) return
      try {
        fitAddon.fit()
      } catch (error) {
        console.error('Failed to resize remote terminal:', error)
        return
      }
      void client.resize(terminal.rows, terminal.cols).catch(error => {
        if (!disposed) {
          console.error('Failed to resize remote terminal:', error)
        }
      })
    }

    const resizeObserver = new ResizeObserver(fitAndResize)
    resizeObserver.observe(container)

    void client
      .attach()
      .then(() => {
        requestAnimationFrame(fitAndResize)
      })
      .catch(error => {
        if (!disposed) {
          console.error('Failed to attach remote terminal:', error)
          terminal.writeln('\r\n[Terminal connection failed]')
        }
      })

    return () => {
      disposed = true
      resizeObserver.disconnect()
      dataDisposable.dispose()
      unsubscribeOutput()
      unsubscribeExit()
      void client
        .close()
        .catch(() => undefined)
        .finally(() => {
          client.dispose()
        })
      terminal.dispose()
      terminalRef.current = null
      fitAddonRef.current = null
      clientRef.current = null
    }
  }, [sessionId])

  useEffect(() => {
    if (!active) return

    const frame = requestAnimationFrame(() => {
      const terminal = terminalRef.current
      const fitAddon = fitAddonRef.current
      const client = clientRef.current
      if (!terminal || !fitAddon || !client) return

      try {
        fitAddon.fit()
        terminal.focus()
      } catch (error) {
        console.error('Failed to activate remote terminal:', error)
        return
      }
      void client.resize(terminal.rows, terminal.cols).catch(error => {
        console.error('Failed to sync remote terminal size on activate:', error)
      })
    })

    return () => {
      cancelAnimationFrame(frame)
    }
  }, [active])

  return (
    <div
      ref={containerRef}
      data-testid={testIdsEnabled ? 'remote-terminal' : undefined}
      className="h-full min-h-0 w-full flex-1 overflow-hidden bg-white px-2 py-2"
      hidden={!active}
    />
  )
}
