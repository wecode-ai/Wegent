interface ResizeDelivery {
  observerId: number
  callbackName: string
  creationStack: string | undefined
  atMs: number
  targets: Array<{ tag: string; testId: string | null; width: number; height: number }>
  writeCount: number
  writes: Array<{ tag: string; testId: string | null; attribute: string | null }>
}

/** Observe native delivery without changing callback timing, layout or error handling. */
export function installResizeObserverDiagnostics(target: Window) {
  const scope = target as Window & Pick<typeof globalThis, 'ResizeObserver' | 'MutationObserver'>
  const NativeObserver = scope.ResizeObserver
  const recent: ResizeDelivery[] = []
  let nextId = 0
  let failed = false
  if (typeof NativeObserver !== 'function')
    return { snapshot: () => ({ recent, failed }), stop() {} }
  const writes = scope.document?.documentElement
    ? new scope.MutationObserver(() => undefined)
    : undefined
  writes?.observe(scope.document.documentElement, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: ['style', 'class'],
  })
  class ObservedResizeObserver extends NativeObserver {
    constructor(callback: ResizeObserverCallback) {
      const observerId = ++nextId
      const creationStack = new Error('ResizeObserver created').stack
      super((entries, observer) => {
        let delivery: ResizeDelivery | undefined
        try {
          writes?.takeRecords()
          delivery = {
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
            writeCount: 0,
            writes: [],
          }
          recent.push(delivery)
          if (recent.length > 32) recent.shift()
        } catch {
          failed = true
        }
        try {
          callback.call(observer, entries, observer)
        } finally {
          try {
            const mutations = writes?.takeRecords() ?? []
            if (delivery) {
              delivery.writeCount = mutations.length
              delivery.writes = mutations.slice(0, 8).flatMap(record => {
                if (!(record.target instanceof Element)) return []
                return [
                  {
                    tag: record.target.tagName,
                    testId:
                      record.target.closest('[data-testid]')?.getAttribute('data-testid') ?? null,
                    attribute: record.attributeName,
                  },
                ]
              })
            }
          } catch {
            failed = true
          }
        }
      })
    }
  }
  scope.ResizeObserver = ObservedResizeObserver
  return {
    snapshot: () => ({ recent: [...recent], failed }),
    stop: () => {
      writes?.disconnect()
      if (scope.ResizeObserver === ObservedResizeObserver) scope.ResizeObserver = NativeObserver
    },
  }
}
