declare global {
  interface Window {
    weworkElectronLifecycle?: {
      onSystemResume(listener: () => void): () => void
    }
  }
}

export function subscribeSystemResume(listener: () => void): () => void {
  return window.weworkElectronLifecycle?.onSystemResume(listener) ?? (() => undefined)
}
