import type { Debugger } from 'electron'

type HeapPhase =
  | 'entered'
  | 'attach-started'
  | 'attach-completed'
  | 'collect-garbage-started'
  | 'collect-garbage-completed'
  | 'heap-usage-started'
  | 'heap-usage-completed'
  | 'operation-failed'
  | 'detach-started'
  | 'detach-completed'

export async function readE2ERendererHeapUsage(
  debugSession: Debugger,
  diagnostic: (entry: { phase: HeapPhase; elapsedMs: number }) => void = () => {}
): Promise<unknown> {
  const startedAt = performance.now()
  const record = (phase: HeapPhase) => {
    try {
      diagnostic({ phase, elapsedMs: Math.round(performance.now() - startedAt) })
    } catch {
      // Diagnostic failures must not affect CDP behavior or error propagation.
    }
  }
  record('entered')
  const alreadyAttached = debugSession.isAttached()
  if (!alreadyAttached) {
    record('attach-started')
    debugSession.attach('1.3')
    record('attach-completed')
  }
  try {
    record('collect-garbage-started')
    await debugSession.sendCommand('HeapProfiler.collectGarbage')
    record('collect-garbage-completed')
    record('heap-usage-started')
    const usage = await debugSession.sendCommand('Runtime.getHeapUsage')
    record('heap-usage-completed')
    return usage
  } catch (error) {
    record('operation-failed')
    throw error
  } finally {
    if (!alreadyAttached && debugSession.isAttached()) {
      record('detach-started')
      debugSession.detach()
      record('detach-completed')
    }
  }
}
