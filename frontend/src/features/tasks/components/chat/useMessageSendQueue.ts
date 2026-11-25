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
  onDispatchError?: (message: QueuedMessage<TSnapshot>, error: Error) => void
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
      queue.update(input.taskId, current => [...current, queuedMessage])
    },
    [queue]
  )

  const retryMessage = useCallback(
    (id: string) => {
      if (!taskId) return
      dispatchedTaskRef.current = null
      queue.update(taskId, current =>
        current.map(message =>
          message.id === id && message.status === 'failed'
            ? { ...message, status: 'queued', error: undefined }
            : message
        )
      )
    },
    [queue, taskId]
  )

  const cancelMessage = useCallback(
    (id: string) => {
      if (!taskId) return
      queue.update(taskId, current =>
        current.filter(message => message.id !== id || message.status === 'sending')
      )
    },
    [queue, taskId]
  )

  const updateQueuedMessage = useCallback(
    (id: string, updater: (message: QueuedMessage<TSnapshot>) => QueuedMessage<TSnapshot>) => {
      if (!taskId) return
      queue.update(taskId, current =>
        current.map(message =>
          message.id === id && message.status === 'queued' ? updater(message) : message
        )
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
    const messages = queue.getMessages(taskId)
    if (messages.some(message => message.status !== 'queued')) return
    const nextMessage = messages[0]
    if (!nextMessage) return

    if (dispatchMode === 'one-per-unblock') dispatchedTaskRef.current = taskId
    queue.update(taskId, current => [{ ...nextMessage, status: 'sending' }, ...current.slice(1)])

    dispatchMessageRef
      .current(nextMessage)
      .then(() => {
        queue.update(taskId, current => current.filter(message => message.id !== nextMessage.id))
      })
      .catch(error => {
        const normalizedError = error instanceof Error ? error : new Error(String(error))
        queue.update(taskId, current =>
          current.map(message =>
            message.id === nextMessage.id
              ? { ...message, status: 'failed', error: normalizedError.message }
              : message
          )
        )
        onDispatchErrorRef.current?.(nextMessage, normalizedError)
      })
  }, [activeTaskQueue, dispatchMode, isDispatchBlocked, queue, taskId])

  return {
    activeTaskQueue,
    enqueueMessage,
    retryMessage,
    cancelMessage,
    updateQueuedMessage,
  }
}
