let crashed = false
const listeners = new Set<() => void>()

export const rendererCrashStore = {
  subscribe(listener: () => void) {
    listeners.add(listener)
    return () => {
      listeners.delete(listener)
    }
  },
  getSnapshot: () => crashed,
  trigger() {
    crashed = true
    listeners.forEach(listener => listener())
  },
}
