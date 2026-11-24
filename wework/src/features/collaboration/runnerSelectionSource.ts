import type { RunnerSelection } from '@wegent/collaboration'
import { registerRunnerSelectionHandler, type RunnerSelectionRequest } from '@/lib/runner-selection'

export interface PendingRunnerSelection {
  id: number
  request: RunnerSelectionRequest
  resolve(selection: RunnerSelection): void
  reject(error: Error): void
}

/** The native selection handler publishes its actual unresolved dialog queue. */
export function createRunnerSelectionSource() {
  let queue: PendingRunnerSelection[] = []
  let sequence = 0
  let unregister: (() => void) | undefined
  const listeners = new Set<() => void>()
  const publish = () => listeners.forEach(listener => listener())
  return {
    getSnapshot: () => queue,
    close(pending: PendingRunnerSelection) {
      queue = queue.filter(item => item !== pending)
      publish()
    },
    subscribe(listener: () => void) {
      listeners.add(listener)
      if (!unregister)
        unregister = registerRunnerSelectionHandler(
          request =>
            new Promise<RunnerSelection>((resolve, reject) => {
              if (!listeners.size) {
                reject(new Error('Runner selection dialog closed'))
                return
              }
              queue = [...queue, { request, resolve, reject, id: ++sequence }]
              publish()
            })
        )
      return () => {
        listeners.delete(listener)
        if (listeners.size) return
        unregister?.()
        unregister = undefined
        const pending = queue
        queue = []
        for (const item of pending) item.reject(new Error('Runner selection dialog closed'))
      }
    },
  }
}
