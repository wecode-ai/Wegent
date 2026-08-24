export const WEWORK_SYSTEM_SESSION_LOCK_CHANGED_EVENT = 'wework-system-session-lock-changed'

export function isSystemSessionLocked(): boolean {
  return false
}

export function subscribeSystemSessionLock(callback: (locked: boolean) => void): () => void {
  void callback
  return () => undefined
}
