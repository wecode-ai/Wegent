import { useEffect, useId, type Dispatch, type SetStateAction } from 'react'
import { isMainWindowFocused, subscribeMainWindowFocus } from '@/desktop/windowFocus'
import type { WorkbenchContextValue } from '@/features/workbench/workbenchContextTypes'
import type {
  RuntimeTaskLifecycleSnapshot,
  RuntimeTaskLifecycleStore,
} from '@/features/workbench/runtimeTaskLifecycle'
import type { createRuntimeContextUsageStore } from '@wegent/chat-core/runtime-context-usage'
import { createAppliedRuntimeGuidanceMessage } from '@/features/workbench/runtimeGuidanceMessages'
import type { RuntimeTaskAddress } from '@/types/api'
import type { WorkbenchMessage } from '@/types/workbench'
import type { runtimePaneQueue } from './runtimePaneQueues'

interface TemporaryChatRuntimeEventsOptions {
  address: RuntimeTaskAddress | null
  active: boolean
  markReadWhenActive: boolean
  lifecycle: RuntimeTaskLifecycleSnapshot | null
  lifecycleStore: RuntimeTaskLifecycleStore
  contextUsageStore: ReturnType<typeof createRuntimeContextUsageStore>
  conversationQueue: ReturnType<typeof runtimePaneQueue>
  messages: readonly WorkbenchMessage[]
  subscribeRuntimeTaskStream: WorkbenchContextValue['subscribeRuntimeTaskStream']
  setSending: Dispatch<SetStateAction<boolean>>
  setMessages: Dispatch<SetStateAction<WorkbenchMessage[]>>
}

export function useTemporaryChatRuntimeEvents({
  address,
  active,
  markReadWhenActive,
  lifecycle,
  lifecycleStore,
  contextUsageStore,
  conversationQueue,
  messages,
  subscribeRuntimeTaskStream,
  setSending,
  setMessages,
}: TemporaryChatRuntimeEventsOptions) {
  const messageViewId = useId()
  useEffect(() => {
    conversationQueue.reconcileGuidance(
      new Set(
        messages
          .filter(message => message.role === 'user' && message.runtimeGuidance)
          .map(message => message.id)
      )
    )
  }, [conversationQueue, messages])

  useEffect(() => {
    if (!markReadWhenActive || !active || !address) return
    const key = lifecycle?.key ?? `${address.deviceId}\0${address.taskId}`
    const markRead = () => {
      lifecycleStore.messageReceipts?.setViewed(key, isMainWindowFocused(), messageViewId)
      if (isMainWindowFocused() && lifecycleStore.getTask(address)?.unread) {
        lifecycleStore.markRead(address)
      }
    }
    markRead()
    const unsubscribe = subscribeMainWindowFocus(markRead)
    return () => {
      unsubscribe()
      lifecycleStore.messageReceipts?.setViewed(key, false, messageViewId)
    }
  }, [
    active,
    address,
    lifecycleStore,
    markReadWhenActive,
    messageViewId,
    lifecycle?.key,
    lifecycle?.unread,
  ])

  useEffect(() => {
    if (!address) return
    return subscribeRuntimeTaskStream(address, {
      onContextUsageUpdated: contextUsageStore.receiveLive,
      onMessageAction: () => undefined,
      onAssistantStart: () => setSending(false),
      onAssistantSettled: () => setSending(false),
      onGuidanceApplied: payload => {
        const guidanceMessage = conversationQueue.applyGuidance(payload)
        if (!guidanceMessage) return
        setMessages(current => [
          ...current.filter(message => message.id !== guidanceMessage.id),
          createAppliedRuntimeGuidanceMessage(guidanceMessage, payload),
        ])
      },
    })
  }, [
    address,
    contextUsageStore,
    subscribeRuntimeTaskStream,
    conversationQueue,
    setMessages,
    setSending,
  ])
}
