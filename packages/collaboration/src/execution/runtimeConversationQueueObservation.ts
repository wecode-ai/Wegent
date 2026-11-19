import type { createRuntimeConversationSession } from '@wegent/chat-core/runtime-conversation-session'
import { createAppliedRuntimeGuidanceMessage } from './runtimeGuidanceMessages'
import type {
  RuntimeConversationQueue,
  RuntimeConversationQueuePort,
} from './runtimeConversationQueue'

type Session = ReturnType<typeof createRuntimeConversationSession>

/** Observe real queue messages and advance delivery from the addressed conversation's facts. */
export function createRuntimeConversationQueueObservation<Lifecycle>(
  queue: RuntimeConversationQueue<Lifecycle>,
  session: Session,
  port: RuntimeConversationQueuePort<Lifecycle>,
  { available, busy }: { available: boolean; busy: boolean }
) {
  const listeners = new Set<() => void>()
  let stops: (() => void)[] = []
  let generation = 0
  let scheduled = false
  const schedule = () => {
    if (!listeners.size || scheduled) return
    scheduled = true
    const current = generation
    queueMicrotask(() => {
      if (current !== generation || !listeners.size) return
      scheduled = false
      const state = session.getSnapshot()
      queue.reconcileGuidance(
        new Set(
          state.messages
            .filter(message => message.role === 'user' && message.runtimeGuidance)
            .map(message => message.id)
        )
      )
      if (available && !state.loading && !state.error) {
        void queue.pump(port, busy || state.running === true)
      }
    })
  }
  return {
    getSnapshot: queue.getSnapshot,
    subscribe(listener: () => void) {
      listeners.add(listener)
      if (listeners.size === 1) {
        stops = [
          queue.subscribe(() => {
            listeners.forEach(notify => notify())
            schedule()
          }),
          session.subscribe(schedule),
          session.subscribeGuidance(payload => {
            const message = queue.applyGuidance(payload)
            if (message)
              session.applyGuidance(
                createAppliedRuntimeGuidanceMessage(message, payload),
                payload.subtaskId
              )
          }),
        ]
        schedule()
      }
      return () => {
        listeners.delete(listener)
        if (!listeners.size) {
          generation++
          scheduled = false
          stops.forEach(stop => stop())
          stops = []
        }
      }
    },
  }
}
