// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

'use client'

import { createContext, useContext, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { apiClient as client, ApiError } from '@/apis/client'
import { knowledgePermissionApi } from '@/apis/knowledge-permission'
import { useUser } from '@/features/common/UserContext'
import type { KnowledgeSourceAccess } from '@/types/knowledge'
import type { RetrievalSummaryPayload, SourceReference } from '@/types/socket'

export type SourceAccessMap = Readonly<Partial<Record<number, KnowledgeSourceAccess>>>
type SourceDenial = 'denied' | 'visit-only'

export const WorkspaceSourceAccess = createContext<{
  knowledgeBaseId: number
  access?: KnowledgeSourceAccess
  revision: number
  onDenied?: (result: SourceDenial) => void
} | null>(null)

const unresolved: SourceAccessMap = {}
type Permission = Awaited<ReturnType<typeof knowledgePermissionApi.getMyPermission>>
type PermissionRead = Promise<Permission | undefined>

function createPermissionReads(load: (id: number, citationId?: string) => Promise<Permission>) {
  const entries = new Map<number, { request: PermissionRead; failed: boolean }>()
  return {
    read(
      id: number,
      retry: boolean,
      citationId?: string,
      onStart?: () => (access: KnowledgeSourceAccess) => void
    ) {
      const pending = entries.get(id)
      if (pending && !(pending.failed && retry)) return pending.request
      const publish = onStart?.()
      const entry = {
        failed: false,
        request: load(id, citationId).then(
          permission => {
            if (entries.get(id) !== entry) return undefined
            if (permission.source_access) publish?.(permission.source_access)
            return permission
          },
          error => {
            if (entries.get(id) !== entry) return undefined
            entry.failed = true
            throw error
          }
        ),
      }
      entries.set(id, entry)
      return entry.request
    },
    invalidate: (id: number) => entries.delete(id),
    clear: () => entries.clear(),
  }
}

function usePermissionReads(
  scope: string,
  load: (id: number, citationId?: string) => Promise<Permission>
) {
  const [session, setSession] = useState(() => ({ scope, reads: createPermissionReads(load) }))
  if (session.scope !== scope) setSession({ scope, reads: createPermissionReads(load) })
  const { reads } = session
  useLayoutEffect(() => reads.clear, [reads])
  return reads
}

export const TaskSourceDecisions = createContext<{
  taskId?: number
  access: SourceAccessMap
  checked: Readonly<Partial<Record<number, number>>>
  deny: (id: number) => void
  read: (id: number, retry: boolean) => PermissionRead
  onAnswerDenied?: (taskId: number) => void
} | null>(null)

export function useTaskSourceDecisions(taskId?: number, onAnswerDenied?: (taskId: number) => void) {
  const { user } = useUser()
  const workspace = useContext(WorkspaceSourceAccess)
  const scope = JSON.stringify([
    user?.id,
    client.getCacheScope(),
    taskId,
    workspace?.knowledgeBaseId,
    workspace?.revision,
  ])
  const [state, setState] = useState<{
    scope: string
    sources: Record<number, { access: KnowledgeSourceAccess; order: number }>
    checked: Record<number, number>
  }>({ scope, sources: {}, checked: {} })
  const sequence = useRef(0)
  const reads = usePermissionReads(scope, id =>
    knowledgePermissionApi.getMyPermission(id, { taskId })
  )
  if (state.scope !== scope) setState({ scope, sources: {}, checked: {} })
  return useMemo(() => {
    const sources = state.scope === scope ? state.sources : {}
    // A response from a check started before a newer decision cannot replace it.
    const beginCheck = (id: number, permissionRead = false) => {
      const order = ++sequence.current
      return (access: KnowledgeSourceAccess) =>
        setState(previous => {
          if (previous.scope !== scope || (previous.sources[id]?.order ?? 0) > order)
            return previous
          return {
            scope,
            sources: { ...previous.sources, [id]: { access, order } },
            checked: permissionRead ? { ...previous.checked, [id]: order } : previous.checked,
          }
        })
    }
    return {
      taskId,
      access: Object.fromEntries(Object.entries(sources).map(([id, fact]) => [id, fact.access])),
      checked: state.scope === scope ? state.checked : {},
      deny: (id: number) => {
        reads.invalidate(id)
        beginCheck(id)('denied')
      },
      read: (id: number, retry: boolean) =>
        reads.read(id, retry, undefined, () => beginCheck(id, true)),
      onAnswerDenied,
    }
  }, [scope, state, taskId, onAnswerDenied, reads])
}

export function isCitationDenied(error: unknown, scope: 'answer' | 'source') {
  return (
    error instanceof ApiError &&
    error.status === 403 &&
    error.errorCode === 'CITATION_ACCESS_DENIED' &&
    (error.detail as { denied_scope?: unknown } | undefined)?.denied_scope === scope
  )
}

export function useAnswerSourceAccess(
  ids: readonly number[],
  taskId?: number,
  answerId?: number,
  generationId?: string,
  enabled = true,
  citationSources?: ReadonlyMap<number, string>,
  useWorkspaceSource = true
) {
  const { user } = useUser()
  const workspace = useContext(WorkspaceSourceAccess)
  const taskSources = useContext(TaskSourceDecisions)
  const sharedSources = taskSources?.taskId === taskId ? taskSources : null
  const cacheScope = client.getCacheScope()
  const sourceIds = [...new Set(ids)].sort((a, b) => a - b)
  const sourceKey = JSON.stringify(sourceIds.map(id => [id, citationSources?.get(id)]))
  const workspaceId = workspace?.knowledgeBaseId
  const workspaceAccess = workspace?.access
  const scope = JSON.stringify([
    user?.id,
    cacheScope,
    taskId,
    answerId,
    generationId,
    workspaceId,
    workspace?.revision,
    sourceKey,
    enabled,
  ])
  const [state, setState] = useState<{
    scope: string
    access: SourceAccessMap
    answerDenied?: boolean
    unavailableCitations?: ReadonlySet<string>
    failed?: ReadonlySet<number>
    attempt?: number
  }>({ scope, access: unresolved })
  if (state.scope !== scope) setState({ scope, access: unresolved })
  const local = state.scope === scope ? state : undefined
  const sharedSourcesRef = useRef(sharedSources)
  sharedSourcesRef.current = sharedSources

  const taskReads = usePermissionReads(scope, id =>
    knowledgePermissionApi.getMyPermission(id, { taskId })
  )
  const answerReads = usePermissionReads(scope, (id, citationId) =>
    knowledgePermissionApi.getMyPermission(id, { taskId, answerId, citationId })
  )
  const attempt = local?.attempt ?? 0
  const sharedCheckVersion = sourceIds.map(id => sharedSources?.checked[id] ?? 0).join(',')

  useLayoutEffect(() => {
    if (!enabled || !user?.id) return
    let current = true
    const isCurrent = () => current && client.getCacheScope() === cacheScope
    const sources = JSON.parse(sourceKey) as [number, string | null][]
    for (const [id, citationId] of sources) {
      if (id === workspaceId) continue
      const retry = attempt > 0
      const request = sharedSourcesRef.current?.read(id, retry) ?? taskReads.read(id, retry)
      void request
        .then(permission => {
          if (!isCurrent() || !permission) return undefined
          if (
            permission.source_access === 'denied' &&
            !permission.task_source_bound &&
            answerId &&
            citationId
          ) {
            return answerReads.read(id, retry, citationId)
          }
          return permission
        })
        .then(
          permission => {
            if (!isCurrent() || !permission) return
            setState(previous => {
              if (previous.scope !== scope) return previous
              const failed = new Set(previous.failed)
              failed.delete(id)
              const access =
                isSourceHidden(previous.access[id]) && !retry
                  ? previous.access
                  : { ...previous.access, [id]: permission.source_access }
              return { ...previous, access, failed }
            })
          },
          () => {
            if (!isCurrent()) return
            setState(previous =>
              previous.scope === scope
                ? { ...previous, failed: new Set(previous.failed).add(id) }
                : previous
            )
          }
        )
    }
    return () => {
      current = false
    }
  }, [
    answerId,
    answerReads,
    attempt,
    cacheScope,
    enabled,
    scope,
    sharedCheckVersion,
    sourceKey,
    taskReads,
    user?.id,
    workspaceId,
  ])

  const answerAccess = {
    ...(workspaceId && workspaceAccess ? { [workspaceId]: workspaceAccess } : {}),
    ...local?.access,
  }
  const access = { ...answerAccess, ...sharedSources?.access }
  // A task-wide direct read decision cannot classify another answer's ask-only scope.
  for (const id of Object.keys(answerAccess).map(Number)) {
    if (access[id] === 'denied' && answerAccess[id] === 'visit-only') access[id] = 'visit-only'
  }
  const denySource = (id: number, result: SourceDenial = 'denied') => {
    if (workspaceId === id && workspace?.onDenied) {
      workspace.onDenied(result)
      return
    }
    sharedSources?.deny(id)
    taskReads.invalidate(id)
    answerReads.invalidate(id)
    setState(previous => {
      const latest = previous?.scope === scope ? previous : { scope, access: unresolved }
      return { ...latest, access: { ...latest.access, [id]: result } }
    })
  }
  const markUnavailable = (citationId: string) => {
    setState(previous =>
      previous.scope === scope
        ? {
            ...previous,
            unavailableCitations: new Set(previous.unavailableCitations).add(citationId),
          }
        : previous
    )
  }
  const denyAnswer = () => {
    setState({ scope, access: unresolved, answerDenied: true })
    if (taskId !== undefined) sharedSources?.onAnswerDenied?.(taskId)
  }

  const relevantSources = ids.length ? ids : workspaceId && useWorkspaceSource ? [workspaceId] : []
  const relevantAccess = relevantSources.map(id => access[id])
  return {
    access,
    relevantAccess,
    workspaceId,
    scope,
    denySource,
    denyAnswer,
    answerDenied: local?.answerDenied,
    unavailableCitations: local?.unavailableCitations,
    markUnavailable,
    permissionFailed: Boolean(local?.failed?.size),
    retryPermission: () =>
      setState(previous =>
        previous.scope === scope ? { ...previous, attempt: (previous.attempt ?? 0) + 1 } : previous
      ),
  }
}

export function isSourceHidden(access?: KnowledgeSourceAccess): boolean {
  return access === 'visit-only' || access === 'denied'
}

export function getAnswerSourceIds(
  sources: readonly SourceReference[],
  summary?: RetrievalSummaryPayload
): number[] {
  return [
    ...sources.flatMap(source => (source.kb_id ? [source.kb_id] : [])),
    ...(summary?.source_statuses ?? []).flatMap(status =>
      status.provider === 'internal' &&
      status.status === 'hit' &&
      /^[1-9]\d*$/.test(status.source_id)
        ? [Number(status.source_id)]
        : []
    ),
  ]
}

export function filterAnswerSources(
  sources: SourceReference[],
  summary: RetrievalSummaryPayload | undefined,
  access: SourceAccessMap,
  hasHiddenSources: boolean
) {
  const visibleSources = sources.filter(
    source => !source.kb_id || !isSourceHidden(access[source.kb_id])
  )
  if (!summary || !hasHiddenSources) {
    return { sources: visibleSources, retrievalSummary: summary }
  }

  // Untyped legacy summary IDs can collide with external provider IDs.
  const sourceStatuses = summary.source_statuses?.filter(
    status => status.provider !== 'internal' || !isSourceHidden(access[Number(status.source_id)])
  )
  return { sources: visibleSources, retrievalSummary: { source_statuses: sourceStatuses } }
}
