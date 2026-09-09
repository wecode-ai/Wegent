import { FitAddon } from '@xterm/addon-fit'
import { Terminal } from '@xterm/xterm'
import '@xterm/xterm/css/xterm.css'
import { useEffect, useRef } from 'react'
import { connectLocalTerminal, resizeLocalTerminal, writeLocalTerminal } from '@/lib/local-terminal'
import { applyTerminalTheme, getTerminalTheme, observeTerminalTheme } from '@/lib/xterm-theme'
import { appendRuntimeTerminalContext } from '@/lib/runtime-terminal-context'
import { focusTerminalUnlessComposerFocusRequested } from '@/lib/workbenchComposerFocus'
import { defaultAppearance, useOptionalAppearance } from '@/features/appearance'
import { installXtermInputFallback, type XtermInputFallbackController } from './xtermInputFallback'
import { installXtermMacKeybindings } from './xtermMacKeybindings'
import { createXtermWebLinksAddon } from './xtermLinks'
import { installXtermSelectionGuard } from './xtermSelectionGuard'
import { installXtermTextDrag } from './xtermTextDrag'
import {
  installXtermRenderRecovery,
  logXtermRenderState,
  refreshXterm,
} from './xtermRenderRecovery'

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
  showWorkbenchBackground?: boolean
}

interface LocalTerminalResource {
  sessionId: string
  showWorkbenchBackground: boolean
  dispose: () => void
}

