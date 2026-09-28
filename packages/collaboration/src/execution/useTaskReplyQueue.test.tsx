// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, expect, it, vi } from 'vitest'
import type { ProjectChatMessage } from '@wegent/chat-core'
import { TaskReplyQueueStore } from './taskReplyQueue'
import { useTaskReplyQueue } from './useTaskReplyQueue'
import type { TaskCardDispatchResult } from './taskCardReply'

const cards = ['a', 'b'].map(id => ({ root: { messageId: id } as ProjectChatMessage, replies: [] }))

describe('shared card reply scheduling', () => {
  it('dispatches an idle card while another is busy, then drains the original card after settlement', async () => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    const store = new TaskReplyQueueStore()
    const dispatch = vi.fn().mockResolvedValue({ ok: true, persisted: true })
    let queue!: ReturnType<typeof useTaskReplyQueue>
    function Harness({ busyA }: { busyA: boolean }) {
      queue = useTaskReplyQueue({
        store,
        scope: 'issue',
        cards,
        enabled: true,
        busy: card => card.root.messageId === 'a' && busyA,
        dispatch,
        sendFailedText: 'Failed',
      })
      return null
    }
    const root = createRoot(document.createElement('div'))
    try {
      await act(async () => root.render(<Harness busyA />))
      await act(async () => {
        queue.enqueue('a', 'First', [])
        queue.enqueue('b', 'Second', [])
      })
      expect(dispatch).toHaveBeenCalledOnce()
      expect(dispatch.mock.calls[0][0].root.messageId).toBe('b')
      expect(queue.messages('a')).toHaveLength(1)
      await act(async () => root.render(<Harness busyA={false} />))
      expect(dispatch).toHaveBeenCalledTimes(2)
      expect(dispatch.mock.calls[1][0].root.messageId).toBe('a')
      expect(queue.messages('a')).toEqual([])
    } finally {
      act(() => root.unmount())
    }
  })
  it('keeps in-flight claims across remounts and removes a persisted failure without resending it', async () => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    const store = new TaskReplyQueueStore()
    let finish!: (result: TaskCardDispatchResult) => void
    const dispatch = vi.fn(
      () =>
        new Promise<TaskCardDispatchResult>(resolve => {
          finish = resolve
        })
    )
    let queue!: ReturnType<typeof useTaskReplyQueue>
    function Harness() {
      queue = useTaskReplyQueue({
        store,
        scope: 'issue',
        cards,
        enabled: true,
        busy: () => false,
        dispatch,
        sendFailedText: 'Failed',
      })
      return null
    }
    const root = createRoot(document.createElement('div'))
    try {
      await act(async () => root.render(<Harness />))
      await act(async () => {
        queue.enqueue('a', 'Once', [])
      })
      await act(async () => root.render(null))
      await act(async () => root.render(<Harness />))
      expect(dispatch).toHaveBeenCalledOnce()
      await act(async () => {
        finish({ ok: false, persisted: true, error: 'Device offline' })
      })
      expect(queue.messages('a')).toEqual([])
      expect(queue.error('a')).toBe('Device offline')
      expect(dispatch).toHaveBeenCalledOnce()
    } finally {
      act(() => root.unmount())
    }
  })
  it('retains a failed unpersisted entry instead of dropping it or automatically retrying', async () => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    const store = new TaskReplyQueueStore()
    const dispatch = vi
      .fn()
      .mockResolvedValue({ ok: false, persisted: false, error: 'Network failed' })
    let queue!: ReturnType<typeof useTaskReplyQueue>
    function Harness() {
      queue = useTaskReplyQueue({
        store,
        scope: 'issue',
        cards,
        enabled: true,
        busy: () => false,
        dispatch,
        sendFailedText: 'Failed',
      })
      return null
    }
    const root = createRoot(document.createElement('div'))
    try {
      await act(async () => root.render(<Harness />))
      await act(async () => {
        queue.enqueue('a', 'Keep this', [])
      })
      expect(queue.messages('a')[0]).toMatchObject({
        content: 'Keep this',
        status: 'failed',
        error: 'Network failed',
      })
      expect(dispatch).toHaveBeenCalledOnce()
    } finally {
      act(() => root.unmount())
    }
  })
})
