import { FitAddon } from '@xterm/addon-fit'
import { Terminal } from '@xterm/xterm'
import { connectLocalTerminal, resizeLocalTerminal, writeLocalTerminal } from '@/lib/local-terminal'
import { applyTerminalTheme, getTerminalTheme, observeTerminalTheme } from '@/lib/xterm-theme'
import { appendRuntimeTerminalContext } from '@/lib/runtime-terminal-context'
import { focusTerminalUnlessComposerFocusRequested } from '@/lib/workbenchComposerFocus'
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

export interface LocalTerminalViewInput {
  sessionId: string
  active: boolean
  taskId?: string | null
  workspacePath?: string | null
  cwd?: string | null
  title?: string | null
  onExit?: () => void
  onTitleChange?: (title: string) => void
  showWorkbenchBackground: boolean
  fontFamily: string
  fontSize: number
}

function openLocalTerminalView(
  container: HTMLDivElement,
  initial: LocalTerminalViewInput,
  isBound: () => boolean
) {
  const { sessionId, showWorkbenchBackground } = initial
  let input = initial
  let disposed = false
  let exited = false
  let inputReady = false
  let pendingInput = ''
  let lastSize: { rows: number; cols: number } | null = null
  let activationFrame: number | null = null
  let typographyFrame: number | null = null
  let initialFitFrame: number | null = null
  const isCurrent = () => !disposed && isBound() && container.isConnected
  const terminal = new Terminal({
    allowTransparency: showWorkbenchBackground,
    cursorBlink: import.meta.env.VITE_WEWORK_E2E !== 'true',
    convertEol: true,
    fontFamily: initial.fontFamily,
    fontSize: initial.fontSize,
    lineHeight: 1.2,
    screenReaderMode: import.meta.env.VITE_WEWORK_E2E === 'true',
    scrollback: 2000,
    theme: getTerminalTheme(showWorkbenchBackground),
  })
  const fitAddon = new FitAddon()
  const unlisteners: Array<() => void> = []
  let inputFallback: XtermInputFallbackController = {
    noteData: () => undefined,
    dispose: () => undefined,
  }
  function writeInput(data: string) {
    if (!isCurrent() || exited) return
    if (!inputReady) {
      pendingInput += data
      return
    }
    inputFallback.noteData(data)
    void writeLocalTerminal(sessionId, data)
  }
  const dataDisposable = terminal.onData(writeInput)
  const titleDisposable = terminal.onTitleChange(title => {
    if (isCurrent()) input.onTitleChange?.(title)
  })
  terminal.loadAddon(fitAddon)
  terminal.loadAddon(createXtermWebLinksAddon())
  terminal.open(container)
  const selectionGuard = installXtermSelectionGuard({ container, terminal })
  const textDrag = installXtermTextDrag({ container, terminal })
  inputFallback = installXtermInputFallback({ terminal, writeData: writeInput })
  installXtermMacKeybindings({ terminal, writeData: writeInput })
  applyTerminalTheme(terminal, container, getTerminalTheme(), showWorkbenchBackground)
  const unobserveTheme = observeTerminalTheme(theme => {
    if (isCurrent()) applyTerminalTheme(terminal, container, theme, showWorkbenchBackground)
  })
  function syncSize() {
    if (
      !isCurrent() ||
      !inputReady ||
      exited ||
      !input.active ||
      terminal.rows <= 0 ||
      terminal.cols <= 0
    )
      return
    if (lastSize?.rows === terminal.rows && lastSize.cols === terminal.cols) return
    lastSize = { rows: terminal.rows, cols: terminal.cols }
    void resizeLocalTerminal(sessionId, lastSize.rows, lastSize.cols)
  }
  function fitAndResize() {
    if (!isCurrent() || !input.active) return
    try {
      fitAddon.fit()
      refreshXterm(terminal)
      syncSize()
    } catch (error) {
      console.error('Failed to resize local terminal:', error)
    }
  }
  const resizeObserver = new ResizeObserver(fitAndResize)
  resizeObserver.observe(container)
  const removeRenderRecovery = installXtermRenderRecovery(fitAndResize)
  fitAndResize()
  initialFitFrame = requestAnimationFrame(() => {
    initialFitFrame = null
    fitAndResize()
  })

  void connectLocalTerminal(
    sessionId,
    (payload, source) => {
      if (!isCurrent() || payload.session_id !== sessionId) return
      appendRuntimeTerminalContext({
        sessionId,
        taskId: input.taskId,
        workspacePath: input.workspacePath,
        cwd: input.cwd,
        title: input.title,
        kind: 'local',
        data: payload.data,
      })
      terminal.write(payload.data, () => {
        if (!isCurrent()) return
        if (source === 'snapshot') {
          inputReady = true
          syncSize()
          if (pendingInput) {
            const data = pendingInput
            pendingInput = ''
            writeInput(data)
          }
          refreshXterm(terminal)
        }
      })
    },
    payload => {
      if (!isCurrent() || payload.session_id !== sessionId) return
      exited = true
      terminal.options.disableStdin = true
      pendingInput = ''
      input.onExit?.()
    },
    { taskId: initial.taskId, workspacePath: initial.workspacePath }
  )
    .then(unlisten => {
      if (disposed) unlisten()
      else unlisteners.push(unlisten)
    })
    .catch(error => {
      if (!isCurrent()) return
      console.error('Failed to attach local terminal:', error)
      terminal.writeln('\r\n[Terminal connection failed]')
    })

  function log(phase: 'active-changed' | 'activation-complete') {
    logXtermRenderState({
      active: input.active,
      container,
      phase,
      sessionId,
      taskId: input.taskId,
      terminal,
      terminalKind: 'local',
    })
  }
  function activate() {
    if (activationFrame !== null) cancelAnimationFrame(activationFrame)
    activationFrame = null
    if (!input.active) return
    activationFrame = requestAnimationFrame(() => {
      activationFrame = null
      if (!isCurrent() || !input.active) return
      try {
        applyTerminalTheme(terminal, container, getTerminalTheme(), showWorkbenchBackground)
        fitAddon.fit()
        refreshXterm(terminal)
        log('activation-complete')
        focusTerminalUnlessComposerFocusRequested(terminal.textarea)
        syncSize()
      } catch (error) {
        console.error('Failed to activate local terminal:', error)
      }
    })
  }
  log('active-changed')
  activate()
  return {
    matches(node: HTMLDivElement, next: LocalTerminalViewInput) {
      return (
        !disposed &&
        node === container &&
        next.sessionId === sessionId &&
        next.showWorkbenchBackground === showWorkbenchBackground
      )
    },
    update(next: LocalTerminalViewInput) {
      const previous = input
      input = next
      if (previous.fontFamily !== next.fontFamily || previous.fontSize !== next.fontSize) {
        terminal.options.fontFamily = next.fontFamily
        terminal.options.fontSize = next.fontSize
        if (typographyFrame !== null) cancelAnimationFrame(typographyFrame)
        typographyFrame = requestAnimationFrame(() => {
          typographyFrame = null
          if (!isCurrent()) return
          try {
            fitAddon.fit()
          } catch (error) {
            console.error('Failed to resize local terminal after typography change:', error)
          }
        })
      }
      if (previous.active !== next.active || previous.taskId !== next.taskId) {
        log('active-changed')
        activate()
      }
    },
    dispose() {
      if (disposed) return
      disposed = true
      pendingInput = ''
      for (const frame of [initialFitFrame, activationFrame, typographyFrame]) {
        if (frame !== null) cancelAnimationFrame(frame)
      }
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
    },
  }
}

/** Owns the xterm widget and its local transport, not the underlying shell session. */
export function createEmbeddedLocalTerminalPort() {
  let current: ReturnType<typeof openLocalTerminalView> | null = null
  let binding: symbol | null = null
  let cleanupTimer: number | null = null
  return {
    bind(container: HTMLDivElement, input: LocalTerminalViewInput) {
      const lease = Symbol('local-terminal-view')
      binding = lease
      if (cleanupTimer !== null) {
        window.clearTimeout(cleanupTimer)
        cleanupTimer = null
      }
      if (current && !current.matches(container, input)) {
        current.dispose()
        current = null
      }
      if (current) current.update(input)
      else current = openLocalTerminalView(container, input, () => binding !== null)
      return () => {
        if (binding !== lease) return
        binding = null
        // React callback replacement reuses the live widget and pending connection.
        cleanupTimer = window.setTimeout(() => {
          cleanupTimer = null
          if (binding !== null) return
          current?.dispose()
          current = null
        }, 0)
      }
    },
  }
}
