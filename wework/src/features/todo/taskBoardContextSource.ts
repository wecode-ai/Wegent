import { allSettledWithConcurrency } from '@/lib/promise-concurrency'
import type { RuntimeTaskAddress } from '@/types/api'
import {
  findProjectSpaceContextSourceForTask,
  type ProjectSpaceApi,
  type ProjectSpaceTaskContextSource,
} from './projectSpaceSelection'

export type RuntimeTaskContextSource = ProjectSpaceTaskContextSource<ProjectSpaceApi>

export const BULK_TASK_CONCURRENCY = 8

export function runtimeTaskContextKey(address: RuntimeTaskAddress): string {
  return `${address.deviceId}\0${address.taskId}`
}

export function sameProjectSpaceApis(left: ProjectSpaceApi[], right: ProjectSpaceApi[]): boolean {
  return left.length === right.length && left.every((api, index) => api === right[index])
}

export function createTaskBoardContextSource(projectSpaceApis: ProjectSpaceApi[]) {
  const apis = [...projectSpaceApis]
  const listeners = new Set<() => void>()
  const versions = new Map<string, number>()
  const pending = new Map<string, number>()
  let snapshot: ReadonlyMap<string, RuntimeTaskContextSource> = new Map()
  let generation = 0
  let subscriptionRevision = 0

  const publish = (next: ReadonlyMap<string, RuntimeTaskContextSource>) => {
    snapshot = next
    for (const listener of listeners) listener()
  }

  function lookup(addresses: RuntimeTaskAddress[]) {
    if (apis.length === 0) return
    const lookupGeneration = generation
    // Allocate all versions before workers start, including queued reads.
    const unresolved = addresses.flatMap(address => {
      const key = runtimeTaskContextKey(address)
      if (snapshot.has(key) || pending.has(key)) return []
      const version = (versions.get(key) ?? 0) + 1
      versions.set(key, version)
      pending.set(key, version)
      return [{ address, key, version }]
    })
    if (unresolved.length === 0) return
    void allSettledWithConcurrency(
      unresolved,
      BULK_TASK_CONCURRENCY,
      async ({ address, key, version }) => {
        try {
          const source = await findProjectSpaceContextSourceForTask(apis, address)
          return { key, version, source }
        } finally {
          if (pending.get(key) === version) pending.delete(key)
        }
      }
    ).then(results => {
      if (generation !== lookupGeneration || listeners.size === 0) return
      const resolved = results.flatMap(result =>
        result.status === 'fulfilled' &&
        result.value.source.context.loop_item &&
        versions.get(result.value.key) === result.value.version
          ? [result.value]
          : []
      )
      if (resolved.length === 0) return
      const next = new Map(snapshot)
      for (const { key, source } of resolved) next.set(key, source)
      publish(next)
    })
  }

  return {
    apis,
    getSnapshot: () => snapshot,
    subscribe(addresses: RuntimeTaskAddress[], listener: () => void) {
      subscriptionRevision += 1
      listeners.add(listener)
      lookup(addresses)
      return () => {
        listeners.delete(listener)
        const revision = ++subscriptionRevision
        queueMicrotask(() => {
          if (revision !== subscriptionRevision || listeners.size > 0) return
          generation += 1
          pending.clear()
        })
      }
    },
    invalidate(addresses: RuntimeTaskAddress[]) {
      for (const address of addresses) {
        const key = runtimeTaskContextKey(address)
        versions.set(key, (versions.get(key) ?? 0) + 1)
      }
    },
    reconcile(
      resolved: Array<{ key: string; source: RuntimeTaskContextSource }>,
      removed: ReadonlySet<string>
    ) {
      if (resolved.length === 0 && removed.size === 0) return
      const next = new Map(snapshot)
      for (const { key, source } of resolved) next.set(key, source)
      for (const key of removed) next.delete(key)
      publish(next)
    },
  }
}
