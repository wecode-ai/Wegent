import { act, renderHook, waitFor } from '@testing-library/react'
import { useMessageSendQueue } from '@/features/tasks/components/chat/useMessageSendQueue'
import { createMessageSendQueue } from '@/features/tasks/session/messageSendQueue'

interface Snapshot {
  message: string
}

function queued(message: string, taskId = 42) {
  return {
    taskId,
    localMessageId: `local-${message}`,
    displayMessage: message,
    snapshot: { message },
  }
}

describe('useMessageSendQueue', () => {
  let queue: ReturnType<typeof createMessageSendQueue<Snapshot>>

  beforeEach(() => {
    queue = createMessageSendQueue<Snapshot>()
  })

  it('dispatches queued messages in FIFO order when the task is unblocked', async () => {
    const dispatchMessage = jest.fn().mockResolvedValue(undefined)
    let isDispatchBlocked = true

    const { result, rerender } = renderHook(() =>
      useMessageSendQueue<Snapshot>({
        queue,
        taskId: 42,
        isDispatchBlocked,
        dispatchMessage,
      })
    )

    act(() => {
      result.current.enqueueMessage(queued('first'))
      result.current.enqueueMessage(queued('second'))
    })

    expect(dispatchMessage).not.toHaveBeenCalled()

    isDispatchBlocked = false
    rerender()

    await waitFor(() => {
      expect(dispatchMessage).toHaveBeenCalledTimes(2)
    })
    expect(dispatchMessage.mock.calls.map(call => call[0].snapshot.message)).toEqual([
      'first',
      'second',
    ])
    await waitFor(() => {
      expect(result.current.activeTaskQueue).toEqual([])
    })
  })

  it('pauses later queued messages when one dispatch fails', async () => {
    const dispatchMessage = jest
      .fn()
      .mockRejectedValueOnce(new Error('network down'))
      .mockResolvedValue(undefined)

    const { result } = renderHook(() =>
      useMessageSendQueue<Snapshot>({
        queue,
        taskId: 42,
        isDispatchBlocked: false,
        dispatchMessage,
      })
    )

    act(() => {
      result.current.enqueueMessage(queued('first'))
      result.current.enqueueMessage(queued('second'))
    })

    await waitFor(() => {
      expect(result.current.activeTaskQueue[0]?.status).toBe('failed')
    })

    expect(dispatchMessage).toHaveBeenCalledTimes(1)
    expect(result.current.activeTaskQueue.map(item => item.snapshot.message)).toEqual([
      'first',
      'second',
    ])
  })

  it('dispatches only one message per unblocked window in one-per-unblock mode', async () => {
    const dispatchMessage = jest.fn().mockResolvedValue(undefined)
    let isDispatchBlocked = true

    const { result, rerender } = renderHook(() =>
      useMessageSendQueue<Snapshot>({
        queue,
        taskId: 42,
        isDispatchBlocked,
        dispatchMessage,
        dispatchMode: 'one-per-unblock',
      })
    )

    act(() => {
      result.current.enqueueMessage(queued('first'))
      result.current.enqueueMessage(queued('second'))
    })

    isDispatchBlocked = false
    rerender()

    await waitFor(() => {
      expect(dispatchMessage).toHaveBeenCalledTimes(1)
    })
    expect(dispatchMessage.mock.calls[0][0].snapshot.message).toBe('first')
    await waitFor(() => {
      expect(result.current.activeTaskQueue.map(item => item.snapshot.message)).toEqual(['second'])
    })
    expect(dispatchMessage).toHaveBeenCalledTimes(1)

    isDispatchBlocked = true
    rerender()
    isDispatchBlocked = false
    rerender()

    await waitFor(() => {
      expect(dispatchMessage).toHaveBeenCalledTimes(2)
    })
    expect(dispatchMessage.mock.calls.map(call => call[0].snapshot.message)).toEqual([
      'first',
      'second',
    ])
  })

  it('retries a failed queued message before later queued messages continue', async () => {
    const dispatchMessage = jest
      .fn()
      .mockRejectedValueOnce(new Error('network down'))
      .mockResolvedValue(undefined)

    const { result } = renderHook(() =>
      useMessageSendQueue<Snapshot>({
        queue,
        taskId: 42,
        isDispatchBlocked: false,
        dispatchMessage,
      })
    )

    act(() => {
      result.current.enqueueMessage(queued('first'))
      result.current.enqueueMessage(queued('second'))
    })

    await waitFor(() => {
      expect(result.current.activeTaskQueue[0]).toMatchObject({
        status: 'failed',
        error: 'network down',
      })
    })
    expect(dispatchMessage).toHaveBeenCalledTimes(1)

    const failedId = result.current.activeTaskQueue[0].id
    act(() => {
      result.current.retryMessage(42, failedId)
    })

    await waitFor(() => {
      expect(dispatchMessage).toHaveBeenCalledTimes(3)
    })
    expect(dispatchMessage.mock.calls.map(call => call[0].snapshot.message)).toEqual([
      'first',
      'first',
      'second',
    ])
    await waitFor(() => {
      expect(result.current.activeTaskQueue).toEqual([])
    })
  })

  it('retries a rejected send in its original conversation after switching tasks', async () => {
    let rejectFirstSend!: (reason: Error) => void
    const dispatchMessage = jest
      .fn()
      .mockReturnValueOnce(
        new Promise<void>((_, reject) => {
          rejectFirstSend = reject
        })
      )
      .mockResolvedValue(undefined)
    const onDispatchError = jest.fn()
    const { result, rerender } = renderHook(
      ({ taskId }) =>
        useMessageSendQueue<Snapshot>({
          queue,
          taskId,
          isDispatchBlocked: false,
          dispatchMessage,
          onDispatchError,
        }),
      { initialProps: { taskId: 42 } }
    )

    act(() => result.current.enqueueMessage(queued('follow-up')))
    rerender({ taskId: 43 })
    await act(async () => rejectFirstSend(new Error('network down')))
    expect(queue.getMessages(42)[0]?.status).toBe('failed')
    const retry = onDispatchError.mock.calls[0][1]

    act(retry)
    expect(queue.getMessages(42)[0]?.status).toBe('queued')
    expect(dispatchMessage).toHaveBeenCalledTimes(1)
    expect(result.current.activeTaskQueue).toEqual([])

    rerender({ taskId: 42 })
    await waitFor(() => expect(dispatchMessage).toHaveBeenCalledTimes(2))
    expect(dispatchMessage.mock.calls[1][0]).toMatchObject({
      taskId: 42,
      displayMessage: 'follow-up',
    })
  })

  it('updates a queued message snapshot before it is dispatched', async () => {
    const dispatchMessage = jest.fn().mockResolvedValue(undefined)
    let isDispatchBlocked = true

    const { result, rerender } = renderHook(() =>
      useMessageSendQueue<Snapshot>({
        queue,
        taskId: 42,
        isDispatchBlocked,
        dispatchMessage,
      })
    )

    act(() => {
      result.current.enqueueMessage(queued('first'))
    })

    const queuedId = result.current.activeTaskQueue[0].id
    act(() => {
      result.current.updateQueuedMessage(queuedId, message => ({
        ...message,
        displayMessage: 'first\n\nsecond',
        snapshot: { message: 'first\n\nsecond' },
      }))
    })

    isDispatchBlocked = false
    rerender()

    await waitFor(() => {
      expect(dispatchMessage).toHaveBeenCalledTimes(1)
    })
    expect(dispatchMessage.mock.calls[0][0]).toMatchObject({
      displayMessage: 'first\n\nsecond',
      snapshot: { message: 'first\n\nsecond' },
    })
  })

  it('cancels a queued message before dispatch', async () => {
    const dispatchMessage = jest.fn().mockResolvedValue(undefined)
    let isDispatchBlocked = true

    const { result, rerender } = renderHook(() =>
      useMessageSendQueue<Snapshot>({
        queue,
        taskId: 42,
        isDispatchBlocked,
        dispatchMessage,
      })
    )

    act(() => {
      result.current.enqueueMessage(queued('first'))
    })

    const queuedId = result.current.activeTaskQueue[0].id
    act(() => {
      result.current.cancelMessage(queuedId)
    })

    expect(result.current.activeTaskQueue).toEqual([])

    isDispatchBlocked = false
    rerender()

    await Promise.resolve()
    expect(dispatchMessage).not.toHaveBeenCalled()
  })

  it('only dispatches messages for the active task', async () => {
    const dispatchMessage = jest.fn().mockResolvedValue(undefined)

    const { result } = renderHook(() =>
      useMessageSendQueue<Snapshot>({
        queue,
        taskId: 42,
        isDispatchBlocked: false,
        dispatchMessage,
      })
    )

    act(() => {
      result.current.enqueueMessage(queued('other-task', 100))
      result.current.enqueueMessage(queued('active-task', 42))
    })

    await waitFor(() => {
      expect(dispatchMessage).toHaveBeenCalledTimes(1)
    })
    expect(dispatchMessage.mock.calls[0][0].snapshot.message).toBe('active-task')
    await waitFor(() => {
      expect(queue.getMessages(100).map(item => item.snapshot.message)).toEqual(['other-task'])
    })
  })
})
