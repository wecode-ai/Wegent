// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import type { MessageSyncer } from './messageSyncer'

type SendMessage = MessageSyncer['sendMessage']

export interface PreparedChatSend {
  localMessageId: string
  displayMessage: string
  sourceMessage: string
  request: Parameters<SendMessage>[0]
  options: NonNullable<Parameters<SendMessage>[1]>
}

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

export function createMessageSendQueue<TSnapshot>() {
  type Messages = readonly QueuedMessage<TSnapshot>[]
  const emptyQueue: Messages = []
  const queues = new Map<number, Messages>()
  const listeners = new Set<() => void>()

  const getMessages = (taskId?: number | null): Messages => queues.get(taskId ?? 0) ?? emptyQueue

  return {
    getMessages,
    subscribe(listener: () => void) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    update(taskId: number, updateMessages: (messages: Messages) => Messages) {
      const current = getMessages(taskId)
      const next = updateMessages(current)
      if (next === current) return
      if (next.length) {
        queues.set(taskId, next)
      } else {
        queues.delete(taskId)
      }
      listeners.forEach(listener => listener())
    },
  }
}

export type MessageSendQueue<TSnapshot> = ReturnType<typeof createMessageSendQueue<TSnapshot>>
