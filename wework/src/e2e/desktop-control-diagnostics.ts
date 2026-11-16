import type { DesktopControlCommand } from '@/extensions/desktop-control-contract'

interface DesktopControlTraceEntry {
  phase: string
  at: string
  monotonicMs: number
  visibility: DocumentVisibilityState
  focused: boolean
  commandId?: string
  action?: string
}

const trace: DesktopControlTraceEntry[] = []

// The isolated control client calls this; do not retain selectors, values or result bodies.
export function recordDesktopControlPhase(
  phase: string,
  command?: Pick<DesktopControlCommand, 'id' | 'action'>
) {
  trace.push({
    phase,
    at: new Date().toISOString(),
    monotonicMs: performance.now(),
    visibility: document.visibilityState,
    focused: document.hasFocus(),
    ...(command ? { commandId: command.id, action: command.action } : {}),
  })
  if (trace.length > 100) trace.splice(0, trace.length - 100)
}

export function getDesktopControlDiagnostics() {
  return trace.map(entry => ({ ...entry }))
}
