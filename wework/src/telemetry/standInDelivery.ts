import { telemetryDeliveryScope } from './identity'
import type { StandInExecutorApi, StandInTelemetryFact } from '@/api/standIn'
import type { WeworkTelemetryEnvelope } from './facts'
import { ANALYTICS_EVENT_PROPERTY_KEYS, type ExecutionTarget } from './events'
import {
  deliverDurableEvent,
  durableTelemetryIdentity,
  sanitizeAnalyticsProperties,
  type DurableTelemetryIdentity,
} from './client'

const RETENTION_MS = 30 * 24 * 60 * 60 * 1000
const MAX_EVENTS = 10_000
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

interface QueuedFact {
  readonly fact: WeworkTelemetryEnvelope
  readonly identity: DurableTelemetryIdentity
}

/** Account/device scope is a local routing key and never part of an event. */
export function createStandInDelivery(key: string) {
  const storageKey = `wework.stand-in-telemetry:${key}`
  const read = (): QueuedFact[] => {
    const rows = JSON.parse(localStorage.getItem(storageKey) ?? '[]') as QueuedFact[]
    return rows
      .filter(
        row =>
          validFact(row.fact) &&
          row.identity?.scope === telemetryDeliveryScope() &&
          Date.parse(row.fact.occurredAt) >= Date.now() - RETENTION_MS
      )
      .slice(-MAX_EVENTS)
  }
  const write = (rows: QueuedFact[]) =>
    localStorage.setItem(storageKey, JSON.stringify(rows.slice(-MAX_EVENTS)))

  return {
    clear: () => localStorage.removeItem(storageKey),
    async collect(
      api: StandInExecutorApi,
      userId: number,
      deviceId: string,
      active: () => boolean,
      executorLocation: ExecutionTarget = 'unknown'
    ) {
      const { items } = await api.telemetryFacts(userId, deviceId)
      if (!active()) return
      const identity = await durableTelemetryIdentity()
      if (!active() || !identity) return
      const rows = read()
      const known = new Set(rows.map(row => row.fact.eventId))
      const ids: string[] = []
      for (const item of items) {
        if (!validInput(item)) throw new Error('Invalid stand-in telemetry fact')
        ids.push(item.id)
        if (known.has(item.id)) continue
        known.add(item.id)
        const properties = { ...item.properties }
        Object.assign(properties, { executor_location: executorLocation })
        rows.push({
          fact: {
            name: item.name,
            properties: sanitizeAnalyticsProperties(item.name, properties),
            eventId: item.id,
            occurredAt: new Date(item.occurredAt).toISOString(),
          } as WeworkTelemetryEnvelope,
          identity,
        })
      }
      // A failed storage write must leave the Executor queue unacknowledged.
      write(rows)
      if (active() && ids.length) await api.acknowledgeTelemetry(userId, deviceId, ids)
    },
    async flush(active: () => boolean) {
      const rows = read()
      write(rows)
      for (const row of rows) {
        if (!active()) return
        const accepted = Boolean(
          row.identity &&
          (await deliverDurableEvent(row.fact, row.fact.eventId, row.fact.occurredAt, row.identity))
        )
        if (!active()) return
        // Re-read after awaiting transport so newly collected facts are preserved.
        write(
          read().flatMap(current =>
            current.fact.eventId !== row.fact.eventId ? [current] : accepted ? [] : [current]
          )
        )
        if (!accepted) return
      }
    },
  }
}

function validInput(item: StandInTelemetryFact): boolean {
  return (
    UUID.test(item.id) &&
    Number.isFinite(item.occurredAt) &&
    item.occurredAt >= 0 &&
    item.name.startsWith('stand_in_') &&
    Object.hasOwn(ANALYTICS_EVENT_PROPERTY_KEYS, item.name) &&
    typeof item.properties === 'object' &&
    item.properties !== null
  )
}

function validFact(fact: WeworkTelemetryEnvelope): boolean {
  return validInput({
    ...fact,
    id: fact.eventId,
    occurredAt: Date.parse(fact.occurredAt),
  } as StandInTelemetryFact)
}

export function clearStandInDeliveries(accountKey?: string) {
  const prefix = `wework.stand-in-telemetry:${accountKey == null ? '' : accountKey + ':'}`
  for (const key of Object.keys(localStorage)) {
    if (key.startsWith(prefix)) localStorage.removeItem(key)
  }
}

export function queuedStandInDevices(accountKey: string): string[] {
  const prefix = `wework.stand-in-telemetry:${accountKey}:`
  return Object.keys(localStorage)
    .filter(key => key.startsWith(prefix))
    .map(key => key.slice(prefix.length))
}
