import {
  createStandInTelemetrySession,
  type StandInTelemetryInput,
} from '@/telemetry/standInTelemetrySession'
import type { TaskSource } from './NotificationTaskSourceContext'

export interface NotificationTaskProducerOwner {
  readonly id: string
  readonly accountKey: string
}
interface Registration {
  owner: NotificationTaskProducerOwner
  source: TaskSource
  active: boolean
}

/** One authenticated window selects the active tab's actual notification projection. */
export function createNotificationTaskRegistry() {
  const telemetry = createStandInTelemetrySession()
  let telemetryInput: Omit<StandInTelemetryInput, 'source'> | undefined
  const syncTelemetry = () => {
    if (telemetryInput && listeners.size)
      telemetry.update({
        ...telemetryInput,
        userId: telemetryInput.userId ?? snapshot?.userId,
        source: snapshot,
      })
  }
  const entries = new Map<string, Registration>()
  const listeners = new Set<() => void>()
  let snapshot: TaskSource | null = null
  function publish() {
    const next =
      [...entries.values()].find(entry => entry.active)?.source ??
      entries.values().next().value?.source ??
      null
    if (next === snapshot) return
    snapshot = next
    syncTelemetry()
    listeners.forEach(listener => listener())
  }
  return {
    getSnapshot: () => snapshot,
    subscribe(listener: () => void, input?: Omit<StandInTelemetryInput, 'source'>) {
      if (input) telemetryInput = input
      listeners.add(listener)
      syncTelemetry()
      return () => {
        listeners.delete(listener)
        queueMicrotask(() => {
          if (!listeners.size) telemetry.stop()
        })
      }
    },
    claim(owner: NotificationTaskProducerOwner, source: TaskSource, active: boolean) {
      const registration: Registration = { owner, source, active }
      entries.set(owner.id, registration)
      publish()
      return {
        update(source: TaskSource, active: boolean) {
          if (entries.get(owner.id) !== registration) return
          if (registration.source === source && registration.active === active) return
          registration.source = source
          registration.active = active
          publish()
        },
        release() {
          if (entries.get(owner.id) !== registration) return
          entries.delete(owner.id)
          publish()
        },
      }
    },
  }
}
export type NotificationTaskRegistry = ReturnType<typeof createNotificationTaskRegistry>
