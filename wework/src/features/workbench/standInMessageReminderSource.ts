import {
  getRuntimeConversationMessages,
  getRuntimeConversationTurns,
  subscribeRuntimeConversation,
} from './runtimeConversationCache'
import { synchronizeRuntimeConversation } from './runtimeConversationSynchronization'
import { conversationOutcomePresentation } from '@/components/layout/workspace-panels/conversationOutcomePresentation'
import { sendSystemNotification } from './runtimeTaskSystemNotifications'
import type { RuntimeTaskReminderItem } from './runtimeTaskReminders'
import type { RuntimeTaskLifecycleStore } from './runtimeTaskLifecycle'
import { isRuntimeTurnRunningStatus } from './runtimeTaskLifecycle/projection'
import type { WorkbenchServices } from './workbenchServices'
import type { ReceivedAssistantMessage } from './runtimeTaskLifecycle/RuntimeMessageReceipts'

function completedReplies(item: RuntimeTaskReminderItem): ReceivedAssistantMessage[] {
  const turns = getRuntimeConversationTurns(item.address)
  const messages = getRuntimeConversationMessages(item.address)
  if (!turns.length)
    return messages.flatMap(message =>
      message.role === 'assistant' && message.status === 'done' && message.content.trim()
        ? [
            {
              id: message.id,
              text: message.content,
              createdAt: Date.parse(message.createdAt ?? '') || 0,
            },
          ]
        : []
    )
  const visible = conversationOutcomePresentation(messages, turns).turns
  return visible.flatMap((turn, index) =>
    turn.items.flatMap(entry => {
      if (entry.type !== 'assistant_text' || !entry.content.trim()) return []
      const original = turns[index]
      const position = original.items.findIndex(item => item.id === entry.id)
      if (position < 0) return []
      const settled = !isRuntimeTurnRunningStatus(original.status)
      if (!settled && position === original.items.length - 1) return []
      const completedAt = settled ? new Date(original.completedAt ?? 0).getTime() : 0
      return [
        {
          id: entry.id,
          text: entry.content,
          createdAt: Math.max(completedAt || 0, Date.parse(entry.createdAt) || 0),
        },
      ]
    })
  )
}

/** Canonical conversation subscriptions publish the actual unread counts shown by the workbench. */
export function createStandInMessageReminderSource(
  identities: RuntimeTaskReminderItem[],
  receipts: RuntimeTaskLifecycleStore['messageReceipts'],
  inApp: boolean,
  system: boolean,
  runtimeApi?: WorkbenchServices['runtimeWorkApi']
) {
  const listeners = new Set<() => void>()
  let snapshot = new Map<string, number>()
  let stop: (() => void) | undefined
  const getSnapshot = () => {
    const next = new Map(identities.map(item => [item.key, receipts.unreadCount(item.key)]))
    if (
      snapshot.size !== next.size ||
      [...next].some(([key, count]) => snapshot.get(key) !== count)
    )
      snapshot = next
    return snapshot
  }
  return {
    getSnapshot,
    subscribe(listener: () => void) {
      listeners.add(listener)
      if (listeners.size === 1) {
        const controller = new AbortController()
        const publish = () => {
          const previous = snapshot
          if (getSnapshot() !== previous) listeners.forEach(listener => listener())
        }
        const cleanups: Array<() => void> = [receipts.subscribe(publish)]
        stop = () => {
          controller.abort()
          cleanups.forEach(cleanup => cleanup())
        }
        for (const item of identities) {
          const observe = () => {
            if (controller.signal.aborted) return
            const incoming = receipts.observe(
              item.key,
              completedReplies(item),
              item.lifecycle?.unread ?? false
            )
            if (!inApp) receipts.markRead(item.key)
            if (system)
              for (const message of incoming) {
                void sendSystemNotification({
                  title: item.task.title,
                  body: message.text.replace(/\s+/g, ' ').trim().slice(0, 160),
                  address: item.address,
                })
              }
          }
          cleanups.push(
            subscribeRuntimeConversation(item.address, observe, {
              retainWhileSubscribed: false,
            })
          )
          observe()
          if (runtimeApi && !getRuntimeConversationTurns(item.address).length) {
            void synchronizeRuntimeConversation(runtimeApi.getRuntimeTranscript, item.address, {
              limit: 100,
              signal: controller.signal,
            })
              .then(() => {
                if (!controller.signal.aborted) observe()
              })
              .catch(error => {
                if (!controller.signal.aborted)
                  console.warn('[Wework] Failed to load stand-in notification history', error)
              })
          }
        }
        publish()
      }
      return () => {
        listeners.delete(listener)
        if (!listeners.size) {
          stop?.()
          stop = undefined
        }
      }
    },
  }
}
