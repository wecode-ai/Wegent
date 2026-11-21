import { subscribeDesktopHostEvents } from '@/api/dsh/desktopHost'
import { getComputerUseStatus, type ComputerUseStatus } from '@/desktop/computerUse'

/** Read once on subscription, then follow host state changes. */
export function createComputerUseStatusStore() {
  let status: Pick<ComputerUseStatus, 'currentTool'> | null = null
  let pending: object | null = null
  let revision = 0
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
      if (current === revision && listeners.size)
        console.error('[Wework] Failed to load computer use activity:', error)
    } finally {
      if (pending === request) pending = null
    }
  }
  return {
    getSnapshot: () => status,
    update(next: ComputerUseStatus) {
      if (!listeners.size) return
      revision++
      publish(next)
    },
    subscribe(listener: () => void) {
      listeners.add(listener)
      if (listeners.size === 1) {
        unsubscribe = subscribeDesktopHostEvents(event => {
          if (event.type !== 'computerUse.changed') return
          const { currentTool } = event.payload
          if (currentTool !== null && typeof currentTool !== 'string') return
          revision++
          publish({ currentTool })
        })
        initial = setTimeout(() => void load(), 0)
      }
      return () => {
        listeners.delete(listener)
        if (!listeners.size) {
          revision++
          pending = null
          clearTimeout(initial)
          unsubscribe?.()
          unsubscribe = undefined
        }
      }
    },
  }
}

export const computerUseStatusStore = createComputerUseStatusStore()
