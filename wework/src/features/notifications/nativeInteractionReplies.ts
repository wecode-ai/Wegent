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
interface NativeReplyOwner {
  active(): boolean
  enabled(): boolean
  items(): RuntimeInteraction[]
  isHandled(id: string): boolean
  isBusy(id: string): boolean
  respond(
    item: RuntimeInteraction,
    text: string,
    options: { clientMessageId: string }
  ): Promise<boolean>
  setDraft(id: string, text: string): void
  retainDraft(item: InteractionHistory, reply: NativeReply): Promise<void>
  retainedReply(id: string): InteractionReplyDraft | undefined
}

/** A real inbox owns host replies until accepted delivery or durable draft recovery. */
export function createNativeInteractionReplies(accountKey: string, owner: NativeReplyOwner) {
  let connected = false
  let epoch = 0
  let retry: ReturnType<typeof setTimeout> | undefined
  let draining = false
  let drainRequested = false
  let lastEligibility: string | undefined
  const handled = createStandInRecordStore(`wework.interactions:${accountKey}:native-replies`)
  let handledIds = new Set<string>()
  let unsubscribe: (() => void) | undefined
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
    const current = epoch
    const isCurrent = () => connected && owner.active() && current === epoch
    if (!isCurrent()) return
    if (draining) {
      drainRequested = true
      return
    }
    drainRequested = false
    clearTimeout(retry)
    retry = undefined
    draining = true
    try {
      const replies = await invokeDesktopHost<NativeReply[]>('notification.pendingReplies', {
        accountKey,
      })
      for (const reply of replies) {
        if (!isCurrent()) return
        if (handledIds.has(reply.id)) {
          await acknowledge(reply.id)
          continue
        }
        const retained = owner.retainedReply(reply.id)
        const item = owner.items().find(item => item.id === reply.interactionId)
        let metadata = retained?.interaction
        if (!metadata && owner.isHandled(reply.interactionId)) {
          metadata = item
            ? interactionHistoryEntry(item, Date.now())
            : readInteractionHistory(`wework.interactions:${accountKey}:history`).find(
                row => row.id === reply.interactionId
              )
        }
        if (metadata) {
          await owner.retainDraft(metadata, reply)
          await acknowledge(reply.id)
          continue
        }
        // Cached entries never authorize sending. Keep unknown replies owned by the host.
        if (!item || item.cached || owner.isBusy(item.id)) continue
        owner.setDraft(item.id, reply.text)
        const accepted = await owner.respond(item, reply.text, { clientMessageId: reply.id })
        // Accepted delivery is independent of recovery storage and account lifetime.
        if (accepted) await acknowledge(reply.id)
        else if (isCurrent()) {
          await owner.retainDraft(interactionHistoryEntry(item, Date.now()), reply)
          await acknowledge(reply.id)
        }
      }
    } catch (error) {
      console.error('[Wework] Could not handle notification reply', error)
      if (isCurrent()) retry = setTimeout(() => void drain(), 1_000)
    } finally {
      draining = false
      if (drainRequested) void drain()
    }
  }
  const disconnect = () => {
    connected = false
    clearTimeout(retry)
    retry = undefined
    drainRequested = false
    epoch++
    unsubscribe?.()
    unsubscribe = undefined
  }
  return {
    synchronize() {
      if (
        !owner.active() ||
        !owner.enabled() ||
        !isElectronRuntime() ||
        getDesktopWindowLabel() !== 'main'
      ) {
        if (connected) disconnect()
        return
      }
      const eligibility = JSON.stringify(
        owner
          .items()
          .map(item => [
            item.id,
            item.cached === true,
            owner.isHandled(item.id),
            owner.isBusy(item.id),
          ])
      )
      const eligibilityChanged = eligibility !== lastEligibility
      lastEligibility = eligibility
      if (!connected) {
        connected = true
        epoch++
        handledIds = new Set(Object.keys(handled.getSnapshot()))
        unsubscribe = subscribeDesktopHostEvents(event => {
          if (event.type === 'notification-reply') void drain()
        })
        void drain()
      } else if (eligibilityChanged) void drain()
    },
    disconnect,
  }
}
