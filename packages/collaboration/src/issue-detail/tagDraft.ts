export interface TagDraftStore {
  getSnapshot(): string
  getDirtySnapshot(): boolean
  set(value: string): void
  subscribe(listener: () => void): () => void
  subscribeEditor(listener: () => void): () => void
}

/** Editors own raw text; containing forms observe its derived dirty state directly. */
export function createTagDraft(): TagDraftStore {
  let value = ''
  const listeners = new Set<() => void>()
  const editors = new Set<object>()
  const set = (next: string) => {
    if (next === value) return
    value = next
    listeners.forEach(listener => listener())
  }
  const subscribe = (listener: () => void) => {
    listeners.add(listener)
    return () => {
      listeners.delete(listener)
    }
  }
  return {
    getSnapshot: () => value,
    getDirtySnapshot: () => Boolean(value.trim()),
    set,
    subscribe,
    subscribeEditor(listener) {
      const owner = {}
      editors.add(owner)
      const stop = subscribe(listener)
      return () => {
        if (!editors.delete(owner)) return
        stop()
        queueMicrotask(() => {
          if (!editors.size) set('')
        })
      }
    },
  }
}
