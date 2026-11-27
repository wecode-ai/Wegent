// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { useCallback, useMemo, useSyncExternalStore } from 'react'
import type { SharedWorkspaceProjectsApi } from '../ports/SharedWorkspaceApi'
import type { CollaborationProject } from '../types'

type MigrationProjectApi = Pick<SharedWorkspaceProjectsApi, 'get' | 'update'>

/** Read the latest revision and change only the historical base-board grouping. */
export async function migrateBaseBoardStatusGrouping(
  api: MigrationProjectApi,
  projectId: string,
  isCurrent: () => boolean = () => true
): Promise<CollaborationProject | null> {
  const project = await api.get(projectId)
  if (!isCurrent()) return null
  if (project.board_config?.group_by !== 'tag') return project
  return api.update(projectId, {
    version: project.version,
    boardConfig: { ...project.board_config, group_by: 'status' },
  })
}

interface MigrationObservation {
  eligible: boolean
  onMigrated(project: CollaborationProject): void
}
function createMigrationSource(api: MigrationProjectApi | null, projectId: string | undefined) {
  let snapshot = { pending: false, settled: false, error: null as Error | null }
  let owner: MigrationObservation | undefined
  let revision = 0
  let delivered = false
  const listeners = new Set<() => void>()
  const publish = (patch: Partial<typeof snapshot>) => {
    snapshot = { ...snapshot, ...patch }
    listeners.forEach(listener => listener())
  }
  const run = async () => {
    if (!api || !projectId || !owner?.eligible || !listeners.size || snapshot.pending || delivered)
      return
    const request = ++revision
    const current = () => listeners.size > 0 && owner?.eligible === true && request === revision
    publish({ pending: true, settled: false, error: null })
    try {
      const updated = await migrateBaseBoardStatusGrouping(api, projectId, current)
      if (!current()) return
      publish({ pending: false, settled: true })
      if (updated && !delivered) {
        delivered = true
        owner?.onMigrated(updated)
      }
    } catch (cause) {
      if (current())
        publish({
          pending: false,
          settled: true,
          error: cause instanceof Error ? cause : new Error(String(cause)),
        })
    }
  }
  return {
    getSnapshot: () => snapshot,
    subscribe(input: MigrationObservation, listener: () => void) {
      const wasEligible = owner?.eligible
      owner = input
      listeners.add(listener)
      if (!input.eligible && wasEligible) {
        revision++
        publish({ pending: false })
      }
      if (input.eligible && !snapshot.settled) void run()
      return () => {
        listeners.delete(listener)
        queueMicrotask(() => {
          if (!listeners.size) {
            revision++
            owner = undefined
            snapshot = { ...snapshot, pending: false }
          }
        })
      }
    },
    retry() {
      delivered = false
      revision++
      publish({ pending: false, settled: false, error: null })
      void run()
    },
  }
}
export function useBaseBoardStatusMigration({
  api,
  project,
  enabled,
  canManage,
  onMigrated,
}: {
  api: MigrationProjectApi | null
  project: Pick<CollaborationProject, 'id' | 'project_store' | 'board_config'> | null
  enabled: boolean
  canManage: boolean
  onMigrated(project: CollaborationProject): void
}) {
  const scope = project ? `${project.project_store}:${project.id}` : null
  const projectId = project?.id
  const eligible = Boolean(
    api && scope && enabled && canManage && project?.board_config?.group_by === 'tag'
  )
  const source = useMemo(() => createMigrationSource(api, projectId), [api, projectId, scope])
  const subscribe = useCallback(
    (listener: () => void) => source.subscribe({ eligible, onMigrated }, listener),
    [source, eligible, onMigrated]
  )
  const snapshot = useSyncExternalStore(subscribe, source.getSnapshot, source.getSnapshot)
  return {
    error: eligible ? snapshot.error : null,
    pending: eligible && (snapshot.pending || !snapshot.settled),
    retry: source.retry,
  }
}
