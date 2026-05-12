import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

export type QueuedMessageStatus = 'queued' | 'sending' | 'failed'

export interface EnqueueMessageInput<TSnapshot> {
  taskId: number
  localMessageId: string
  displayMessage: string
  snapshot: TSnapshot
}

export interface QueuedMessage<TSnapshot> extends EnqueueMessageInput<TSnapshot> {
  id: string
  createdAt: number
  status: QueuedMessageStatus
  error?: string
}

interface UseMessageSendQueueOptions<TSnapshot> {
  taskId?: number | null
  isDispatchBlocked: boolean
  dispatchMessage: (message: QueuedMessage<TSnapshot>) => Promise<void>
  onDispatchError?: (message: QueuedMessage<TSnapshot>, error: Error) => void
}

export function useMessageSendQueue<TSnapshot>({
  taskId,
  isDispatchBlocked,
  dispatchMessage,
  onDispatchError,
}: UseMessageSendQueueOptions<TSnapshot>) {
  const [queuedMessages, setQueuedMessages] = useState<Array<QueuedMessage<TSnapshot>>>([])
  const isDispatchingRef = useRef(false)
  const dispatchMessageRef = useRef(dispatchMessage)
  const onDispatchErrorRef = useRef(onDispatchError)

  dispatchMessageRef.current = dispatchMessage
  onDispatchErrorRef.current = onDispatchError

  const enqueueMessage = useCallback((input: EnqueueMessageInput<TSnapshot>) => {
    const queuedMessage: QueuedMessage<TSnapshot> = {
      ...input,
      id: `${input.taskId}:${input.localMessageId}`,
      createdAt: Date.now(),
      status: 'queued',
    }

    setQueuedMessages(current => [...current, queuedMessage])
    return queuedMessage
  }, [])

  const activeTaskQueue = useMemo(() => {
    if (!taskId) return []
    return queuedMessages.filter(message => message.taskId === taskId)
  }, [queuedMessages, taskId])

  useEffect(() => {
    if (!taskId || isDispatchBlocked || isDispatchingRef.current) return
    if (activeTaskQueue.some(message => message.status === 'failed')) return

    const nextMessage = activeTaskQueue.find(message => message.status === 'queued')
    if (!nextMessage) return

    isDispatchingRef.current = true
    setQueuedMessages(current =>
      current.map(message =>
        message.id === nextMessage.id ? { ...message, status: 'sending' } : message
      )
    )

    dispatchMessageRef
      .current(nextMessage)
      .then(() => {
        setQueuedMessages(current => current.filter(message => message.id !== nextMessage.id))
      })
      .catch(error => {
        const normalizedError = error instanceof Error ? error : new Error(String(error))
        setQueuedMessages(current =>
          current.map(message =>
            message.id === nextMessage.id
              ? { ...message, status: 'failed', error: normalizedError.message }
              : message
          )
        )
        onDispatchErrorRef.current?.(nextMessage, normalizedError)
      })
      .finally(() => {
        isDispatchingRef.current = false
      })
  }, [activeTaskQueue, isDispatchBlocked, taskId])

  return {
    queuedMessages,
    activeTaskQueue,
    enqueueMessage,
  }
}
