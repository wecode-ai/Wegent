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
                  value: invalidatesExperienceRead(cause)
                    ? null
                    : (previous.find(
                        row => row.source === source && row.key === key && row.scopeKey === scopeKey
                      )?.value ?? null),
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
