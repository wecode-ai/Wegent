import { afterEach, expect, test, vi } from 'vitest'
import { createElectronEmbeddedBrowserViewPort } from './electronEmbeddedBrowserViewPort'

afterEach(() => {
  document.body.replaceChildren()
  vi.restoreAllMocks()
})

test('retains native ownership while coalescing metadata binds and cancels released work', async () => {
  const frames = new Map<number, FrameRequestCallback>()
  let sequence = 0
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation(callback => {
    frames.set(++sequence, callback)
    return sequence
  })
  vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(id => {
    frames.delete(id)
  })
  const placeholder = document.createElement('div')
  document.body.append(placeholder)
  let left = 20
  const measure = vi
    .spyOn(placeholder, 'getBoundingClientRect')
    .mockImplementation(() => new DOMRect(left, 30, 200, 100))
  const port = createElectronEmbeddedBrowserViewPort()
  const metadata = { active: true, interactionBlocked: false, label: 'geometry-contract' }
  let release = port.bind(placeholder, metadata)
  const ownership = port.getOwnership()
  const native = document.querySelector<HTMLElement>(
    '[data-testid="workspace-browser-electron-webview"]'
  )!
  expect(native.style.left).toBe('20px')
  measure.mockClear()
  left = 80
  for (let index = 0; index < 3; index += 1) {
    release()
    // Cursor refs can bind between metadata ref cleanup and its same-commit replacement.
    expect(port.getOwnership()).toBe(ownership)
    release = port.bind(placeholder, { ...metadata, interactionBlocked: index === 2 })
  }
  await Promise.resolve()
  expect(port.getOwnership()).toBe(ownership)
  expect(native.style.pointerEvents).toBe('none')
  expect(measure).not.toHaveBeenCalled()
  expect(frames.size).toBe(1)
  const pending = [...frames.values()]
  frames.clear()
  pending.forEach(callback => callback(0))
  expect(native.style.left).toBe('80px')
  expect(measure).toHaveBeenCalledOnce()
  release()
  release = port.bind(placeholder, metadata)
  release()
  await Promise.resolve()
  await Promise.resolve()
  expect(frames.size).toBe(0)
  expect(port.getOwnership()).toBeNull()
  expect(native.isConnected).toBe(false)
})
