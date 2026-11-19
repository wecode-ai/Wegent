// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { useCallback, useMemo, useSyncExternalStore } from 'react'
import { useDocumentEvent, useWindowEvent } from '../dom-events'

import type { SharedWorkspaceApi } from '../ports/SharedWorkspaceApi'
import type { CollaborationExecutionEnvironment, CollaborationProject } from '../types'

export type ProjectExecutionEnvironmentReadinessKind =
  | 'not_applicable'
  | 'loading'
  | 'ready'
  | 'unassigned'
  | 'offline'
  | 'unknown'

export interface ProjectExecutionEnvironmentReadiness {
  kind: ProjectExecutionEnvironmentReadinessKind
  environments: CollaborationExecutionEnvironment[]
}

const EMPTY_ENVIRONMENTS: CollaborationExecutionEnvironment[] = []

export function resolveProjectExecutionEnvironmentReadiness(
  environments: CollaborationExecutionEnvironment[]
): ProjectExecutionEnvironmentReadiness {
  if (environments.length === 0) {
    return { kind: 'unassigned', environments }
  }

  // Directory preparation belongs to each run; it is not a prerequisite for
  // submitting work to an authorized, online runner.
  if (environments.some(environment => environment.status === 'online')) {
    return { kind: 'ready', environments }
  }
  return { kind: 'offline', environments }
}

function createReadinessStore(api: SharedWorkspaceApi, projectId: string | null) {
  let snapshot: ProjectExecutionEnvironmentReadiness = {
    kind: projectId !== null ? 'loading' : 'not_applicable',
    environments: EMPTY_ENVIRONMENTS,
  }
  const listeners = new Set<() => void>()
  let revision = 0
  let observedVersion: number | undefined
  let timer: ReturnType<typeof setInterval> | undefined
  const publish = (value: ProjectExecutionEnvironmentReadiness) => {
    snapshot = value
    listeners.forEach(listener => listener())
  }
  const refresh = async (): Promise<ProjectExecutionEnvironmentReadiness> => {
    if (projectId === null) return snapshot
    const current = ++revision
    let value: ProjectExecutionEnvironmentReadiness
    try {
      value = resolveProjectExecutionEnvironmentReadiness(
        await api.projects.listExecutionEnvironments(projectId)
      )
    } catch {
      value = { kind: 'unknown', environments: EMPTY_ENVIRONMENTS }
    }
    if (current === revision && listeners.size) publish(value)
    return value
  }
  const refreshWhenVisible = () => {
    if (typeof document === 'undefined' || document.visibilityState !== 'hidden') {
      void refresh()
    }
  }
  return {
    getSnapshot: () => snapshot,
    refresh,
    refreshWhenVisible,
    subscribe(listener: () => void, version: number | undefined, refreshIntervalMs: number) {
      const changed = observedVersion !== version
      observedVersion = version
      listeners.add(listener)
      if (listeners.size === 1 && projectId !== null) {
        publish(
          snapshot.environments.length
            ? resolveProjectExecutionEnvironmentReadiness(snapshot.environments)
            : { kind: 'loading', environments: EMPTY_ENVIRONMENTS }
        )
        void refresh()
        if (refreshIntervalMs > 0) timer = setInterval(refreshWhenVisible, refreshIntervalMs)
      } else if (changed && projectId !== null) {
        void refresh()
      }
      return () => {
        listeners.delete(listener)
        if (!listeners.size) {
          revision++
          clearInterval(timer)
          timer = undefined
        }
      }
    },
  }
}

export function useProjectExecutionEnvironmentReadiness({
  api,
  project,
  refreshIntervalMs = 15_000,
}: {
  api: SharedWorkspaceApi
  project: CollaborationProject | null | undefined
  refreshIntervalMs?: number
}): ProjectExecutionEnvironmentReadiness & {
  refresh(): Promise<ProjectExecutionEnvironmentReadiness>
} {
  const projectId = project?.id ?? null
  const version = project?.version
  const store = useMemo(() => createReadinessStore(api, projectId), [api, projectId])
  const subscribe = useCallback(
    (listener: () => void) => store.subscribe(listener, version, refreshIntervalMs),
    [store, version, refreshIntervalMs]
  )
  const snapshot = useSyncExternalStore(subscribe, store.getSnapshot, store.getSnapshot)
  useWindowEvent('focus', store.refreshWhenVisible, {
    enabled: projectId !== null,
  })
  useDocumentEvent('visibilitychange', store.refreshWhenVisible, {
    enabled: projectId !== null,
  })
  return { ...snapshot, refresh: store.refresh }
}
