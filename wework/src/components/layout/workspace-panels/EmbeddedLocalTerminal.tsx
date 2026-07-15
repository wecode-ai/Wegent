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
import {
  applyTerminalTheme,
  createTerminalThemeScheduler,
  getTerminalTheme,
  observeTerminalTheme,
} from '@/lib/xterm-theme'
import { appendRuntimeTerminalContext } from '@/lib/runtime-terminal-context'
import { installXtermInputFallback, type XtermInputFallbackController } from './xtermInputFallback'
import { createXtermWebLinksAddon } from './xtermLinks'
import { installXtermSelectionGuard } from './xtermSelectionGuard'

interface EmbeddedLocalTerminalProps {
  sessionId: string
  active: boolean
  taskId?: string | null
  workspacePath?: string | null
  cwd?: string | null
  title?: string | null
  onExit?: () => void
  onTitleChange?: (title: string) => void
  testIdsEnabled?: boolean
}

export function EmbeddedLocalTerminal({
  sessionId,
  active,
  taskId,
  workspacePath,
  cwd,
  title,
  onExit,
  onTitleChange,
  testIdsEnabled = true,
}: EmbeddedLocalTerminalProps) {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const terminalRef = useRef<Terminal | null>(null)
  const fitAddonRef = useRef<FitAddon | null>(null)
  const activeRef = useRef(active)
  const contextRef = useRef({ taskId, workspacePath, cwd, title })
  const onExitRef = useRef(onExit)
  const onTitleChangeRef = useRef(onTitleChange)
  const lastSizeRef = useRef<{ rows: number; cols: number } | null>(null)

  useEffect(() => {
    activeRef.current = active
  }, [active])

  useEffect(() => {
    contextRef.current = { taskId, workspacePath, cwd, title }
  }, [cwd, taskId, title, workspacePath])

  useEffect(() => {
    onExitRef.current = onExit
  }, [onExit])

  useEffect(() => {
    onTitleChangeRef.current = onTitleChange
  }, [onTitleChange])

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
      theme: getTerminalTheme(),
    })
    const fitAddon = new FitAddon()
    const webLinksAddon = createXtermWebLinksAddon()
    let inputFallback: XtermInputFallbackController = {
      noteData: () => undefined,
      dispose: () => undefined,
    }
    const dataDisposable = terminal.onData(data => {
      inputFallback.noteData(data)
      void writeLocalTerminal(sessionId, data)
    })
    const titleDisposable = terminal.onTitleChange(title => {
      onTitleChangeRef.current?.(title)
    })
    let disposed = false
    const unlisteners: Array<() => void> = []

    terminal.loadAddon(fitAddon)
    terminal.loadAddon(webLinksAddon)
    terminal.open(container)
    const selectionGuard = installXtermSelectionGuard({ container, terminal })
    inputFallback = installXtermInputFallback({
      terminal,
      writeData: data => {
        inputFallback.noteData(data)
        void writeLocalTerminal(sessionId, data)
      },
    })
    terminalRef.current = terminal
    fitAddonRef.current = fitAddon
    applyTerminalTheme(terminal, container)
    const scheduleThemeSync = createTerminalThemeScheduler(terminal, container)
    const unobserveTheme = observeTerminalTheme(theme => {
      applyTerminalTheme(terminal, container, theme)
    })

    const fitAndResize = () => {
      if (disposed || !container.isConnected) return
      try {
        fitAddon.fit()
        syncTerminalSize()
      } catch (error) {
        console.error('Failed to resize local terminal:', error)
      }
    }

    const syncTerminalSize = () => {
      if (!activeRef.current || terminal.rows <= 0 || terminal.cols <= 0) return

      const lastSize = lastSizeRef.current
      if (lastSize?.rows === terminal.rows && lastSize.cols === terminal.cols) return

      lastSizeRef.current = { rows: terminal.rows, cols: terminal.cols }
      void resizeLocalTerminal(sessionId, terminal.rows, terminal.cols)
    }

    const resizeObserver = new ResizeObserver(fitAndResize)
    resizeObserver.observe(container)
    requestAnimationFrame(fitAndResize)

    void listenLocalTerminalOutput(payload => {
      if (!disposed && payload.session_id === sessionId) {
        const context = contextRef.current
        appendRuntimeTerminalContext({
          sessionId,
          taskId: context.taskId,
          workspacePath: context.workspacePath,
          cwd: context.cwd,
          title: context.title,
          kind: 'local',
          data: payload.data,
        })
        terminal.write(payload.data)
        scheduleThemeSync()
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
        onExitRef.current?.()
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
      unobserveTheme()
      resizeObserver.disconnect()
      dataDisposable.dispose()
      titleDisposable.dispose()
      selectionGuard.dispose()
      inputFallback.dispose()
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
      const container = containerRef.current
      if (!terminal || !fitAddon || !container) return

      try {
        applyTerminalTheme(terminal, container)
        fitAddon.fit()
        terminal.focus()
        if (terminal.rows > 0 && terminal.cols > 0) {
          const lastSize = lastSizeRef.current
          if (lastSize?.rows !== terminal.rows || lastSize.cols !== terminal.cols) {
            lastSizeRef.current = { rows: terminal.rows, cols: terminal.cols }
            void resizeLocalTerminal(sessionId, terminal.rows, terminal.cols)
          }
        }
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
      data-testid={testIdsEnabled ? 'embedded-local-terminal' : undefined}
      className="h-full min-h-0 w-full overflow-hidden bg-background px-2 pb-4 pt-2"
      hidden={!active}
    >
      <div ref={containerRef} className="h-full min-h-0 w-full overflow-hidden" />
    </div>
  )
}
