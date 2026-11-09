import { act, renderHook } from '@testing-library/react'
import { createElement, StrictMode } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { useFocusedComment } from './useFocusedComment'

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
  document.body.replaceChildren()
})

function setup(commentId: string | null = 'comment-1', ready = true) {
  vi.useFakeTimers()
  const viewport = document.createElement('div')
  viewport.style.overflowY = 'auto'
  const geometry = { offset: 700, height: 100, viewportHeight: 400 }
  viewport.getBoundingClientRect = () => new DOMRect(0, 100, 600, geometry.viewportHeight)
  const list = document.createElement('div')
  viewport.append(list)
  document.body.append(viewport)
  const appendComment = (id: string) => {
    const comment = document.createElement('div')
    comment.dataset.messageId = id
    comment.getBoundingClientRect = () =>
      new DOMRect(0, 100 + geometry.offset - viewport.scrollTop, 600, geometry.height)
    comment.scrollIntoView = vi.fn((options: ScrollIntoViewOptions) => {
      viewport.scrollTop =
        geometry.offset -
        (options.block === 'start' ? 0 : (geometry.viewportHeight - geometry.height) / 2)
    })
    list.append(comment)
    return comment
  }
  const comment = appendComment('comment-1')
  const listRef = { current: list }
  const hook = renderHook(
    (props: {
      commentId: string | null
      requestKey: string | null
      messages: unknown[]
      ready?: boolean
    }) =>
      useFocusedComment(listRef, props.messages, props.commentId, props.requestKey, props.ready),
    {
      initialProps: { commentId, requestKey: null, messages: [], ready },
      wrapper: ({ children }) => createElement(StrictMode, null, children),
    }
  )
  return { ...hook, list, comment, viewport, geometry, appendComment }
}

async function nextFrame() {
  await act(async () => vi.advanceTimersByTimeAsync(20))
}

it('restarts a same-comment highlight before the previous animation has finished', async () => {
  const { result, rerender, comment } = setup()
  await nextFrame()
  expect(result.current).toBe('comment-1')
  await act(async () => vi.advanceTimersByTimeAsync(1800))

  rerender({ commentId: 'comment-1', requestKey: 'another-click', messages: [] })
  expect(result.current).toBeNull()
  await nextFrame()
  expect(result.current).toBe('comment-1')
  expect(comment.scrollIntoView).toHaveBeenCalledTimes(2)
  await act(async () => vi.advanceTimersByTimeAsync(200))
  expect(result.current).toBe('comment-1')
  await act(async () => vi.advanceTimersByTimeAsync(1800))
  expect(result.current).toBeNull()
})

it('does not rehighlight on background message updates after the flash expires', async () => {
  const { result, rerender, comment, list } = setup()
  await nextFrame()
  await act(async () => vi.advanceTimersByTimeAsync(2000))

  rerender({ commentId: 'comment-1', requestKey: null, messages: ['new-message'] })
  list.append(document.createElement('div'))
  await nextFrame()
  expect(result.current).toBeNull()
  expect(comment.scrollIntoView).toHaveBeenCalledOnce()
})

it('waits for the target comment and cancels a pending flash on unmount', async () => {
  const { result, rerender, appendComment, comment, unmount } = setup('comment-2')
  await nextFrame()
  expect(result.current).toBeNull()
  appendComment('comment-2')
  rerender({ commentId: 'comment-2', requestKey: null, messages: ['comment-2'] })
  await nextFrame()
  expect(result.current).toBe('comment-2')
  expect(comment.scrollIntoView).not.toHaveBeenCalled()

  rerender({ commentId: 'comment-2', requestKey: 'pending-click', messages: [] })
  unmount()
  expect(vi.getTimerCount()).toBe(0)
})

it('positions the comment after the parent resets its detail scroller', async () => {
  const { result, viewport, comment } = setup()
  viewport.scrollTop = 0
  await nextFrame()
  const bounds = comment.getBoundingClientRect()
  expect(result.current).toBe('comment-1')
  expect(bounds.top).toBeGreaterThanOrEqual(100)
  expect(bounds.bottom).toBeLessThanOrEqual(500)
})

it('waits for asynchronous history inserted above the target before positioning', async () => {
  const { result, rerender, geometry, comment } = setup('comment-1', false)
  await nextFrame()
  expect(comment.scrollIntoView).not.toHaveBeenCalled()
  expect(result.current).toBeNull()
  geometry.offset += 600
  rerender({ commentId: 'comment-1', requestKey: null, messages: [], ready: true })
  await nextFrame()
  expect(result.current).toBe('comment-1')
  expect(comment.getBoundingClientRect().bottom).toBeLessThanOrEqual(500)
})

it('does not claim success when scrolling has not brought the comment into view', async () => {
  const { result, comment, viewport } = setup()
  comment.scrollIntoView = vi.fn()
  Object.defineProperty(viewport, 'scrollTop', { get: () => 0, set: () => {} })
  await nextFrame()
  expect(result.current).toBeNull()
})

