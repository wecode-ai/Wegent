import { buildRuntimeTaskRoute, navigateTo } from '@/lib/navigation'
import type { RuntimeTaskAddress } from '@/types/api'
import type { AutomationRun } from '@/types/automation'

export interface AutomationRunNavigationOptions {
  openRuntimeTask(address: RuntimeTaskAddress): Promise<unknown>
  requestLeave(action: () => void): void
  onNavigate?(action: () => void): void
  onError(message: string): void
}

/** Pending runtime opens belong to the calendar that requested them. */
export function createAutomationRunNavigation() {
  const observers = new Set<{ notify(): void; options: AutomationRunNavigationOptions }>()
  const pending = new Set<symbol>()
  let generation = 0
  const current = () => [...observers].at(-1)?.options
  const publish = () => observers.forEach(observer => observer.notify())
  const active = (owner: number) => owner === generation && observers.size > 0
  const guard = (owner: number, action: () => void) => {
    if (!active(owner)) return
    current()?.requestLeave(() => {
      if (!active(owner)) return
      const navigate = () => {
        if (active(owner)) action()
      }
      const options = current()
      if (options?.onNavigate) options.onNavigate(navigate)
      else navigate()
    })
  }
  const open = async (owner: number, address: RuntimeTaskAddress) => {
    const options = current()
    if (!options || !active(owner)) return
    const operation = Symbol('automation-runtime-open')
    pending.add(operation)
    publish()
    try {
      await options.openRuntimeTask(address)
      // Recheck the current draft guard after the external open completes.
      guard(owner, () => navigateTo(buildRuntimeTaskRoute(address)))
    } catch (cause) {
      if (active(owner)) current()?.onError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      if (pending.delete(operation)) publish()
    }
  }
  return {
    getSnapshot: () => pending.size,
    subscribe(notify: () => void, options: AutomationRunNavigationOptions) {
      const observer = { notify, options }
      observers.add(observer)
      return () => {
        observers.delete(observer)
        queueMicrotask(() => {
          // Replacing an inline guard transfers ownership within the same commit.
          if (observers.size) return
          generation += 1
          pending.clear()
        })
      }
    },
    open(run: AutomationRun) {
      if (!run.taskId || !run.deviceId) return
      const owner = generation
      const address: RuntimeTaskAddress = {
        taskId: run.taskId,
        deviceId: run.deviceId,
        runtime: 'codex',
        ...(run.workspacePath ? { workspacePath: run.workspacePath } : {}),
      }
      guard(owner, () => {
        void open(owner, address)
      })
    },
  }
}
