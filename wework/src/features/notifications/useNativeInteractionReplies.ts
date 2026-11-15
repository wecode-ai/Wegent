import { useEffect, useLayoutEffect, useRef } from 'react'
import { invokeDesktopHost, subscribeDesktopHostEvents } from '@/api/dsh/desktopHost'
import { getDesktopWindowLabel, isElectronRuntime } from '@/lib/runtime-environment'
import type { InteractionHistory, InteractionReplyDraft } from './RuntimeInteractionsContext'
import { readInteractionHistory } from './interactionStorage'
import { createStandInRecordStore } from './standInNotificationStorage'
import type { RuntimeInteraction } from './runtimeInteractions'
import { interactionHistoryEntry } from './interactionArchive'

interface NativeReply {
  id: string
  interactionId: string
  text: string
}

/** Transfer unsent replies out of the host only after their recovery record commits. */
export function useNativeInteractionReplies({
  accountKey,
  enabled,
  items,
  isHandled,
  isBusy,
  respond,
  setDraft,
  retainDraft,
  retainedReply,
}: {
  accountKey: string
  enabled: boolean
  items: RuntimeInteraction[]
  isHandled: (id: string) => boolean
  isBusy: (id: string) => boolean
  respond: (
    item: RuntimeInteraction,
    text: string,
    options: { clientMessageId: string }
  ) => Promise<boolean>
  setDraft: (id: string, text: string) => void
  retainDraft: (item: InteractionHistory, reply: NativeReply) => Promise<void>
  retainedReply: (id: string) => InteractionReplyDraft | undefined
}) {
  const latest = useRef({ items, isHandled, isBusy, respond, setDraft, retainDraft, retainedReply })
  useLayoutEffect(() => {
    latest.current = { items, isHandled, isBusy, respond, setDraft, retainDraft, retainedReply }
  }, [items, isHandled, isBusy, respond, setDraft, retainDraft, retainedReply])
  const requestDrain = useRef<(() => void) | null>(null)
  useEffect(() => requestDrain.current?.(), [items])
  useEffect(() => {
    if (!enabled || !isElectronRuntime() || getDesktopWindowLabel() !== 'main') return
    const handled = createStandInRecordStore(`wework.interactions:${accountKey}:native-replies`)
    const handledIds = new Set(Object.keys(handled.getSnapshot()))
    let active = true
    let draining = false
    const acknowledge = async (id: string) => {
      handledIds.add(id)
      try {
        handled.write({
          ...handled.getSnapshot(),
          [id]: { version: 'handled', savedAt: Date.now() },
        })
      } catch (error) {
        // Accepted sends and durably retained drafts no longer depend on this retry hint.
        console.error('[Wework] Could not persist notification reply receipt', error)
      }
      await invokeDesktopHost('notification.acknowledgeReply', { id, accountKey })
    }
    const drain = async () => {
      if (draining) return
      draining = true
      try {
        const replies = await invokeDesktopHost<NativeReply[]>('notification.pendingReplies', {
          accountKey,
        })
        for (const reply of replies) {
          if (!active) return
          if (handledIds.has(reply.id)) {
            await acknowledge(reply.id)
            continue
          }
          const retained = latest.current.retainedReply(reply.id)
          const item = latest.current.items.find(item => item.id === reply.interactionId)
          let metadata = retained?.interaction
          if (!metadata && latest.current.isHandled(reply.interactionId)) {
            metadata = item
              ? interactionHistoryEntry(item, Date.now())
              : readInteractionHistory(`wework.interactions:${accountKey}:history`).find(
                  row => row.id === reply.interactionId
                )
          }
          if (metadata) {
            await latest.current.retainDraft(metadata, reply)
            await acknowledge(reply.id)
            continue
          }
          // Cached entries never authorize sending. Keep unknown replies owned by the host.
          if (!item || item.cached || latest.current.isBusy(item.id)) continue
          latest.current.setDraft(item.id, reply.text)
          const accepted = await latest.current.respond(item, reply.text, {
            clientMessageId: reply.id,
          })
          // Accepted delivery is independent of recovery storage and account lifetime.
          if (accepted) await acknowledge(reply.id)
          else if (active) {
            await latest.current.retainDraft(interactionHistoryEntry(item, Date.now()), reply)
            await acknowledge(reply.id)
          }
        }
      } catch (error) {
        console.error('[Wework] Could not handle notification reply', error)
      } finally {
        draining = false
      }
    }
    const unsubscribe = subscribeDesktopHostEvents(event => {
      if (event.type === 'notification-reply') void drain()
    })
    requestDrain.current = () => void drain()
    void drain()
    const timer = window.setInterval(() => void drain(), 5000)
    return () => {
      window.clearInterval(timer)
      active = false
      requestDrain.current = null
      unsubscribe()
    }
  }, [accountKey, enabled])
}
