import type { DeviceInfo } from '@/types/devices'
import type { DeviceLifecyclePhase } from './useDeviceOfflineLifecycleAction'

export interface DeviceOfflineLifecycleInputs {
  status: DeviceInfo['status']
  runtimeInstanceId?: string | null
  recoveryReady?: boolean
  requestAction(): Promise<unknown>
  refreshDevices(): void | Promise<void>
  pollIntervalMs: number
  timeoutMs: number
  recoveredNoticeMs: number
}

/** An explicitly requested device operation owns its observed offline/online lifecycle. */
export function createDeviceOfflineLifecycleSource() {
  let snapshot: { phase: DeviceLifecyclePhase; error: string | null } = {
    phase: 'idle',
    error: null,
  }
  let inputs: DeviceOfflineLifecycleInputs | undefined
  let startingInstance: string | null | undefined
  let timedOutPhase: 'waiting-offline' | 'waiting-online' = 'waiting-offline'
  let operation = 0
  let deadline = 0
  let noticeUntil = 0
  let detached = false
  let pollRevision = 0
  let inFlightRefresh: Promise<void> | undefined
  let pollTimer: ReturnType<typeof setTimeout> | undefined
  let deadlineTimer: ReturnType<typeof setTimeout> | undefined
  let noticeTimer: ReturnType<typeof setTimeout> | undefined
  const listeners = new Set<() => void>()
  const waiting = () => snapshot.phase === 'waiting-offline' || snapshot.phase === 'waiting-online'
  const publish = (phase: DeviceLifecyclePhase, error = snapshot.error) => {
    snapshot = { phase, error }
    listeners.forEach(listener => listener())
  }
  const clearTimers = () => {
    clearTimeout(pollTimer)
    clearTimeout(deadlineTimer)
    clearTimeout(noticeTimer)
  }
  const armNotice = () => {
    clearTimeout(noticeTimer)
    const remaining = noticeUntil - Date.now()
    if (remaining <= 0) {
      publish('idle')
      return
    }
    noticeTimer = setTimeout(() => {
      if (listeners.size && snapshot.phase === 'recovered') publish('idle')
    }, remaining)
  }
  const advance = () => {
    if (!inputs || !listeners.size || !waiting()) return
    const changed = Boolean(
      startingInstance && inputs.runtimeInstanceId && startingInstance !== inputs.runtimeInstanceId
    )
    const connected = inputs.status === 'online' || inputs.status === 'busy'
    if (
      (snapshot.phase === 'waiting-online' || changed) &&
      connected &&
      inputs.recoveryReady !== false
    ) {
      clearTimers()
      noticeUntil = Date.now() + inputs.recoveredNoticeMs
      publish('recovered')
      armNotice()
    } else if (snapshot.phase === 'waiting-offline' && (inputs.status === 'offline' || changed))
      publish('waiting-online')
  }
  const current = (epoch: number) => epoch === operation && listeners.size > 0 && waiting()
  const readRefresh = () => {
    if (inFlightRefresh) return inFlightRefresh
    const refresh = inputs!.refreshDevices
    const task = Promise.resolve()
      .then(() => refresh())
      .then(() => undefined)
    inFlightRefresh = task
    const clear = () => {
      if (inFlightRefresh === task) inFlightRefresh = undefined
    }
    void task.then(clear, clear)
    return task
  }
  const poll = async (epoch: number, propagate = false) => {
    if (!current(epoch) || !inputs) return
    const revision = ++pollRevision
    try {
      await readRefresh()
    } catch (cause) {
      console.error('Failed to refresh devices during lifecycle action:', cause)
      if (propagate) throw cause
    } finally {
      if (current(epoch) && revision === pollRevision)
        pollTimer = setTimeout(() => void poll(epoch), inputs!.pollIntervalMs)
    }
  }
  const armDeadline = (epoch: number) => {
    if (!current(epoch)) return
    const timeout = () => {
      if (!current(epoch)) return
      timedOutPhase = snapshot.phase as 'waiting-offline' | 'waiting-online'
      clearTimers()
      publish('timeout')
    }
    if (deadline <= Date.now()) timeout()
    else deadlineTimer = setTimeout(timeout, deadline - Date.now())
  }
  const beginWaiting = (phase: 'waiting-offline' | 'waiting-online') => {
    clearTimers()
    const epoch = operation
    deadline = Date.now() + inputs!.timeoutMs
    publish(phase)
    advance()
    armDeadline(epoch)
    return epoch
  }
  return {
    getSnapshot: () => snapshot,
    async run(): Promise<boolean> {
      if (!inputs || !listeners.size || snapshot.phase === 'submitting' || waiting()) return false
      const request = inputs.requestAction
      startingInstance = inputs.runtimeInstanceId
      const epoch = ++operation
      clearTimers()
      publish('submitting', null)
      try {
        await request()
        if (epoch !== operation) return false
        beginWaiting(inputs.status === 'offline' ? 'waiting-online' : 'waiting-offline')
        void poll(epoch)
        return true
      } catch (cause) {
        if (epoch !== operation) return false
        console.error('Device lifecycle action failed:', cause)
        publish('error', cause instanceof Error ? cause.message : String(cause))
        return false
      }
    },
    async refreshAfterTimeout() {
      if (!inputs || !listeners.size) return
      operation += 1
      const epoch = beginWaiting(timedOutPhase)
      await poll(epoch, true)
    },
    subscribe(listener: () => void, nextInputs: DeviceOfflineLifecycleInputs) {
      listeners.add(listener)
      inputs = nextInputs
      if (detached) {
        detached = false
        if (waiting()) {
          advance()
          armDeadline(operation)
          void poll(operation)
        } else if (snapshot.phase === 'recovered') armNotice()
      } else advance()
      return () => {
        listeners.delete(listener)
        queueMicrotask(() => {
          if (listeners.size) return
          // Keep the actual request receipt and original deadline for re-observation.
          detached = true
          pollRevision += 1
          clearTimers()
        })
      }
    },
  }
}
