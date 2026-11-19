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
function pointer(element: Element, type: 'pointerover' | 'pointerout') {
  act(() =>
    element.dispatchEvent(new MouseEvent(type, { bubbles: true, relatedTarget: document.body }))
  )
}
function preview() {
  return document.querySelector('[data-testid="comment-preview"]')
}

test('keeps the hover preview open across the trigger gap and cancels pending close on unmount', () => {
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
  pointer(trigger, 'pointerover')
  expect(preview()).not.toBeNull()
  pointer(trigger, 'pointerout')
  act(() => vi.advanceTimersByTime(119))
  expect(preview()).not.toBeNull()
  pointer(preview()!, 'pointerover')
  act(() => vi.advanceTimersByTime(120))
  expect(preview()).not.toBeNull()
  pointer(preview()!, 'pointerout')
  act(() => vi.advanceTimersByTime(120))
  expect(preview()).toBeNull()
  pointer(trigger, 'pointerover')
  pointer(trigger, 'pointerout')
  expect(vi.getTimerCount()).toBe(1)
  act(() => root.render(null))
  expect(vi.getTimerCount()).toBe(0)
  expect(preview()).toBeNull()
})
