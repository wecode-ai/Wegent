import { getComputerUseStatus, type ComputerUseStatus } from '@/desktop/computerUse'

/** Poll the host at a fixed cadence while sharing one in-flight status read. */
export function createComputerUseStatusStore() {
  let status: ComputerUseStatus | null = null
  let pending: object | null = null
  let revision = 0
  const listeners = new Set<() => void>()
  let initial: ReturnType<typeof setTimeout> | undefined
  let timer: ReturnType<typeof setInterval> | undefined
  const publish = (next: ComputerUseStatus) => {
    status = next
    listeners.forEach(listener => listener())
  }
  const load = async () => {
    if (pending || !listeners.size) return
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
        initial = setTimeout(() => void load(), 0)
        timer = setInterval(() => void load(), 1000)
      }
      return () => {
        listeners.delete(listener)
        if (!listeners.size) {
          revision++
          pending = null
          clearTimeout(initial)
          clearInterval(timer)
        }
      }
    },
  }
}
