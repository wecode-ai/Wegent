interface ResizeDelivery {
  observerId: number
  callbackName: string
  creationStack: string | undefined
  atMs: number
  targets: Array<{ tag: string; testId: string | null; width: number; height: number }>
}

/** Observe native delivery without changing callback timing, layout or error handling. */
export function installResizeObserverDiagnostics(target: Window) {
  const scope = target as Window & Pick<typeof globalThis, 'ResizeObserver'>
  const NativeObserver = scope.ResizeObserver
  const recent: ResizeDelivery[] = []
  let nextId = 0
  let failed = false
  if (typeof NativeObserver !== 'function')
    return { snapshot: () => ({ recent, failed }), stop() {} }
  class ObservedResizeObserver extends NativeObserver {
    constructor(callback: ResizeObserverCallback) {
      const observerId = ++nextId
      const creationStack = new Error('ResizeObserver created').stack
      super((entries, observer) => {
        try {
          recent.push({
            observerId,
            callbackName: callback.name,
            creationStack,
            atMs: performance.now(),
            targets: entries.slice(0, 4).map(entry => ({
              tag: entry.target.tagName,
              testId: entry.target.closest('[data-testid]')?.getAttribute('data-testid') ?? null,
              width: entry.contentRect.width,
              height: entry.contentRect.height,
            })),
          })
          if (recent.length > 32) recent.shift()
        } catch {
          failed = true
        }
        callback.call(observer, entries, observer)
      })
    }
  }
  scope.ResizeObserver = ObservedResizeObserver
  return {
    snapshot: () => ({ recent: [...recent], failed }),
    stop: () => {
      if (scope.ResizeObserver === ObservedResizeObserver) scope.ResizeObserver = NativeObserver
    },
  }
}
