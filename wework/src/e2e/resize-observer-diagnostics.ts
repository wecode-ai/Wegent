interface ElementLocation {
  elementId: number
  domDepth: number
  tag: string
  testId: string | null
}

interface DomWrite extends ElementLocation {
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
  targets: Array<ElementLocation & { width: number; height: number }>
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
  target: ElementLocation | null
}

function appendRecent<T>(entries: T[], entry: T) {
  entries.push(entry)
  if (entries.length > 32) entries.shift()
}

function mutationWrites(
  records: MutationRecord[],
  describeElement: (element: Element) => ElementLocation
): DomWrite[] {
  return records.slice(0, 8).flatMap(record => {
    if (!(record.target instanceof Element)) return []
    return [
      {
        ...describeElement(record.target),
        attribute: record.attributeName,
      },
    ]
  })
}

/** Record native delivery without layout reads; error snapshots can inspect current boxes. */
export function installResizeObserverDiagnostics(target: Window) {
  const scope = target as Window & Pick<typeof globalThis, 'ResizeObserver' | 'MutationObserver'>
  const NativeObserver = scope.ResizeObserver
  const recent: ResizeDelivery[] = []
  const deliveryTargets = new WeakMap<ResizeDelivery, WeakRef<Element>[]>()
  const betweenCallbacks: MutationBatch[] = []
  const observationChanges: ObservationChange[] = []
  const elementIds = new WeakMap<Element, number>()
  let nextElementId = 0
  const describeElement = (element: Element): ElementLocation => {
    let elementId = elementIds.get(element)
    if (elementId === undefined) {
      elementId = ++nextElementId
      elementIds.set(element, elementId)
    }
    let domDepth = 0
    const parentElement = Object.getOwnPropertyDescriptor(Node.prototype, 'parentElement')?.get
    if (!parentElement) throw new Error('Native node ancestry is unavailable')
    for (let parent: Element | null = element; parent; parent = parentElement.call(parent))
      domDepth += 1
    return {
      elementId,
      domDepth,
      tag: element.tagName,
      testId: element.closest('[data-testid]')?.getAttribute('data-testid') ?? null,
    }
  }
  let activeObserverId: number | null = null
  let nextId = 0
  let failed = false
  if (typeof NativeObserver !== 'function')
    return {
      snapshot: () => ({
        capturedAtMs: performance.now(),
        recent,
        betweenCallbacks,
        observationChanges,
        failed,
      }),
      stop() {},
    }
  const recordBetweenCallbacks = (records: MutationRecord[]) => {
    if (!records.length) return
    try {
      appendRecent(betweenCallbacks, {
        atMs: performance.now(),
        writeCount: records.length,
        writes: mutationWrites(records, describeElement),
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
              ...describeElement(entry.target),
              width: entry.contentRect.width,
              height: entry.contentRect.height,
            })),
            writeCount: 0,
            writes: [],
          }
          deliveryTargets.set(
            delivery,
            entries.slice(0, 4).map(entry => new WeakRef(entry.target))
          )
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
              delivery.writes = mutationWrites(mutations, describeElement)
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
          target: target ? describeElement(target) : null,
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
    snapshot: ({ inspectCurrentGeometry = false } = {}) => ({
      ...(inspectCurrentGeometry
        ? {
            currentGeometry: recent.map(delivery => ({
              observerId: delivery.observerId,
              deliveredAtMs: delivery.atMs,
              targets: (deliveryTargets.get(delivery) ?? []).map((reference, index) => {
                const element = reference.deref()
                if (!element)
                  return { elementId: delivery.targets[index].elementId, collected: true }
                try {
                  const bounds = element.getBoundingClientRect()
                  return {
                    ...describeElement(element),
                    connected: element.isConnected,
                    borderRect: { width: bounds.width, height: bounds.height },
                  }
                } catch {
                  return { elementId: delivery.targets[index].elementId, geometryUnavailable: true }
                }
              }),
            })),
          }
        : {}),
      capturedAtMs: performance.now(),
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