function matchesLocalTerminalResource(
  resource: LocalTerminalResource,
  sessionId: string,
  showWorkbenchBackground: boolean
): boolean {
  return (
    resource.sessionId === sessionId && resource.showWorkbenchBackground === showWorkbenchBackground
  )
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
  showWorkbenchBackground = false,
}: EmbeddedLocalTerminalProps) {
  const appearance = useOptionalAppearance()?.appearance ?? defaultAppearance
  const containerRef = useRef<HTMLDivElement | null>(null)
  const terminalRef = useRef<Terminal | null>(null)
  const fitAddonRef = useRef<FitAddon | null>(null)
  const activeRef = useRef(active)
  const contextRef = useRef({ taskId, workspacePath, cwd, title })
  const onExitRef = useRef(onExit)
  const onTitleChangeRef = useRef(onTitleChange)
  const lastSizeRef = useRef<{ rows: number; cols: number } | null>(null)
  const appearanceRef = useRef(appearance)
  const resourceRef = useRef<LocalTerminalResource | null>(null)
  const cleanupTimerRef = useRef<number | null>(null)

  useEffect(() => {
    appearanceRef.current = appearance
    const terminal = terminalRef.current
    const fitAddon = fitAddonRef.current
    if (!terminal) return

    terminal.options.fontFamily = appearance.codeFont
    terminal.options.fontSize = appearance.codeFontSize
    requestAnimationFrame(() => {
      try {
        fitAddon?.fit()
      } catch (error) {
        console.error('Failed to resize local terminal after typography change:', error)
      }
    })
  }, [appearance])

  useEffect(() => {
    activeRef.current = active
    const container = containerRef.current
    if (!container) return
    logXtermRenderState({
      active,
      container,
      phase: 'active-changed',
      sessionId,
      taskId,
      terminal: terminalRef.current,
      terminalKind: 'local',
    })
  }, [active, sessionId, taskId])

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

    if (cleanupTimerRef.current !== null) {
      window.clearTimeout(cleanupTimerRef.current)
      cleanupTimerRef.current = null
    }
    const currentResource = resourceRef.current
    if (
      currentResource &&
      matchesLocalTerminalResource(currentResource, sessionId, showWorkbenchBackground)
    ) {
      return () => {
        cleanupTimerRef.current = window.setTimeout(currentResource.dispose, 0)
      }
    }
    currentResource?.dispose()
    lastSizeRef.current = null

    const terminalAppearance = appearanceRef.current
    const terminal = new Terminal({
      allowTransparency: showWorkbenchBackground,
      cursorBlink: import.meta.env.VITE_WEWORK_E2E !== 'true',
      convertEol: true,
      fontFamily: terminalAppearance.codeFont,
      fontSize: terminalAppearance.codeFontSize,
      lineHeight: 1.2,
      screenReaderMode: import.meta.env.VITE_WEWORK_E2E === 'true',
      scrollback: 2000,
      theme: getTerminalTheme(showWorkbenchBackground),
    })
    const fitAddon = new FitAddon()
    const webLinksAddon = createXtermWebLinksAddon()
    let terminalInputReady = false
    let inputFallback: XtermInputFallbackController = {
      noteData: () => undefined,
      dispose: () => undefined,
    }
    const writeTerminalInput = (data: string) => {
      if (!terminalInputReady) return
      inputFallback.noteData(data)
      void writeLocalTerminal(sessionId, data)
    }
    const dataDisposable = terminal.onData(writeTerminalInput)
    const titleDisposable = terminal.onTitleChange(title => {
      onTitleChangeRef.current?.(title)
    })
    let disposed = false
    const unlisteners: Array<() => void> = []

    terminal.loadAddon(fitAddon)
    terminal.loadAddon(webLinksAddon)
    terminal.open(container)
    const selectionGuard = installXtermSelectionGuard({ container, terminal })
    const textDrag = installXtermTextDrag({ container, terminal })
    inputFallback = installXtermInputFallback({
      terminal,
      writeData: writeTerminalInput,
    })
    installXtermMacKeybindings({ terminal, writeData: writeTerminalInput })
    terminalRef.current = terminal
    fitAddonRef.current = fitAddon
    applyTerminalTheme(terminal, container, getTerminalTheme(), showWorkbenchBackground)
    const unobserveTheme = observeTerminalTheme(theme => {
      applyTerminalTheme(terminal, container, theme, showWorkbenchBackground)
    })

    const fitAndResize = () => {
      if (disposed || !activeRef.current || !container.isConnected) return
      try {
        fitAddon.fit()
        refreshXterm(terminal)
        syncTerminalSize()
      } catch (error) {
        console.error('Failed to resize local terminal:', error)
      }
    }

    const syncTerminalSize = () => {
      if (!activeRef.current || terminal.rows <= 0 || terminal.cols <= 0) return

      const lastSize = lastSizeRef.current
      if (lastSize?.rows === terminal.rows && lastSize.cols === terminal.cols) return

      const nextSize = { rows: terminal.rows, cols: terminal.cols }
      lastSizeRef.current = nextSize
      void resizeLocalTerminal(sessionId, nextSize.rows, nextSize.cols)
    }

    const resizeObserver = new ResizeObserver(fitAndResize)
    resizeObserver.observe(container)
    const removeRenderRecovery = installXtermRenderRecovery(fitAndResize)
    fitAndResize()
    requestAnimationFrame(fitAndResize)

    void connectLocalTerminal(
      sessionId,
      (payload, source) => {
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
          terminal.write(payload.data, () => {
            if (disposed) return
            if (source === 'snapshot') {
              terminalInputReady = true
              refreshXterm(terminal)
            }
          })
        }
      },
      payload => {
        if (!disposed && payload.session_id === sessionId) {
          onExitRef.current?.()
        }
      },
      {
        taskId: contextRef.current.taskId,
        workspacePath: contextRef.current.workspacePath,
      }
    )
      .then(unlisten => {
        if (disposed) {
          unlisten()
        } else {
          unlisteners.push(unlisten)
        }
      })
      .catch(error => {
        if (!disposed) {
          console.error('Failed to attach local terminal:', error)
          terminal.writeln('\r\n[Terminal connection failed]')
        }
      })

    const resource: LocalTerminalResource = {
      sessionId,
      showWorkbenchBackground,
      dispose: () => {
        if (disposed) return
        disposed = true
        unobserveTheme()
        removeRenderRecovery()
        resizeObserver.disconnect()
        dataDisposable.dispose()
        titleDisposable.dispose()
        selectionGuard.dispose()
        textDrag.dispose()
        inputFallback.dispose()
        unlisteners.forEach(unlisten => unlisten())
        terminal.dispose()
        if (resourceRef.current === resource) {
          terminalRef.current = null
          fitAddonRef.current = null
          resourceRef.current = null
        }
      },
    }
    resourceRef.current = resource

    return () => {
      cleanupTimerRef.current = window.setTimeout(resource.dispose, 0)
    }
  }, [sessionId, showWorkbenchBackground])

  useEffect(() => {
    if (!active) return

    const frame = requestAnimationFrame(() => {
      const terminal = terminalRef.current
      const fitAddon = fitAddonRef.current
      const container = containerRef.current
      if (!terminal || !fitAddon || !container) return

      try {
        applyTerminalTheme(terminal, container, getTerminalTheme(), showWorkbenchBackground)
        fitAddon.fit()
        refreshXterm(terminal)
        logXtermRenderState({
          active,
          container,
          phase: 'activation-complete',
          sessionId,
          taskId,
          terminal,
          terminalKind: 'local',
        })
        focusTerminalUnlessComposerFocusRequested(terminal.textarea)
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
  }, [active, sessionId, showWorkbenchBackground, taskId])

  return (
    <div
      data-testid={testIdsEnabled ? 'embedded-local-terminal' : undefined}
      data-session-id={testIdsEnabled ? sessionId : undefined}
      className={`h-full min-h-0 w-full overflow-hidden px-2 pb-4 pt-2 ${
        showWorkbenchBackground ? 'bg-transparent' : 'bg-background'
      }`}
      hidden={!active}
    >
      <div ref={containerRef} className="h-full min-h-0 w-full overflow-hidden" />
    </div>
  )
}
