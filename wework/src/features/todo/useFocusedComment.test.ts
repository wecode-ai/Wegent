import { act, renderHook } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { useFocusedComment } from './useFocusedComment'

afterEach(() => vi.useRealTimers())

function setup(commentId: string | null = 'comment-1') {
  vi.useFakeTimers()
  const list = document.createElement('div')
  const comment = document.createElement('div')
  comment.dataset.messageId = 'comment-1'
  comment.scrollIntoView = vi.fn()
  list.append(comment)
  const listRef = { current: list }
  const hook = renderHook(
    (props: { commentId: string | null; requestKey: string | null; messages: unknown[] }) =>
      useFocusedComment(listRef, props.messages, props.commentId, props.requestKey),
    { initialProps: { commentId, requestKey: null, messages: [] } }
  )
  return { ...hook, list, comment }
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
  const { result, rerender, comment } = setup()
  await nextFrame()
  await act(async () => vi.advanceTimersByTimeAsync(2000))

  rerender({ commentId: 'comment-1', requestKey: null, messages: ['new-message'] })
  await nextFrame()
  expect(result.current).toBeNull()
  expect(comment.scrollIntoView).toHaveBeenCalledOnce()
})

it('allows focusing the same comment again after leaving it', async () => {
  const { result, rerender } = setup()
  await nextFrame()
  rerender({ commentId: null, requestKey: null, messages: [] })
  expect(result.current).toBeNull()
  rerender({ commentId: 'comment-1', requestKey: null, messages: [] })
  await nextFrame()
  expect(result.current).toBe('comment-1')
})

it('waits for the target comment and cancels a pending flash on unmount', async () => {
  const { result, rerender, list, comment, unmount } = setup('comment-2')
  await nextFrame()
  expect(result.current).toBeNull()
  const target = document.createElement('div')
  target.dataset.messageId = 'comment-2'
  target.scrollIntoView = vi.fn()
  list.append(target)
  rerender({ commentId: 'comment-2', requestKey: null, messages: ['comment-2'] })
  await nextFrame()
  expect(result.current).toBe('comment-2')
  expect(comment.scrollIntoView).not.toHaveBeenCalled()

  rerender({ commentId: 'comment-2', requestKey: 'pending-click', messages: [] })
  unmount()
  expect(vi.getTimerCount()).toBe(0)
})
