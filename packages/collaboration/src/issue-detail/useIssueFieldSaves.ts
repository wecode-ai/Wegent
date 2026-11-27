// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { useLayoutEffect, useState, useSyncExternalStore } from 'react'
import { createVersionMutationQueue } from '../versionMutationQueue'

type VersionedIssue = { id: string; version: number }
type Operation<T> = (source: T) => Promise<T>
type SaveOptions = { retry?: boolean; reportError?: boolean }

function createFieldSaves<T extends VersionedIssue>(initial: T | null) {
  let source = initial
  let accept: ((issue: T) => void) | undefined
  let reportError: ((error: unknown) => void) | undefined
  let active = false
  const pendingFields = new Map<string, number>()
  const submissions = new Map<string, number>()
  let saved = false
  let snapshot: {
    pending: boolean
    pendingFields: ReadonlySet<string>
    error: unknown
    saved: boolean
    canRetry: boolean
  } = {
    pending: false,
    pendingFields: new Set(),
    error: null,
    saved: false,
    canRetry: false,
  }
  const queue = createVersionMutationQueue<T>(initial?.version ?? 0)
  const failures = new Map<
    string,
    { operation: Operation<T>; error: unknown; submission: number; options: SaveOptions }
  >()
  const listeners = new Set<() => void>()
  const publish = () => {
    const currentFailures = [...failures.values()]
    const latestFailure = currentFailures.at(-1)
    snapshot = {
      pending: pendingFields.size > 0,
      pendingFields: new Set(pendingFields.keys()),
      error: latestFailure?.error ?? null,
      saved,
      canRetry: currentFailures.some(failure => failure.options.retry !== false),
    }
    if (active) listeners.forEach(listener => listener())
  }
  async function save(
    key: string,
    operation: Operation<T>,
    options: SaveOptions = {}
  ): Promise<T | undefined> {
    const submission = (submissions.get(key) ?? 0) + 1
    submissions.set(key, submission)
    pendingFields.set(key, (pendingFields.get(key) ?? 0) + 1)
    failures.delete(key)
    publish()
    try {
      const updated = await queue.enqueue(
        async version => {
          if (!source) throw new Error('Issue unavailable')
          const updated = await operation({ ...source, version })
          if (submissions.get(key) === submission) failures.delete(key)
          if (updated.version >= source.version) {
            source = updated
            if (active) accept?.(updated)
          }
          saved = true
          return source
        },
        issue => issue.version
      )
      return active ? updated : undefined
    } catch (error) {
      if (submissions.get(key) === submission) {
        failures.set(key, { operation, error, submission, options })
        if (active && options.reportError !== false) reportError?.(error)
      }
      return undefined
    } finally {
      const remaining = (pendingFields.get(key) ?? 1) - 1
      if (remaining) pendingFields.set(key, remaining)
      else pendingFields.delete(key)
      publish()
    }
  }
  return {
    save,
    retry() {
      for (const [key, failure] of [...failures]) {
        if (failure.options.retry !== false && submissions.get(key) === failure.submission)
          void save(key, failure.operation, failure.options)
      }
    },
    discardFailure(key: string) {
      if (failures.delete(key)) publish()
    },
    isPending: (key: string) => pendingFields.has(key),
    getSource: () => source,
    acceptSource(next: T, confirmedWrite = false) {
      if (!active || !source || next.id !== source.id) return
      if (next.version > source.version || (confirmedWrite && next.version === source.version)) {
        source = next
        queue.synchronize(next.version)
        accept?.(next)
      }
      return source
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
  return {
    ...snapshot,
    save: saves.save,
    retry: saves.retry,
    discardFailure: saves.discardFailure,
    isPending: saves.isPending,
    getSource: saves.getSource,
    acceptSource: saves.acceptSource,
  }
}
