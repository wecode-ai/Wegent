import type { RuntimeTaskPinRequest } from '@/types/api'

interface RuntimeTaskPinMutation {
  createdRevision: number
  requestId: number
  status: 'pending' | 'succeeded'
  value: boolean
}

interface RuntimeTaskPinOverride {
  mutations: RuntimeTaskPinMutation[]
}

export function getRuntimeTaskPinOverrideKey(deviceId: string, threadId: string) {
  return `${deviceId}\0${threadId}`
}

export function getRuntimeTaskPinnedValue(
  persistedPinned: boolean,
  override: RuntimeTaskPinOverride | undefined
) {
  return override?.mutations[override.mutations.length - 1]?.value ?? persistedPinned
}

function reconcileRuntimeTaskPinOverride(
  override: RuntimeTaskPinOverride,
  persistedPinned: boolean,
  revision: number
) {
  let acknowledgedMutationIndex = -1
  for (const [index, mutation] of override.mutations.entries()) {
    if (mutation.status !== 'succeeded') break
    if (mutation.createdRevision < revision && mutation.value === persistedPinned) {
      acknowledgedMutationIndex = index
    }
  }
  if (acknowledgedMutationIndex < 0) return override

  const mutations = override.mutations.slice(acknowledgedMutationIndex + 1)
  return mutations.length > 0 ? { mutations } : null
}

function reconcileRuntimeTaskPinOverrides(
  overrides: Map<string, RuntimeTaskPinOverride>,
  persistedPinStates: Map<string, boolean>,
  revision: number
) {
  let next = overrides
  for (const [key, override] of overrides) {
    const persistedPinned = persistedPinStates.get(key)
    if (persistedPinned === undefined) continue
    const reconciled = reconcileRuntimeTaskPinOverride(override, persistedPinned, revision)
    if (reconciled === override) continue
    if (next === overrides) next = new Map(overrides)
    if (reconciled) {
      next.set(key, reconciled)
    } else {
      next.delete(key)
    }
  }
  return next
}

/** Serialize explicit pin commands and retain each intent until runtime snapshots acknowledge it. */
export function createRuntimeTaskPinSource() {
  let snapshot = new Map<string, RuntimeTaskPinOverride>()
  let persistedStates = new Map<string, boolean>()
  let revision = 0
  let requestSequence = 0
  const requests = new Map<string, Promise<void>>()
  const listeners = new Set<() => void>()
  const updateOverrides = (
    change: (current: Map<string, RuntimeTaskPinOverride>) => Map<string, RuntimeTaskPinOverride>
  ) => {
    const next = change(snapshot)
    if (next === snapshot) return
    snapshot = next
    for (const listener of listeners) listener()
  }
  return {
    getSnapshot: () => snapshot,
    subscribe(listener: () => void, persisted: Map<string, boolean>) {
      listeners.add(listener)
      if (persistedStates !== persisted) {
        persistedStates = persisted
        revision += 1
        updateOverrides(current =>
          reconcileRuntimeTaskPinOverrides(current, persistedStates, revision)
        )
      }
      return () => {
        listeners.delete(listener)
      }
    },
    async pin(data: RuntimeTaskPinRequest, write: (data: RuntimeTaskPinRequest) => Promise<void>) {
      const key = getRuntimeTaskPinOverrideKey(data.deviceId, data.threadId)
      const requestId = ++requestSequence
      updateOverrides(current => {
        const next = new Map(current)
        const existing = current.get(key)
        next.set(key, {
          mutations: [
            ...(existing?.mutations ?? []),
            {
              createdRevision: revision,
              requestId,
              status: 'pending',
              value: data.pinned,
            },
          ],
        })
        return next
      })
      const previousRequest = requests.get(key) ?? Promise.resolve()
      const request = previousRequest.catch(() => undefined).then(() => write(data))
      requests.set(key, request)
      try {
        await request
        updateOverrides(current => {
          const override = current.get(key)
          if (!override) return current
          const mutations = override.mutations.map(mutation =>
            mutation.requestId === requestId
              ? { ...mutation, status: 'succeeded' as const }
              : mutation
          )
          const persistedPinned = persistedStates.get(key)
          const reconciled =
            persistedPinned === undefined
              ? { mutations }
              : reconcileRuntimeTaskPinOverride({ mutations }, persistedPinned, revision)
          const next = new Map(current)
          if (reconciled) {
            next.set(key, reconciled)
          } else {
            next.delete(key)
          }
          return next
        })
      } catch (error) {
        updateOverrides(current => {
          const override = current.get(key)
          if (!override?.mutations.some(mutation => mutation.requestId === requestId))
            return current
          const next = new Map(current)
          const mutations = override.mutations.filter(mutation => mutation.requestId !== requestId)
          if (mutations.length > 0) {
            next.set(key, { mutations })
          } else {
            next.delete(key)
          }
          return next
        })
        throw error
      } finally {
        if (requests.get(key) === request) {
          requests.delete(key)
        }
      }
    },
  }
}
