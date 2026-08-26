export type UnlistenFn = () => void

export function disposeDesktopListener(unlisten: UnlistenFn, context: string): void {
  void Promise.resolve()
    .then(unlisten)
    .catch(error => {
      console.debug(`[Wework] ${context} listener was already unavailable during cleanup`, error)
    })
}
