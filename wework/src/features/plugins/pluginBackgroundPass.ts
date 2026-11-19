import { scheduleIdleTask } from '@/features/idle-tasks/idleTaskScheduler'

/** Coalesce each account job independently, including triggers during a request. */
export function createPluginBackgroundPass(options: {
  id: string
  isCurrent: () => boolean
  run: () => Promise<boolean>
  onError: (error: unknown) => void
  detached: boolean
}) {
  let running = false
  let pending = false
  let cancel: (() => void) | undefined
  const drain = async () => {
    if (running || !options.isCurrent()) return
    running = true
    try {
      while (pending && options.isCurrent()) {
        pending = false
        try {
          const retry = await options.run()
          pending = pending || retry
        } catch (error) {
          if (options.isCurrent()) options.onError(error)
        }
      }
    } finally {
      running = false
    }
  }
  return {
    request() {
      if (!options.isCurrent()) return
      pending = true
      cancel?.()
      cancel = scheduleIdleTask(options.id, async () => {
        cancel = undefined
        const work = drain()
        // HTTP-mode jobs must not occupy the shared serial idle scheduler.
        // Legacy device work retains its existing awaited scheduling contract.
        if (options.detached) void work
        else await work
      })
    },
    dispose() {
      pending = false
      cancel?.()
    },
  }
}
