import { getDesktopE2ERuntimeConfig } from './runtime-config'

export interface ExecutorActivity {
  available: boolean
  requests: Record<string, number>
  events: Record<string, number>
  parseFailures: number
  protocolFailures: number
  transportFailures: number
  cancellations: number
  requestFailures: number
  duplicateEvents: number
  duplicateDeliveries: number
  injectedDuplicateDeliveries: number
  streamStarts: number
  reconnects: number
  fullTaskListReads: number
  pendingTaskListReads: number
}

type Activity =
  | { kind: 'request'; method: string; pendingOnly: boolean }
  | {
      kind: 'event'
      name: string
      sequence: number
      stream: symbol
      delivered: boolean
      injected?: boolean
    }
  | {
      kind: Exclude<
        keyof ExecutorActivity,
        'available' | 'requests' | 'events' | 'fullTaskListReads' | 'pendingTaskListReads'
      >
    }

let registered = false
const listeners = new Set<(activity: Activity) => void>()

export function registerExecutorActivity(): void {
  registered = true
}

export function recordExecutorActivity(activity: Activity): void {
  if (listeners.size === 0) return
  for (const listener of listeners) listener(activity)
}

export function startExecutorActivity() {
  const counts: ExecutorActivity = {
    available: registered,
    requests: {},
    events: {},
    parseFailures: 0,
    protocolFailures: 0,
    transportFailures: 0,
    cancellations: 0,
    requestFailures: 0,
    duplicateEvents: 0,
    duplicateDeliveries: 0,
    injectedDuplicateDeliveries: 0,
    streamStarts: 0,
    reconnects: 0,
    fullTaskListReads: 0,
    pendingTaskListReads: 0,
  }
  const requests = new Map<string, number>()
  const events = new Map<string, number>()
  const deliveries = new Map<symbol, Set<number>>()
  const listener = (activity: Activity) => {
    if (activity.kind === 'request') {
      requests.set(activity.method, (requests.get(activity.method) ?? 0) + 1)
      if (activity.method === 'runtime.tasks.list') {
        if (activity.pendingOnly) counts.pendingTaskListReads += 1
        else counts.fullTaskListReads += 1
      }
    } else if (activity.kind === 'event') {
      if (!activity.delivered) {
        counts.duplicateEvents += 1
        return
      }
      events.set(activity.name, (events.get(activity.name) ?? 0) + 1)
      const seen = deliveries.get(activity.stream) ?? new Set<number>()
      if (seen.has(activity.sequence)) {
        counts.duplicateDeliveries += 1
        if (activity.injected) counts.injectedDuplicateDeliveries += 1
      }
      seen.add(activity.sequence)
      deliveries.set(activity.stream, seen)
    } else counts[activity.kind] += 1
  }
  if (
    typeof window !== 'undefined' &&
    (import.meta.env.VITE_WEWORK_E2E === 'true' || getDesktopE2ERuntimeConfig().controlUrl)
  )
    listeners.add(listener)
  return {
    snapshot: (): ExecutorActivity => ({
      ...counts,
      available: registered,
      requests: Object.fromEntries(requests),
      events: Object.fromEntries(events),
    }),
    stop: () => listeners.delete(listener),
  }
}
