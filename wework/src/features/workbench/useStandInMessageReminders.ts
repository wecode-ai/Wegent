import { useEffect, useMemo, useSyncExternalStore } from 'react'
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
import type { WeworkNotificationPreferences } from '@/api/notifications'

export function isStandInIdentity(item: RuntimeTaskReminderItem): boolean {
  const origin = item.task.runtimeHandle?.origin
  return Boolean(
    origin && typeof origin === 'object' && 'type' in origin && origin.type === 'stand_in_identity'
  )
}

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

/** Observe canonical messages, not task completion; native subagents stay internal. */
export function useStandInMessageReminders(
  items: RuntimeTaskReminderItem[],
  store: RuntimeTaskLifecycleStore,
  preferences: WeworkNotificationPreferences,
  runtimeApi?: WorkbenchServices['runtimeWorkApi']
) {
  const receipts = store.messageReceipts
  useSyncExternalStore(receipts.subscribe, receipts.getSnapshot, receipts.getSnapshot)
  const identities = useMemo(() => items.filter(isStandInIdentity), [items])
  useEffect(() => {
    let disposed = false
    const controller = new AbortController()
    const cleanups = identities.map(item => {
      const observe = () => {
        if (disposed) return
        const incoming = receipts.observe(
          item.key,
          completedReplies(item),
          item.lifecycle?.unread ?? false
        )
        if (!preferences.stand_in.in_app) receipts.markRead(item.key)
        if (preferences.stand_in.system)
          for (const message of incoming) {
            void sendSystemNotification({
              title: item.task.title,
              body: message.text.replace(/\s+/g, ' ').trim().slice(0, 160),
              address: item.address,
            })
          }
      }
      const unsubscribe = subscribeRuntimeConversation(item.address, observe, {
        retainWhileSubscribed: false,
      })
      observe()
      if (runtimeApi && !getRuntimeConversationTurns(item.address).length) {
        void synchronizeRuntimeConversation(runtimeApi.getRuntimeTranscript, item.address, {
          limit: 100,
          signal: controller.signal,
        })
          .then(() => {
            if (!disposed) observe()
          })
          .catch(error => {
            if (!controller.signal.aborted)
              console.warn('[Wework] Failed to load stand-in notification history', error)
          })
      }
      return unsubscribe
    })
    return () => {
      disposed = true
      controller.abort()
      cleanups.forEach(cleanup => cleanup())
    }
  }, [identities, preferences.stand_in.in_app, preferences.stand_in.system, receipts, runtimeApi])
  return new Map(identities.map(item => [item.key, receipts.unreadCount(item.key)]))
}
