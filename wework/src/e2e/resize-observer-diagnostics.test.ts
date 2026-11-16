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
    { tag: 'DIV', testId: 'conversation-viewport', width: 300, height: 200 },
  ])
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
