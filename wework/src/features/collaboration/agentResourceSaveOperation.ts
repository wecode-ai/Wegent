/** Saving and validation feedback belong to one mounted agent-editing scope. */
export function createAgentResourceSaveOperation() {
  let snapshot = { saving: false, error: null as string | null }
  let request: object | null = null
  const listeners = new Set<() => void>()
  const publish = () => listeners.forEach(listener => listener())
  return {
    getSnapshot: () => snapshot,
    subscribe(listener: () => void) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
        if (!listeners.size) {
          request = null
          snapshot = { ...snapshot, saving: false }
        }
      }
    },
    begin() {
      if (!listeners.size || request) return null
      const token = {}
      request = token
      snapshot = { saving: true, error: null }
      publish()
      return token
    },
    owns: (token: object) => request === token && listeners.size > 0,
    finish(token: object) {
      if (request !== token || !listeners.size) return
      request = null
      snapshot = { ...snapshot, saving: false }
      publish()
    },
    setError(error: string | null) {
      if (!listeners.size) return
      snapshot = { ...snapshot, error }
      publish()
    },
  }
}
