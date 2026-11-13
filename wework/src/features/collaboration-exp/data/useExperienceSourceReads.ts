import { useEffect, useMemo, useRef, useState } from 'react'
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

/** Requests belong to one source/account epoch and one explicit refresh revision. */
export function useExperienceSourceReads<T>(
  sources: ExperienceSource[],
  owners: readonly ExperienceReadOwner[],
  active: boolean,
  revision: number,
  scopeKey: string,
  read: (owner: ExperienceReadOwner) => Promise<T>
) {
  const [snapshots, setSnapshots] = useState<SourceRead<T>[]>([])
  const epoch = useRef(0)
  const requests = useRef(new Map<ExperienceSource, Map<string, { revision: number }>>())
  useEffect(() => {
    epoch.current += 1
    const cache = requests.current
    cache.clear()
    return () => {
      epoch.current += 1
      cache.clear()
    }
  }, [sources, active, scopeKey])
  useEffect(() => {
    if (!active) return
    const generation = epoch.current
    for (const owner of owners) {
      const { source, key } = owner
      const cache = requests.current.get(source) ?? new Map<string, { revision: number }>()
      requests.current.set(source, cache)
      if (cache.get(key)?.revision === revision) continue
      const request = { revision }
      cache.set(key, request)
      const current = () => epoch.current === generation && cache.get(key) === request
      void Promise.resolve()
        .then(() => {
          if (!current()) throw new Error('Superseded source read')
          return read(owner)
        })
        .then(
          value => {
            if (current())
              setSnapshots(previous => [
                ...previous.filter(row => row.source !== source || row.key !== key),
                { ...owner, value, error: null, revision, scopeKey },
              ])
          },
          cause => {
            if (current())
              setSnapshots(previous => [
                ...previous.filter(row => row.source !== source || row.key !== key),
                {
                  ...owner,
                  value: null,
                  error: cause instanceof Error ? cause.message : String(cause),
                  revision,
                  scopeKey,
                },
              ])
          }
        )
    }
  }, [owners, active, revision, scopeKey, read])
  return useMemo(
    () =>
      owners.map(owner => {
        const snapshot = snapshots.find(
          row => row.source === owner.source && row.key === owner.key && row.scopeKey === scopeKey
        )
        return {
          ...owner,
          value: snapshot?.value ?? null,
          error: snapshot?.error ?? null,
          loading: active && snapshot?.revision !== revision,
        }
      }),
    [owners, snapshots, scopeKey, active, revision]
  )
}
