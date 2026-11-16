export function serializeTaskKeys(keys: ReadonlySet<string>): string {
  return JSON.stringify([...keys].slice(-200))
}

export function readStoredTaskKeys(storageKey: string): Set<string> {
  if (typeof window === 'undefined') return new Set()
  try {
    const value = JSON.parse(window.localStorage.getItem(storageKey) ?? '[]')
    return new Set(Array.isArray(value) ? value.filter(item => typeof item === 'string') : [])
  } catch {
    return new Set()
  }
}
