import { DEBUG_SNAPSHOT_INTERVAL_MS, updateWorkbenchDebugSnapshot } from '@/lib/debugPanel'

export type WorkbenchDiagnosticInput = Parameters<typeof updateWorkbenchDebugSnapshot>[0]

/** Publish committed diagnostic frames without retaining an inactive tab's timer. */
export function createWorkbenchDebugPublisher(
  subscribeLifecycle: (notify: () => void) => () => void
) {
  let frame: WorkbenchDiagnosticInput | null = null
  let timer: ReturnType<typeof setTimeout> | undefined
  let unsubscribe: (() => void) | undefined
  const suspend = () => {
    unsubscribe?.()
    unsubscribe = undefined
    if (timer !== undefined) clearTimeout(timer)
    timer = undefined
    frame = null
  }
  const schedule = () => {
    if (timer !== undefined) return
    timer = setTimeout(() => {
      timer = undefined
      if (frame) updateWorkbenchDebugSnapshot(frame)
    }, DEBUG_SNAPSHOT_INTERVAL_MS)
  }
  return {
    update(next: WorkbenchDiagnosticInput | null) {
      frame = next
      if (!next) return suspend()
      unsubscribe ??= subscribeLifecycle(schedule)
      schedule()
    },
    suspend,
  }
}
