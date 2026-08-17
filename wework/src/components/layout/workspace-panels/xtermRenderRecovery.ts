import type { Terminal } from '@xterm/xterm'

export function logXtermRenderState({
  active,
  container,
  phase,
  sessionId,
  taskId,
  terminal,
  terminalKind,
}: {
  active: boolean
  container: HTMLElement
  phase: 'active-changed' | 'activation-complete'
  sessionId: string
  taskId?: string | null
  terminal: Terminal | null
  terminalKind: 'local' | 'remote'
}): void {
  console.info('[Wework][TerminalRender]', {
    active,
    clientHeight: container.clientHeight,
    clientWidth: container.clientWidth,
    documentVisibility: document.visibilityState,
    hidden: container.closest('[hidden]') !== null,
    phase,
    rows: terminal?.rows ?? null,
    cols: terminal?.cols ?? null,
    sessionId,
    taskId: taskId ?? null,
    terminalKind,
  })
}

export function refreshXterm(terminal: Terminal): void {
  if (terminal.rows <= 0) return
  terminal.refresh(0, terminal.rows - 1)
}

export function installXtermRenderRecovery(onRecover: () => void): () => void {
  let frameId: number | null = null

  const scheduleRecovery = () => {
    if (frameId !== null) return

    frameId = window.requestAnimationFrame(() => {
      frameId = null
      onRecover()
    })
  }
  const handleVisibilityChange = () => {
    if (document.visibilityState === 'visible') {
      scheduleRecovery()
    }
  }

  window.addEventListener('focus', scheduleRecovery)
  document.addEventListener('visibilitychange', handleVisibilityChange)

  return () => {
    window.removeEventListener('focus', scheduleRecovery)
    document.removeEventListener('visibilitychange', handleVisibilityChange)
    if (frameId !== null) {
      window.cancelAnimationFrame(frameId)
    }
  }
}