it('lets the reader cancel automatic positioning while history is still loading', async () => {
  const { result, rerender, viewport, comment } = setup('comment-1', false)
  viewport.dispatchEvent(new WheelEvent('wheel'))
  rerender({ commentId: 'comment-1', requestKey: null, messages: [], ready: true })
  await nextFrame()
  expect(comment.scrollIntoView).not.toHaveBeenCalled()
  expect(result.current).toBeNull()
})

it('keeps the beginning of an oversized comment visible', async () => {
  const { result, geometry, comment } = setup()
  geometry.height = 800
  await nextFrame()
  expect(result.current).toBe('comment-1')
  expect(comment.getBoundingClientRect().top).toBe(100)
  expect(comment.scrollIntoView).toHaveBeenCalledWith({ behavior: 'instant', block: 'start' })
})

function observeResizes() {
  const observers: { callback: ResizeObserverCallback; targets: Set<Element> }[] = []
  vi.stubGlobal(
    'ResizeObserver',
    class {
      targets = new Set<Element>()
      constructor(callback: ResizeObserverCallback) {
        observers.push({ callback, targets: this.targets })
      }
      observe(target: Element) {
        this.targets.add(target)
      }
      disconnect() {
        this.targets.clear()
      }
    }
  )
  return async (target: Element) => {
    await act(async () => {
      for (const observer of observers) {
        if (observer.targets.has(target)) observer.callback([], {} as ResizeObserver)
      }
    })
    await nextFrame()
  }
}

it('keeps the focused comment readable when the reading viewport becomes shorter', async () => {
  const resize = observeResizes()
  const { viewport, geometry, comment, result } = setup()
  await nextFrame()
  await act(async () => vi.advanceTimersByTimeAsync(2000))
  geometry.viewportHeight = 140
  geometry.offset += 200
  await resize(viewport)
  expect(comment.getBoundingClientRect().top).toBeGreaterThanOrEqual(100)
  expect(comment.getBoundingClientRect().bottom).toBeLessThanOrEqual(240)
  expect(result.current).toBeNull()
})

it('retains resize positioning through background message updates without following them', async () => {
  const resize = observeResizes()
  const { viewport, geometry, comment, rerender } = setup()
  await nextFrame()
  rerender({ commentId: 'comment-1', requestKey: null, messages: ['new-message'] })
  await nextFrame()
  expect(comment.scrollIntoView).toHaveBeenCalledOnce()
  geometry.viewportHeight = 140
  await resize(viewport)
  expect(comment.getBoundingClientRect().bottom).toBeLessThanOrEqual(240)
})

it('does not lose a viewport resize when new messages arrive in the same render', async () => {
  const { viewport, geometry, comment, rerender } = setup()
  await nextFrame()
  geometry.viewportHeight = 140
  rerender({ commentId: 'comment-1', requestKey: null, messages: ['new-message'] })
  await nextFrame()
  expect(comment.getBoundingClientRect().bottom).toBeLessThanOrEqual(240)
  expect(viewport.scrollTop).toBeGreaterThan(0)
})

it('lets manual reading cancel resize positioning until a new navigation', async () => {
  const resize = observeResizes()
  const { viewport, geometry, comment, rerender } = setup()
  await nextFrame()
  viewport.dispatchEvent(new WheelEvent('wheel'))
  geometry.viewportHeight = 140
  await resize(viewport)
  rerender({ commentId: 'comment-1', requestKey: null, messages: ['new-message'] })
  await resize(viewport)
  expect(comment.scrollIntoView).toHaveBeenCalledOnce()
  rerender({ commentId: 'comment-1', requestKey: 'new-navigation', messages: [] })
  await nextFrame()
  expect(comment.getBoundingClientRect().bottom).toBeLessThanOrEqual(240)
})

it('positions the comment above the sticky reply composer', async () => {
  const { viewport, comment } = setup()
  const composer = document.createElement('div')
  composer.className = 'task-detail-comment-bar'
  composer.getBoundingClientRect = () => new DOMRect(0, 220, 600, 280)
  viewport.append(composer)
  await nextFrame()
  expect(comment.getBoundingClientRect().top).toBeGreaterThanOrEqual(100)
  expect(comment.getBoundingClientRect().bottom).toBeLessThanOrEqual(220)
})

it('keeps context anchored while the user edits inside a late-mounted composer', async () => {
  const resize = observeResizes()
  const { viewport, comment } = setup()
  const composer = document.createElement('div')
  composer.className = 'task-detail-comment-bar'
  let composerTop = 380
  composer.getBoundingClientRect = () => new DOMRect(0, composerTop, 600, 500 - composerTop)
  const input = document.createElement('textarea')
  composer.append(input)
  viewport.append(composer)
  await nextFrame()
  input.dispatchEvent(new Event('pointerdown', { bubbles: true }))
  input.dispatchEvent(new Event('touchstart', { bubbles: true }))
  composerTop = 220
  await resize(composer)
  expect(comment.getBoundingClientRect().bottom).toBeLessThanOrEqual(220)
})
