import type { UnlistenFn } from '@tauri-apps/api/event'

export function disposeTauriListener(unlisten: UnlistenFn, context: string): void {
  void Promise.resolve()
    .then(unlisten)
    .catch(error => {
      console.debug(`[Wework] ${context} listener was already unavailable during cleanup`, error)
    })
}
