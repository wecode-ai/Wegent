declare global {
  interface Window {
    weworkElectronLifecycle?: {
      onSystemResume(listener: () => void): () => void
      onWindowFocusChanged?(listener: (focused: boolean) => void): () => void
      getWorkbenchActivity?(): Promise<unknown>
      onWorkbenchActivityChanged?(listener: (activity: unknown) => void): () => void
    }
  }
}

export function subscribeSystemResume(listener: () => void): () => void {
  return window.weworkElectronLifecycle?.onSystemResume(listener) ?? (() => undefined)
}
