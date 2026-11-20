import type { AsyncResourceSnapshot } from '@wegent/chat-core/async-resource'
import type {
  StandInExecutorApi,
  ProjectCoordinationState,
  ProjectCoordinationProcessing,
} from '@/api/standIn'

export interface ProjectCoordinationSnapshot {
  state: ProjectCoordinationState
  processing?: ProjectCoordinationProcessing
  processingError?: unknown
}

/** Coordination ownership is available before its optional processing read settles. */
export function createProjectCoordinationResource(
  api: StandInExecutorApi,
  userId: number,
  deviceId: string,
  target: { projectId: string; projectStore: 'local' | 'cloud'; groupId: string }
) {
  let snapshot: AsyncResourceSnapshot<ProjectCoordinationSnapshot> = {
    status: 'idle',
    settled: false,
    data: undefined,
    error: undefined,
  }
  let generation = 0
  let timer: ReturnType<typeof setTimeout> | undefined
  const listeners = new Set<() => void>()
  const publish = (next: typeof snapshot) => {
    snapshot = next
    listeners.forEach(listener => listener())
  }
  const current = (revision: number) => generation === revision && listeners.size > 0
  const schedule = (revision: number) => {
    if (!current(revision)) return
    clearTimeout(timer)
    timer = setTimeout(() => void reload(), 5000)
  }
  const reload = async () => {
    clearTimeout(timer)
    if (!listeners.size) return
    const revision = ++generation
    publish({ ...snapshot, status: 'loading' })
    if (!current(revision)) return
    try {
      const state = await api.projectCoordination(userId, deviceId, target)
      if (!current(revision)) return
      const mine =
        state.binding?.enabled &&
        state.binding.userId === userId &&
        state.binding.deviceId === deviceId
      // Stop and takeover controls must not wait for processing diagnostics.
      publish({
        status: mine ? 'loading' : 'ready',
        settled: true,
        data: { state },
        error: undefined,
      })
      if (!mine || !current(revision)) return
      try {
        const processing = await api.projectProcessing(userId, deviceId, target)
        if (current(revision))
          publish({ status: 'ready', settled: true, data: { state, processing }, error: undefined })
      } catch (cause) {
        if (!current(revision)) return
        const processingError = cause ?? new Error('Processing read failed')
        publish({
          status: 'error',
          settled: true,
          data: { state, processingError },
          error: processingError,
        })
      }
    } catch (error) {
      if (current(revision)) publish({ ...snapshot, status: 'error', settled: true, error })
    } finally {
      if (current(revision)) schedule(revision)
    }
  }
  return {
    key: JSON.stringify([userId, deviceId, target]),
    getSnapshot: () => snapshot,
    hasSubscribers: () => listeners.size > 0,
    reload,
    update(
      change: (
        data: ProjectCoordinationSnapshot | undefined
      ) => ProjectCoordinationSnapshot | undefined
    ) {
      if (!listeners.size) return
      const revision = ++generation
      clearTimeout(timer)
      publish({ status: 'ready', settled: true, data: change(snapshot.data), error: undefined })
      schedule(revision)
    },
    subscribe(listener: () => void) {
      listeners.add(listener)
      if (listeners.size === 1 && snapshot.status !== 'ready') void reload()
      else if (listeners.size === 1) schedule(generation)
      return () => {
        listeners.delete(listener)
        if (!listeners.size) {
          generation += 1
          clearTimeout(timer)
        }
      }
    },
  }
}
