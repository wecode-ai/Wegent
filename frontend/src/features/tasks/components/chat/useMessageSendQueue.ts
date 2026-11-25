import { useCallback, useEffect, useRef, useSyncExternalStore } from 'react'
import type {
  EnqueueMessageInput,
  MessageSendQueue,
  QueuedMessage,
} from '../../session/messageSendQueue'

type QueueDispatchMode = 'drain' | 'one-per-unblock'

interface UseMessageSendQueueOptions<TSnapshot> {
  queue: MessageSendQueue<TSnapshot>
  taskId?: number | null
  isDispatchBlocked: boolean
  dispatchMessage: (message: QueuedMessage<TSnapshot>) => Promise<void>
  onDispatchError?: (error: Error, retry: () => void) => void
  dispatchMode?: QueueDispatchMode
}

export function useMessageSendQueue<TSnapshot>({
  queue,
  taskId,
  isDispatchBlocked,
  dispatchMessage,
  onDispatchError,
  dispatchMode = 'drain',
}: UseMessageSendQueueOptions<TSnapshot>) {
  const dispatchedTaskRef = useRef<number | null>(null)
  const dispatchMessageRef = useRef(dispatchMessage)
  const onDispatchErrorRef = useRef(onDispatchError)

  dispatchMessageRef.current = dispatchMessage
  onDispatchErrorRef.current = onDispatchError

  const getMessages = useCallback(() => queue.getMessages(taskId), [queue, taskId])
  const activeTaskQueue = useSyncExternalStore(queue.subscribe, getMessages, getMessages)

  const enqueueMessage = useCallback(
    (input: EnqueueMessageInput<TSnapshot>) => {
      const queuedMessage: QueuedMessage<TSnapshot> = {
        ...input,
        id: `${input.taskId}:${input.localMessageId}`,
        createdAt: Date.now(),
        status: 'queued',
      }
      queue.enqueue(queuedMessage)
    },
    [queue]
  )

  const retryMessage = useCallback(
    (messageTaskId: number, id: string) => {
      if (dispatchedTaskRef.current === messageTaskId) dispatchedTaskRef.current = null
      queue.update(messageTaskId, id, message =>
        message.status === 'failed' ? { ...message, status: 'queued', error: undefined } : message
      )
    },
    [queue]
  )

  const cancelMessage = useCallback(
    (id: string) => {
      if (!taskId) return
      queue.update(taskId, id, message => (message.status === 'sending' ? message : undefined))
    },
    [queue, taskId]
  )

  const updateQueuedMessage = useCallback(
    (id: string, updater: (message: QueuedMessage<TSnapshot>) => QueuedMessage<TSnapshot>) => {
      if (!taskId) return
      queue.update(taskId, id, message =>
        message.status === 'queued' ? updater(message) : message
      )
    },
    [queue, taskId]
  )

  useEffect(() => {
    if (isDispatchBlocked || dispatchedTaskRef.current !== taskId) {
      dispatchedTaskRef.current = null
    }
    if (!taskId || isDispatchBlocked) return
    if (dispatchMode === 'one-per-unblock' && dispatchedTaskRef.current === taskId) return

    // Another view may have started sending since this render took its snapshot.
    const nextMessage = queue.peek(taskId)
    if (nextMessage?.status !== 'queued') return

    if (dispatchMode === 'one-per-unblock') dispatchedTaskRef.current = taskId
    queue.update(taskId, nextMessage.id, message => ({ ...message, status: 'sending' }))

    dispatchMessageRef
      .current(nextMessage)
      .then(() => {
        queue.update(taskId, nextMessage.id, () => undefined)
      })
      .catch(error => {
        const normalizedError = error instanceof Error ? error : new Error(String(error))
        queue.update(taskId, nextMessage.id, message => ({
          ...message,
          status: 'failed',
          error: normalizedError.message,
        }))
        onDispatchErrorRef.current?.(normalizedError, () => retryMessage(taskId, nextMessage.id))
      })
  }, [activeTaskQueue, dispatchMode, isDispatchBlocked, queue, retryMessage, taskId])

  return {
    activeTaskQueue,
    enqueueMessage,
    retryMessage,
    cancelMessage,
    updateQueuedMessage,
  }
}
