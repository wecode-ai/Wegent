// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { CodeCommentPreview } from './CodeCommentPreview'
import { CollaborationTheme } from '../theme'

let root: Root
let container: HTMLDivElement
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  vi.useFakeTimers()
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.useRealTimers()
})
function pointer(element: Element, type: 'pointerenter' | 'pointerleave', clientX = 0) {
  act(() =>
    element.dispatchEvent(
      new PointerEvent(type, { pointerType: 'mouse', clientX, relatedTarget: document.body })
    )
  )
}
function preview() {
  return document.querySelector('[data-testid="comment-preview"]')
}

test('keeps the hover preview open across the trigger gap and cancels pending close on unmount', async () => {
  act(() =>
    root.render(
      <CollaborationTheme mode="light">
        <CodeCommentPreview comments={[]} testId="comment-preview">
          <button data-testid="comment-trigger">Comment</button>
        </CodeCommentPreview>
      </CollaborationTheme>
    )
  )
  const trigger = container.querySelector('[data-testid="comment-trigger"]')!.parentElement!
  pointer(trigger, 'pointerenter')
  expect(preview()).not.toBeNull()
  pointer(trigger, 'pointerleave')
  act(() => vi.advanceTimersByTime(119))
  expect(preview()).not.toBeNull()
  pointer(preview()!, 'pointerenter')
  act(() => vi.advanceTimersByTime(120))
  expect(preview()).not.toBeNull()
  pointer(preview()!, 'pointerleave', 200)
  act(() => vi.advanceTimersByTime(120))
  expect(preview()).toBeNull()
  pointer(trigger, 'pointerenter')
  const schedule = vi.spyOn(globalThis, 'setTimeout')
  const cancel = vi.spyOn(globalThis, 'clearTimeout')
  try {
    pointer(trigger, 'pointerleave', 200)
    const index = schedule.mock.calls.findIndex(([, timeout]) => timeout === 120)
    expect(index).toBeGreaterThanOrEqual(0)
    const timer = schedule.mock.results[index]?.value
    await act(async () => root.render(null))
    expect(cancel.mock.calls.some(([cancelled]) => cancelled === timer)).toBe(true)
    expect(preview()).toBeNull()
  } finally {
    schedule.mockRestore()
    cancel.mockRestore()
  }
})
