// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { useLayoutEffect, useState, useSyncExternalStore } from 'react'
import { createVersionMutationQueue } from '../versionMutationQueue'

type VersionedIssue = { id: string; version: number }
type Operation<T> = (source: T) => Promise<T>

function createFieldSaves<T extends VersionedIssue>(initial: T | null) {
  let source = initial
  let accept: ((issue: T) => void) | undefined
  let reportError: ((error: unknown) => void) | undefined
  let active = false
  let pending = 0
  let snapshot: { pending: boolean; error: unknown } = {
    pending: false,
    error: null,
  }
  const queue = createVersionMutationQueue<T>(initial?.version ?? 0)
  const failures = new Map<string, { operation: Operation<T>; error: unknown }>()
  const listeners = new Set<() => void>()
  const publish = () => {
    snapshot = {
      pending: pending > 0,
      error: [...failures.values()].at(-1)?.error ?? null,
    }
    if (active) listeners.forEach(listener => listener())
  }
  async function save(key: string, operation: Operation<T>): Promise<T | undefined> {
    pending += 1
    failures.delete(key)
    publish()
    try {
      return await queue.enqueue(
        async version => {
          if (!source) throw new Error('Issue unavailable')
          const updated = await operation({ ...source, version })
          failures.delete(key)
          if (updated.version >= source.version) {
            source = updated
            if (active) accept?.(updated)
          }
          return source
        },
        issue => issue.version
      )
    } catch (error) {
      failures.set(key, { operation, error })
      if (active) reportError?.(error)
      return undefined
    } finally {
      pending -= 1
      publish()
    }
  }
  return {
    save,
    retry() {
      for (const [key, failure] of [...failures]) void save(key, failure.operation)
    },
    synchronize(next: T | null, onSaved: (issue: T) => void, onError?: (error: unknown) => void) {
      if (next && (!source || next.version >= source.version)) source = next
      queue.synchronize(next?.version ?? 0)
      accept = onSaved
      reportError = onError
    },
    activate(value: boolean) {
      active = value
    },
    subscribe(listener: () => void) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    getSnapshot: () => snapshot,
  }
}

export function useIssueFieldSaves<T extends VersionedIssue>(
  source: T | null,
  accept: (issue: T) => void,
  onError?: (error: unknown) => void
) {
  const [scope, setScope] = useState(() => ({
    id: source?.id,
    saves: createFieldSaves(source),
  }))
  if (scope.id !== source?.id) setScope({ id: source?.id, saves: createFieldSaves(source) })
  const saves = scope.saves
  useLayoutEffect(() => {
    saves.synchronize(source, accept, onError)
  }, [saves, source, accept, onError])
  useLayoutEffect(() => {
    saves.activate(true)
    return () => saves.activate(false)
  }, [saves])
  const snapshot = useSyncExternalStore(saves.subscribe, saves.getSnapshot, saves.getSnapshot)
  return { ...snapshot, save: saves.save, retry: saves.retry }
}
