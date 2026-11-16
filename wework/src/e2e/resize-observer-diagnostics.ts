interface DomWrite {
  tag: string
  testId: string | null
  attribute: string | null
}

interface MutationBatch {
  atMs: number
  writeCount: number
  writes: DomWrite[]
}

interface ResizeDelivery {
  observerId: number
  callbackName: string
  creationStack: string | undefined
  atMs: number
  targets: Array<{ tag: string; testId: string | null; width: number; height: number }>
  writeCount: number
  writes: DomWrite[]
}

interface ObservationChange {
  observerId: number
  creationStack: string | undefined
  action: 'observe' | 'unobserve' | 'disconnect'
  duringObserverId: number | null
  atMs: number
  succeeded: boolean
  target: { tag: string; testId: string | null } | null
}

function appendRecent<T>(entries: T[], entry: T) {
  entries.push(entry)
  if (entries.length > 32) entries.shift()
}

function mutationWrites(records: MutationRecord[]): DomWrite[] {
  return records.slice(0, 8).flatMap(record => {
    if (!(record.target instanceof Element)) return []
    return [
      {
        tag: record.target.tagName,
        testId: record.target.closest('[data-testid]')?.getAttribute('data-testid') ?? null,
        attribute: record.attributeName,
      },
    ]
  })
}

/** Observe native delivery without changing callback timing, layout or error handling. */
export function installResizeObserverDiagnostics(target: Window) {
  const scope = target as Window & Pick<typeof globalThis, 'ResizeObserver' | 'MutationObserver'>
  const NativeObserver = scope.ResizeObserver
  const recent: ResizeDelivery[] = []
  const betweenCallbacks: MutationBatch[] = []
  const observationChanges: ObservationChange[] = []
  let activeObserverId: number | null = null
  let nextId = 0
  let failed = false
  if (typeof NativeObserver !== 'function')
    return { snapshot: () => ({ recent, betweenCallbacks, observationChanges, failed }), stop() {} }
  const recordBetweenCallbacks = (records: MutationRecord[]) => {
    if (!records.length) return
    try {
      appendRecent(betweenCallbacks, {
        atMs: performance.now(),
        writeCount: records.length,
        writes: mutationWrites(records),
      })
    } catch {
      failed = true
    }
  }
  const writes = scope.document?.documentElement
    ? new scope.MutationObserver(recordBetweenCallbacks)
    : undefined
  writes?.observe(scope.document.documentElement, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: ['style', 'class'],
  })
  class ObservedResizeObserver extends NativeObserver {
    private readonly diagnosticId: number
    private readonly diagnosticStack: string | undefined

    constructor(callback: ResizeObserverCallback) {
      const observerId = ++nextId
      const creationStack = new Error('ResizeObserver created').stack
      super((entries, observer) => {
        let delivery: ResizeDelivery | undefined
        try {
          recordBetweenCallbacks(writes?.takeRecords() ?? [])
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
          appendRecent(recent, delivery)
        } catch {
          failed = true
        }
        const previousObserverId = activeObserverId
        activeObserverId = observerId
        try {
          callback.call(observer, entries, observer)
        } finally {
          activeObserverId = previousObserverId
          try {
            const mutations = writes?.takeRecords() ?? []
            if (delivery) {
              delivery.writeCount = mutations.length
              delivery.writes = mutationWrites(mutations)
            }
          } catch {
            failed = true
          }
        }
      })
      this.diagnosticId = observerId
      this.diagnosticStack = creationStack
    }

    private recordChange(
      action: ObservationChange['action'],
      target: Element | null,
      succeeded: boolean
    ) {
      try {
        appendRecent(observationChanges, {
          observerId: this.diagnosticId,
          creationStack: this.diagnosticStack,
          action,
          duringObserverId: activeObserverId,
          atMs: performance.now(),
          succeeded,
          target: target
            ? {
                tag: target.tagName,
                testId: target.closest('[data-testid]')?.getAttribute('data-testid') ?? null,
              }
            : null,
        })
      } catch {
        failed = true
      }
    }

    private invokeChange(
      action: ObservationChange['action'],
      target: Element | null,
      invoke: () => void
    ) {
      let succeeded = false
      try {
        invoke()
        succeeded = true
      } finally {
        this.recordChange(action, target, succeeded)
      }
    }

    override observe(target: Element, options?: ResizeObserverOptions) {
      this.invokeChange('observe', target, () => super.observe(target, options))
    }

    override unobserve(target: Element) {
      this.invokeChange('unobserve', target, () => super.unobserve(target))
    }

    override disconnect() {
      this.invokeChange('disconnect', null, () => super.disconnect())
    }
  }
  scope.ResizeObserver = ObservedResizeObserver
  return {
    snapshot: () => ({
      recent: [...recent],
      betweenCallbacks: [...betweenCallbacks],
      observationChanges: [...observationChanges],
      failed,
    }),
    stop: () => {
      writes?.disconnect()
      if (scope.ResizeObserver === ObservedResizeObserver) scope.ResizeObserver = NativeObserver
    },
  }
}
