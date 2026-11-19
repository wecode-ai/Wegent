import { expect, test, vi } from 'vitest'
import { installResizeObserverDiagnostics } from './resize-observer-diagnostics'

test('preserves native callback timing, identity and exceptions while recording only geometry', () => {
  const callbacks: ResizeObserverCallback[] = []
  class NativeObserver {
    constructor(callback: ResizeObserverCallback) {
      callbacks.push(callback)
    }
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  const scope = { ResizeObserver: NativeObserver } as unknown as Window & typeof globalThis
  const diagnostics = installResizeObserverDiagnostics(scope)
  const target = document.createElement('div')
  target.dataset.testid = 'conversation-viewport'
  target.textContent = 'private text must not appear'
  const entry = { target, contentRect: { width: 300, height: 200 } } as ResizeObserverEntry
  const callback = vi.fn<ResizeObserverCallback>()
  const observer = new scope.ResizeObserver(callback)
  callbacks[0]([entry], observer)
  expect(observer).toBeInstanceOf(NativeObserver)
  expect(callback).toHaveBeenCalledExactlyOnceWith([entry], observer)
  expect(callback.mock.contexts[0]).toBe(observer)
  expect(diagnostics.snapshot().recent[0].targets).toEqual([
    {
      elementId: 1,
      domDepth: 1,
      tag: 'DIV',
      testId: 'conversation-viewport',
      width: 300,
      height: 200,
    },
  ])
  const geometry = vi.spyOn(target, 'getBoundingClientRect').mockReturnValue({
    width: 0,
    height: 0,
  } as DOMRect)
  expect(diagnostics.snapshot()).not.toHaveProperty('currentGeometry')
  expect(geometry).not.toHaveBeenCalled()
  expect(diagnostics.snapshot({ inspectCurrentGeometry: true }).currentGeometry?.[0]).toMatchObject(
    {
      observerId: 1,
      targets: [{ elementId: 1, connected: false, borderRect: { width: 0, height: 0 } }],
    }
  )
  expect(JSON.stringify(diagnostics.snapshot())).not.toContain('private text')
  const failure = new Error('Original callback failed')
  const throwing = new scope.ResizeObserver(() => {
    throw failure
  })
  expect(() => callbacks[1]([entry], throwing)).toThrow(failure)
  for (let i = 0; i < 40; i++) callbacks[0]([entry], observer)
  expect(diagnostics.snapshot().recent).toHaveLength(32)
  diagnostics.stop()
  expect(scope.ResizeObserver).toBe(NativeObserver)
})

test('a diagnostic read failure cannot prevent native callback delivery', () => {
  let deliver!: ResizeObserverCallback
  class NativeObserver {
    constructor(callback: ResizeObserverCallback) {
      deliver = callback
    }
  }
  const scope = { ResizeObserver: NativeObserver } as unknown as Window & typeof globalThis
  const diagnostics = installResizeObserverDiagnostics(scope)
  const callback = vi.fn()
  const observer = new scope.ResizeObserver(callback)
  deliver([{} as ResizeObserverEntry], observer)
  expect(callback).toHaveBeenCalledOnce()
  expect(diagnostics.snapshot().failed).toBe(true)
  diagnostics.stop()
})

test('attributes synchronous DOM writes to their callback without reading layout or text', () => {
  let deliver!: ResizeObserverCallback
  class NativeObserver {
    constructor(callback: ResizeObserverCallback) {
      deliver = callback
    }
  }
  const scope = {
    ResizeObserver: NativeObserver,
    MutationObserver,
    document,
  } as unknown as Window & typeof globalThis
  const diagnostics = installResizeObserverDiagnostics(scope)
  const parent = document.createElement('div')
  parent.dataset.testid = 'measured-ancestor'
  document.body.append(parent)
  const observer = new scope.ResizeObserver(() => {
    parent.style.height = '42px'
    parent.textContent = 'private content'
  })
  deliver(
    [{ target: parent, contentRect: { width: 100, height: 20 } } as ResizeObserverEntry],
    observer
  )
  expect(diagnostics.snapshot().recent[0]).toMatchObject({
    writeCount: 2,
    writes: [
      { tag: 'DIV', testId: 'measured-ancestor', attribute: 'style' },
      { tag: 'DIV', testId: 'measured-ancestor', attribute: null },
    ],
  })
  expect(JSON.stringify(diagnostics.snapshot())).not.toContain('private content')
  diagnostics.stop()
  parent.remove()
})

test('retains deferred DOM commits between native deliveries without attributing their cause', async () => {
  let deliver!: ResizeObserverCallback
  class NativeObserver {
    constructor(callback: ResizeObserverCallback) {
      deliver = callback
    }
  }
  const scope = {
    ResizeObserver: NativeObserver,
    MutationObserver,
    document,
  } as unknown as Window & typeof globalThis
  const diagnostics = installResizeObserverDiagnostics(scope)
  const target = document.createElement('div')
  target.dataset.testid = 'deferred-layout'
  document.body.append(target)
  const observer = new scope.ResizeObserver(() => {
    queueMicrotask(() => {
      target.style.height = '43px'
    })
  })
  deliver([{ target, contentRect: { width: 100, height: 20 } } as ResizeObserverEntry], observer)
  expect(diagnostics.snapshot().recent[0].writeCount).toBe(0)
  await new Promise<void>(resolve => queueMicrotask(resolve))
  expect(diagnostics.snapshot().betweenCallbacks.flatMap(batch => batch.writes)).toContainEqual(
    expect.objectContaining({ tag: 'DIV', testId: 'deferred-layout', attribute: 'style' })
  )
  expect(JSON.stringify(diagnostics.snapshot())).not.toContain('43px')
  diagnostics.stop()
  target.remove()
})

test('records observation changes inside and outside delivery while forwarding native calls', () => {
  let deliver!: ResizeObserverCallback
  const calls: unknown[][] = []
  class NativeObserver {
    constructor(callback: ResizeObserverCallback) {
      deliver = callback
    }
    observe(...args: unknown[]) {
      calls.push(['observe', this, ...args])
    }
    unobserve(...args: unknown[]) {
      calls.push(['unobserve', this, ...args])
    }
    disconnect() {
      calls.push(['disconnect', this])
    }
  }
  const scope = { ResizeObserver: NativeObserver } as unknown as Window & typeof globalThis
  const diagnostics = installResizeObserverDiagnostics(scope)
  const target = document.createElement('div')
  target.dataset.testid = 'observed-content'
  target.textContent = 'private content'
  const options: ResizeObserverOptions = { box: 'border-box' }
  const observer = new scope.ResizeObserver(() => observer.observe(target, options))
  observer.observe(target, options)
  deliver([], observer)
  observer.unobserve(target)
  observer.disconnect()
  expect(calls).toEqual([
    ['observe', observer, target, options],
    ['observe', observer, target, options],
    ['unobserve', observer, target],
    ['disconnect', observer],
  ])
  expect(
    diagnostics.snapshot().observationChanges.map(({ action, duringObserverId, succeeded }) => ({
      action,
      duringObserverId,
      succeeded,
    }))
  ).toEqual([
    { action: 'observe', duringObserverId: null, succeeded: true },
    { action: 'observe', duringObserverId: 1, succeeded: true },
    { action: 'unobserve', duringObserverId: null, succeeded: true },
    { action: 'disconnect', duringObserverId: null, succeeded: true },
  ])
  for (let i = 0; i < 40; i++) observer.observe(target)
  expect(diagnostics.snapshot().observationChanges).toHaveLength(32)
  expect(JSON.stringify(diagnostics.snapshot())).not.toContain('private content')
  diagnostics.stop()
})

test('preserves a native observation failure even when diagnostic target reading fails', () => {
  const failure = new TypeError('Native observe failed')
  class NativeObserver {
    observe() {
      throw failure
    }
  }
  const scope = { ResizeObserver: NativeObserver } as unknown as Window & typeof globalThis
  const diagnostics = installResizeObserverDiagnostics(scope)
  const observer = new scope.ResizeObserver(() => {})
  expect(() => observer.observe(document.createElement('div'))).toThrow(failure)
  expect(diagnostics.snapshot().observationChanges[0].succeeded).toBe(false)
  expect(() => observer.observe({} as Element)).toThrow(failure)
  expect(diagnostics.snapshot().failed).toBe(true)
  diagnostics.stop()
})

test('distinguishes nodes sharing a test ID and correlates delivery, writes and registration', () => {
  let deliver!: ResizeObserverCallback
  class NativeObserver {
    constructor(callback: ResizeObserverCallback) {
      deliver = callback
    }
    observe() {}
    disconnect() {}
  }
  const scope = {
    ResizeObserver: NativeObserver,
    MutationObserver,
    document,
  } as unknown as Window & typeof globalThis
  const diagnostics = installResizeObserverDiagnostics(scope)
  const parent = document.createElement('section')
  parent.dataset.testid = 'shared-boundary'
  const first = document.createElement('span')
  const second = document.createElement('span')
  first.textContent = 'private content'
  parent.append(first, second)
  document.body.append(parent)
  const observer = new scope.ResizeObserver(() => {
    first.style.width = '43px'
  })
  try {
    observer.observe(first)
    observer.observe(second)
    observer.observe(parent)
    deliver(
      [first, second].map(
        target => ({ target, contentRect: { width: 100, height: 20 } }) as ResizeObserverEntry
      ),
      observer
    )
    const snapshot = diagnostics.snapshot()
    const delivery = snapshot.recent[0]
    const [firstTarget, secondTarget] = delivery.targets
    expect(firstTarget.testId).toBe(secondTarget.testId)
    expect(firstTarget.elementId).not.toBe(secondTarget.elementId)
    expect(firstTarget.domDepth).toBe(snapshot.observationChanges[2].target!.domDepth + 1)
    expect(delivery.writes[0].elementId).toBe(firstTarget.elementId)
    expect(snapshot.observationChanges[0].target?.elementId).toBe(firstTarget.elementId)
    expect(snapshot.capturedAtMs).toBeGreaterThanOrEqual(delivery.atMs)

    first.remove()
    Object.defineProperty(first, 'parentElement', { get: () => first })
    observer.observe(first)
    expect(diagnostics.snapshot().observationChanges.at(-1)?.target).toMatchObject({
      elementId: firstTarget.elementId,
      domDepth: 1,
    })
    expect(JSON.stringify(snapshot)).not.toMatch(/private content|43px/)
  } finally {
    diagnostics.stop()
    parent.remove()
  }
})
