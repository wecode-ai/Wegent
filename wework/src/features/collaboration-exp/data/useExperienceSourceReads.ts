import { useMemo, useState, useSyncExternalStore } from 'react'
import { createAsyncResource, subscribeIdleResource } from '@wegent/chat-core/async-resource'
import type { ExperienceSource } from './useExperienceSources'

export interface ExperienceReadOwner {
  source: ExperienceSource
  key: string
}
interface SourceRead<T> extends ExperienceReadOwner {
  value: T | null
  error: string | null
  revision: number
  scopeKey: string
}

/** Invalidation follows structured access/resource failures, never display copy. */
export function invalidatesExperienceRead(error: unknown): boolean {
  const visited = new Set<object>()
  while (error && typeof error === 'object' && !visited.has(error)) {
    visited.add(error)
    const value = error as {
      status?: unknown
      statusCode?: unknown
      code?: unknown
      errorCode?: unknown
      cause?: unknown
    }
    const statuses = [value.status, value.statusCode]
    if (
      statuses.some(status => status === 401 || status === 403 || status === 404 || status === 410)
    )
      return true
    const deniedCodes = [
      'http_401',
      'http_403',
      'http_404',
      'http_410',
      'authentication_required',
      'unauthenticated',
      'permission_denied',
      'unauthorized',
      'forbidden',
      'not_found',
      'scope_forbidden',
      'scope_not_found',
      'project_session_access_denied',
      'source_removed',
      'source_mismatch',
      'identity_mismatch',
      'wrong_device',
    ]
    if (
      [value.code, value.errorCode].some(
        code => typeof code === 'string' && deniedCodes.includes(code.toLowerCase())
      )
    )
      return true
    error = value.cause
  }
  return false
}

interface ReadEntry<T> {
  resource: ReturnType<typeof createAsyncResource<SourceRead<T>>>
  subscribe(
    listener: () => void,
    version: unknown,
    revision: number,
    read: (owner: ExperienceReadOwner) => Promise<T>
  ): () => void
}
interface ReadRegistry<T> {
  sources: ExperienceSource[]
  scopeKey: string
  entries: Map<ExperienceSource, Map<string, ReadEntry<T>>>
  previous?: ReadRegistry<T>
}
function entryFor<T>(registry: ReadRegistry<T>, owner: ExperienceReadOwner): ReadEntry<T> {
  let entries = registry.entries.get(owner.source)
  if (!entries) {
    entries = new Map()
    registry.entries.set(owner.source, entries)
  }
  const existing = entries.get(owner.key)
  if (existing) return existing
  let requestedRevision = 0
  let read: ((owner: ExperienceReadOwner) => Promise<T>) | undefined
  const previous = registry.previous?.entries
    .get(owner.source)
    ?.get(owner.key)
    ?.resource.getSnapshot().data
  const resource: ReturnType<typeof createAsyncResource<SourceRead<T>>> = createAsyncResource<
    SourceRead<T>
  >(
    JSON.stringify([registry.scopeKey, owner.key]),
    async signal => {
      const revision = requestedRevision
      const load = read
      try {
        await Promise.resolve()
        signal.throwIfAborted()
        if (!load) throw new Error('Source reader is unavailable')
        const value = await load(owner)
        return { ...owner, value, error: null, revision, scopeKey: registry.scopeKey }
      } catch (cause) {
        signal.throwIfAborted()
        return {
          ...owner,
          value: invalidatesExperienceRead(cause)
            ? null
            : (resource.getSnapshot().data?.value ?? null),
          error: cause instanceof Error ? cause.message : String(cause),
          revision,
          scopeKey: registry.scopeKey,
        }
      }
    },
    { initialData: previous }
  )
  const entry = {
    resource,
    subscribe(
      listener: () => void,
      version: unknown,
      revision: number,
      load: (owner: ExperienceReadOwner) => Promise<T>
    ) {
      requestedRevision = revision
      read = load
      let active = true
      const stop = resource.subscribe(() => {
        if (active) listener()
      }, version)
      return () => {
        active = false
        // A replacement reader in the same commit takes over the pending request.
        // Each lease has its own listener, so stopping the old lease cannot detach the new one.
        queueMicrotask(stop)
      }
    },
  }
  entries.set(owner.key, entry)
  return entry
}

function createSourceReader<T>(
  registry: ReadRegistry<T>,
  owners: readonly ExperienceReadOwner[],
  version: unknown,
  revision: number,
  read: (owner: ExperienceReadOwner) => Promise<T>
) {
  const entries = owners.map(owner => entryFor(registry, owner))
  let snapshots = entries.map(entry => entry.resource.getSnapshot())
  return {
    getSnapshot() {
      const next = entries.map(entry => entry.resource.getSnapshot())
      if (next.some((snapshot, index) => snapshot !== snapshots[index])) snapshots = next
      return snapshots
    },
    subscribe(listener: () => void) {
      const stops = entries.map(entry => entry.subscribe(listener, version, revision, read))
      return () => stops.forEach(stop => stop())
    },
  }
}

/** Requests belong to one source/account epoch and one explicit refresh revision. */
export function useExperienceSourceReads<T>(
  sources: ExperienceSource[],
  owners: readonly ExperienceReadOwner[],
  active: boolean,
  revision: number,
  scopeKey: string,
  read: (owner: ExperienceReadOwner) => Promise<T>
) {
  const [registry, setRegistry] = useState<ReadRegistry<T>>(() => ({
    sources: [...sources],
    scopeKey,
    entries: new Map(),
  }))
  if (
    registry.scopeKey !== scopeKey ||
    registry.sources.length !== sources.length ||
    registry.sources.some((source, index) => source !== sources[index])
  ) {
    setRegistry({
      sources: [...sources],
      scopeKey,
      entries: new Map(),
      previous: registry.scopeKey === scopeKey ? { ...registry, previous: undefined } : undefined,
    })
  }
  const activation = useMemo(() => ({ registry, active }), [registry, active])
  const version = useMemo(() => ({ activation, revision }), [activation, revision])
  const reader = useMemo(
    () => createSourceReader(registry, owners, version, revision, read),
    [registry, owners, version, revision, read]
  )
  const snapshots = useSyncExternalStore(
    active ? reader.subscribe : subscribeIdleResource,
    reader.getSnapshot,
    reader.getSnapshot
  )
  return useMemo(
    () =>
      owners.map((owner, index) => {
        const snapshot = snapshots[index]?.data
        return {
          ...owner,
          value: snapshot?.value ?? null,
          error: snapshot?.error ?? null,
          loading: active && snapshot?.revision !== revision,
        }
      }),
    [owners, snapshots, active, revision]
  )
}
