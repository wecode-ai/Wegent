import { DEBUG_SNAPSHOT_INTERVAL_MS, updateWorkbenchDebugSnapshot } from '@/lib/debugPanel'

export type WorkbenchDiagnosticInput = Parameters<typeof updateWorkbenchDebugSnapshot>[0]

/** Publish committed diagnostic frames without retaining an inactive tab's timer. */
export function createWorkbenchDebugPublisher() {
  let frame: WorkbenchDiagnosticInput | null = null
  let timer: ReturnType<typeof setTimeout> | undefined
  const suspend = () => {
    if (timer !== undefined) clearTimeout(timer)
    timer = undefined
    frame = null
  }
  return {
    update(next: WorkbenchDiagnosticInput | null) {
      frame = next
      if (!next) return suspend()
      if (timer !== undefined) return
      timer = setTimeout(() => {
        timer = undefined
        if (frame) updateWorkbenchDebugSnapshot(frame)
      }, DEBUG_SNAPSHOT_INTERVAL_MS)
    },
    suspend,
  }
}
