export {}

declare global {
  interface Window {
    weworkElectron: {
      getRuntimeState(): Promise<Record<string, unknown>>
      onRuntimeChanged(listener: () => void): () => void
      reloadDsh(): Promise<void>
    }
  }
}
