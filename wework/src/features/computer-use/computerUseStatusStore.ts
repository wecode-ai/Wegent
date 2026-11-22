import { subscribeDesktopHostEvents } from '@/api/dsh/desktopHost'
import { getComputerUseStatus, type ComputerUseStatus } from '@/desktop/computerUse'

/** Read once on subscription, then follow host state changes. */
export function createComputerUseStatusStore() {
  let status: Pick<ComputerUseStatus, 'currentTool'> | null = null
  let pending: object | null = null
  let revision = 0
  let pendingUpdates = 0
  const listeners = new Set<() => void>()
  let initial: ReturnType<typeof setTimeout> | undefined
  let unsubscribe: (() => void) | undefined
  const publish = (next: Pick<ComputerUseStatus, 'currentTool'>) => {
    status = next
    listeners.forEach(listener => listener())
  }
  const load = async () => {
    if (!listeners.size || pending) return
    const request = {}
    pending = request
    const current = ++revision
    try {
      const next = await getComputerUseStatus()
      if (current === revision && listeners.size) publish(next)
    } catch (error) {
      if (current === revision && listeners.size) {
        console.error('[Wework] Failed to load computer use activity:', error)
        initial = setTimeout(() => void load(), 1_000)
      }
    } finally {
      if (pending === request) pending = null
    }
  }
  const observeHost = () => {
    unsubscribe ??= subscribeDesktopHostEvents(event => {
      if (event.type !== 'computerUse.changed') return
      const { currentTool } = event.payload
      if (currentTool !== null && typeof currentTool !== 'string') return
      clearTimeout(initial)
      revision++
      publish({ currentTool })
    })
  }
  const releaseHost = () => {
    if (listeners.size || pendingUpdates) return
    unsubscribe?.()
    unsubscribe = undefined
  }
  return {
    getSnapshot: () => status,
    async updateFrom(operation: () => Promise<ComputerUseStatus>) {
      pendingUpdates++
      observeHost()
      const current = revision
      try {
        const next = await operation()
        if (revision === current) {
          revision++
          publish(next)
        }
      } finally {
        pendingUpdates--
        releaseHost()
      }
    },
    subscribe(listener: () => void) {
      listeners.add(listener)
      if (listeners.size === 1) {
        observeHost()
        initial = setTimeout(() => void load(), 0)
      }
      return () => {
        listeners.delete(listener)
        if (!listeners.size) {
          revision++
          pending = null
          clearTimeout(initial)
          releaseHost()
        }
      }
    },
  }
}

export const computerUseStatusStore = createComputerUseStatusStore()
