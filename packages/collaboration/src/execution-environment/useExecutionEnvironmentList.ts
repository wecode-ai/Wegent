// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

import { useEffect, useMemo, useSyncExternalStore } from 'react'

import type { SharedWorkspaceApi } from '../ports/SharedWorkspaceApi'
import type { CollaborationExecutionEnvironment } from '../types'

type Environment = CollaborationExecutionEnvironment
type Source = 'project' | 'workspace' | 'device-local' | 'device-cloud'
type Snapshot = {
  items: Environment[] | undefined
  refreshing: boolean
  error: unknown
}

function createList(load: () => Promise<Environment[]>) {
  let snapshot: Snapshot = { items: undefined, refreshing: false, error: null }
  let pending: Promise<void> | undefined
  let revision = 0
  const listeners = new Set<() => void>()
  const publish = (next: Snapshot) => {
    snapshot = next
    listeners.forEach(listener => listener())
  }
  return {
    getSnapshot: () => snapshot,
    subscribe(listener: () => void) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    refresh() {
      if (pending) return pending
      const current = ++revision
      publish({ ...snapshot, refreshing: true, error: null })
      pending = Promise.resolve()
        .then(load)
        .then(
          items => {
            if (revision === current) publish({ items, refreshing: false, error: null })
          },
          error => {
            if (revision === current) publish({ ...snapshot, refreshing: false, error })
          }
        )
        .finally(() => {
          if (revision === current) pending = undefined
        })
      return pending
    },
    update(change: (items: Environment[]) => Environment[]) {
      // Successful mutations supersede an older list response, including an in-flight refresh.
      revision++
      pending = undefined
      publish({ items: change(snapshot.items ?? []), refreshing: false, error: null })
    },
  }
}

// Device loaders preserve session identity across composed and project-scoped APIs.
// Lists survive panel remounts, never account/API changes.
const sessions = new WeakMap<object, Map<string, ReturnType<typeof createList>>>()

function listFor(api: SharedWorkspaceApi, source: Source, id: string) {
  const session =
    (source === 'device-local'
      ? api.resources?.devices.local
      : source === 'device-cloud'
        ? api.resources?.devices.cloud
        : undefined) ?? api
  let lists = sessions.get(session)
  if (!lists) {
    lists = new Map()
    sessions.set(session, lists)
  }
  const key = JSON.stringify([source, id])
  let list = lists.get(key)
  if (!list) {
    list = createList(async () => {
      if (source === 'device-local') return api.resources?.devices.local?.() ?? []
      if (source === 'device-cloud') return api.resources?.devices.cloud?.() ?? []
      if (source === 'project') return api.projects.listExecutionEnvironments(id)
      return api.workspaces?.listExecutionEnvironments(id) ?? []
    })
    lists.set(key, list)
  }
  return list
}

export function useExecutionEnvironmentList(
  api: SharedWorkspaceApi,
  source: Source,
  id: string,
  enabled = true
) {
  const list = useMemo(() => listFor(api, source, id), [api, source, id])
  const snapshot = useSyncExternalStore(list.subscribe, list.getSnapshot, list.getSnapshot)
  useEffect(() => {
    if (enabled) void list.refresh()
  }, [list, enabled])
  return {
    ...snapshot,
    loading: enabled && snapshot.items === undefined && !snapshot.error,
    refresh: list.refresh,
    update: list.update,
  }
}
