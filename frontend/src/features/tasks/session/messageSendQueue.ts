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
  type Message = QueuedMessage<TSnapshot>
  interface Entry {
    message: Message
    previous?: Entry
    next?: Entry
  }
  interface TaskQueue {
    entries: Map<string, Entry>
    first?: Entry
    last?: Entry
    snapshot?: readonly Message[]
  }
  const emptyQueue: readonly Message[] = []
  const queues = new Map<number, TaskQueue>()
  const listeners = new Set<() => void>()

  const notify = (queue: TaskQueue) => {
    queue.snapshot = undefined
    listeners.forEach(listener => listener())
  }

  return {
    getMessages(taskId?: number | null) {
      const queue = queues.get(taskId ?? 0)
      if (!queue) return emptyQueue
      queue.snapshot ??= Array.from(queue.entries.values(), entry => entry.message)
      return queue.snapshot
    },
    getMessage(taskId: number | null, id: string) {
      return queues.get(taskId ?? 0)?.entries.get(id)?.message
    },
    peek(taskId: number) {
      return queues.get(taskId)?.first?.message
    },
    peekLast(taskId: number) {
      return queues.get(taskId)?.last?.message
    },
    subscribe(listener: () => void) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    enqueue(message: Message) {
      let queue = queues.get(message.taskId)
      if (!queue) {
        queue = { entries: new Map() }
        queues.set(message.taskId, queue)
      }
      if (queue.entries.has(message.id)) return
      const entry: Entry = { message, previous: queue.last }
      if (queue.last) {
        queue.last.next = entry
      } else {
        queue.first = entry
      }
      queue.last = entry
      queue.entries.set(message.id, entry)
      notify(queue)
    },
    update(taskId: number, id: string, updateMessage: (message: Message) => Message | undefined) {
      const queue = queues.get(taskId)
      const entry = queue?.entries.get(id)
      if (!queue || !entry) return
      const updated = updateMessage(entry.message)
      if (updated === entry.message) return
      if (updated) {
        entry.message = updated
      } else {
        const { previous, next } = entry
        if (previous) {
          previous.next = next
        } else {
          queue.first = next
        }
        if (next) {
          next.previous = previous
        } else {
          queue.last = previous
        }
        queue.entries.delete(id)
        if (queue.entries.size === 0) queues.delete(taskId)
      }
      notify(queue)
    },
  }
}

export type MessageSendQueue<TSnapshot> = ReturnType<typeof createMessageSendQueue<TSnapshot>>
