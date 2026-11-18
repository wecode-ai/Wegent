// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { useCallback, useEffect, useRef, useState } from 'react'
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

interface MigrationAttempt {
  api: MigrationProjectApi
  scope: string
  retry: number
  active: boolean
  delivered: boolean
  abandoned: boolean
  promise: Promise<CollaborationProject | null>
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
  const groupBy = project?.board_config?.group_by
  const [retryCount, setRetryCount] = useState(0)
  const attemptRef = useRef<MigrationAttempt | null>(null)
  const onMigratedRef = useRef(onMigrated)
  const eligible = Boolean(api && scope && enabled && canManage && groupBy === 'tag')
  const [state, setState] = useState<{
    scope: string | null
    api: MigrationProjectApi | null
    retry: number
    eligible: boolean
    error: Error | null
    pending: boolean
  }>({ scope, api, retry: retryCount, eligible, error: null, pending: eligible })
  if (
    state.scope !== scope ||
    state.api !== api ||
    state.retry !== retryCount ||
    state.eligible !== eligible
  ) {
    setState({ scope, api, retry: retryCount, eligible, error: null, pending: eligible })
  }
  useEffect(() => {
    onMigratedRef.current = onMigrated
  }, [onMigrated])

  useEffect(() => {
    if (!api || !scope || !projectId || !enabled || !canManage || groupBy !== 'tag') {
      if (attemptRef.current?.scope !== scope || attemptRef.current?.api !== api)
        attemptRef.current = null
      return
    }
    let attempt = attemptRef.current
    if (
      !attempt ||
      attempt.api !== api ||
      attempt.scope !== scope ||
      attempt.retry !== retryCount ||
      attempt.abandoned
    ) {
      attempt = {
        api,
        scope,
        retry: retryCount,
        active: true,
        delivered: false,
        abandoned: false,
        promise: Promise.resolve(null),
      }
      const current = attempt
      attempt.promise = migrateBaseBoardStatusGrouping(api, projectId, () => current.active).then(
        updated => {
          current.abandoned = updated === null
          return updated
        }
      )
      attemptRef.current = attempt
    }
    const current = attempt
    current.active = true
    let subscribed = true
    const nextState = {
      scope,
      api,
      retry: retryCount,
      eligible: true,
      error: null,
      pending: true,
    }
    void current.promise.then(
      updated => {
        if (!subscribed) return
        setState({ ...nextState, pending: false })
        if (updated && !current.delivered) {
          current.delivered = true
          onMigratedRef.current(updated)
        }
      },
      cause => {
        if (subscribed)
          setState({
            ...nextState,
            pending: false,
            error: cause instanceof Error ? cause : new Error(String(cause)),
          })
      }
    )
    return () => {
      subscribed = false
      current.active = false
    }
  }, [api, scope, projectId, enabled, canManage, groupBy, retryCount])

  const retry = useCallback(() => setRetryCount(count => count + 1), [])
  const visible =
    eligible && state.scope === scope && state.api === api && state.retry === retryCount
  return {
    error: visible ? state.error : null,
    pending: visible && state.pending,
    retry,
  }
}
