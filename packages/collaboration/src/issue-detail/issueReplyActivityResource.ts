import type { RuntimeTaskAddress } from '@wegent/chat-core/runtime'
import type { SharedWorkspaceRuntimeApi } from '../ports/SharedWorkspaceApi'

interface ActivitySnapshot {
  activity: Readonly<Record<string, boolean>>
  ready: boolean
  error: string | null
}

export function replyActivityKey(address: RuntimeTaskAddress): string {
  return `${address.deviceId}:${address.taskId}`
}

/** One owner connects the reply cards as a group before the scheduler can release queued work. */
export function createIssueReplyActivityResource(
  runtime: Pick<SharedWorkspaceRuntimeApi, 'subscribe'>,
  addresses: RuntimeTaskAddress[],
  refreshExecution: () => void
) {
  const listeners = new Set<() => void>()
  let snapshot: ActivitySnapshot = { activity: {}, ready: false, error: null }
  let stopSession: (() => void) | undefined
  const publish = (patch: Partial<ActivitySnapshot>) => {
    snapshot = { ...snapshot, ...patch }
    listeners.forEach(listener => listener())
  }
  const connect = () => {
    stopSession?.()
    let active = true
    const cleanups = new Set<() => void>()
    const stop = () => {
      active = false
      for (const cleanup of cleanups) cleanup()
      cleanups.clear()
    }
    stopSession = stop
    publish({ activity: {}, ready: false, error: null })
    void Promise.all(
      addresses.map(async address => {
        const key = replyActivityKey(address)
        const update = (running: boolean) => {
          if (active) publish({ activity: { ...snapshot.activity, [key]: running } })
        }
        const cleanup = await runtime.subscribe(address, {
          onMessageAction: () => {},
          onAssistantStart: () => update(true),
          onAssistantSettled: () => update(false),
          onHistoryInvalidated: () => {
            if (!active) return
            publish({ ready: false })
            // Coalesce invalidations from this connection and close the scheduler gate immediately.
            queueMicrotask(() => {
              if (active) connect()
            })
          },
        })
        if (active) cleanups.add(cleanup)
        else cleanup()
      })
    )
      .then(() => {
        if (!active) return
        refreshExecution()
        publish({ ready: true })
      })
      .catch(cause => {
        if (!active) return
        stop()
        publish({
          ready: false,
          error: cause instanceof Error ? cause.message : String(cause),
        })
      })
  }
  return {
    getSnapshot: () => snapshot,
    subscribe(listener: () => void) {
      listeners.add(listener)
      if (listeners.size === 1) connect()
      return () => {
        listeners.delete(listener)
        if (listeners.size) return
        stopSession?.()
        stopSession = undefined
        publish({ activity: {}, ready: false, error: null })
      }
    },
    reload() {
      if (listeners.size) connect()
    },
  }
}
