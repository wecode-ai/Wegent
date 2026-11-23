import { createAsyncResource } from '@wegent/chat-core/async-resource'
import { subscribeDesktopHostEvents } from '@/api/dsh/desktopHost'
import {
  ensurePython,
  listExecutionEnvironments,
  type ExecutionEnvironmentStatus,
} from './executionEnvironments'

interface EnvironmentSnapshot {
  scope: number
  environments: ExecutionEnvironmentStatus[]
  loading: boolean
  error: unknown
  noticeRevision: number
  preparingPython: boolean
}
const initialSnapshot = (): EnvironmentSnapshot => ({
  scope: 0,
  environments: [],
  loading: true,
  error: undefined,
  noticeRevision: 0,
  preparingPython: false,
})

export function createExecutionEnvironmentResource() {
  const listeners = new Set<() => void>()
  let snapshot = initialSnapshot()
  let generation = 0
  let pythonRevision = 0
  let eventRevision = 0
  let python: ExecutionEnvironmentStatus | undefined
  let preparation: Promise<ExecutionEnvironmentStatus> | undefined
  let query: ReturnType<typeof createAsyncResource<ExecutionEnvironmentStatus[]>> | undefined
  let disconnect: (() => void) | undefined
  const publish = () => {
    const read = query?.getSnapshot()
    const environments = read?.data ?? []
    const currentPython = python
    snapshot = {
      ...snapshot,
      scope: generation,
      environments: currentPython
        ? environments.some(item => item.id === 'python')
          ? environments.map(item => (item.id === 'python' ? currentPython : item))
          : [...environments, currentPython]
        : environments,
      loading: !read?.settled,
      error: read?.error,
      preparingPython: !!preparation,
    }
    listeners.forEach(listener => listener())
  }
  const receive = (next: ExecutionEnvironmentStatus) => {
    if (
      next.state === 'error' ||
      (next.state === 'downloading' && python?.state !== 'downloading')
    ) {
      snapshot = { ...snapshot, noticeRevision: snapshot.noticeRevision + 1 }
    }
    python = next
    pythonRevision++
  }
  const connect = () => {
    const current = ++generation
    // A pending list can still supply Node while newer Python events stay authoritative.
    query = createAsyncResource('desktop/execution-environments', async signal => {
      const revision = pythonRevision
      const environments = await listExecutionEnvironments()
      if (!signal.aborted && current === generation && revision === pythonRevision) {
        const next = environments.find(item => item.id === 'python')
        if (next) receive(next)
      }
      return environments
    })
    const unlisten = subscribeDesktopHostEvents(event => {
      if (current !== generation || event.type !== 'python-runtime-status') return
      eventRevision++
      receive(event.payload as unknown as ExecutionEnvironmentStatus)
      publish()
    })
    const stopQuery = query.subscribe(publish)
    disconnect = () => {
      generation++
      stopQuery()
      unlisten()
      query = undefined
      python = undefined
      snapshot = initialSnapshot()
    }
  }
  const preparePython = () => {
    if (preparation) return preparation
    // Accepted preparation belongs to the runtime and survives consumer remounts.
    const current = generation
    const revision = eventRevision
    pythonRevision++
    const request = Promise.resolve().then(ensurePython)
    const operation = request
      .then(
        status => {
          if (current === generation && listeners.size && revision === eventRevision)
            receive(status)
          return status
        },
        error => {
          if (current === generation && listeners.size && revision === eventRevision && python) {
            receive({ ...python, state: 'error' })
          }
          throw error
        }
      )
      .finally(() => {
        if (preparation === operation) preparation = undefined
        if (listeners.size) publish()
      })
    preparation = operation
    publish()
    return operation
  }
  const subscribe = (listener: () => void) => {
    listeners.add(listener)
    if (listeners.size === 1) connect()
    return () => {
      listeners.delete(listener)
      if (!listeners.size) {
        disconnect?.()
        disconnect = undefined
      }
    }
  }
  return {
    getSnapshot: () => snapshot,
    subscribe,
    subscribeSettings(listener: () => void) {
      const refresh = listeners.size > 0 && query?.getSnapshot().status !== 'loading'
      const stop = subscribe(listener)
      if (refresh) void query?.reload()
      return stop
    },
    reload: (scope = generation) =>
      scope === generation ? (query?.reload() ?? Promise.resolve()) : Promise.resolve(),
    preparePython,
  }
}

export const executionEnvironmentResource = createExecutionEnvironmentResource()
