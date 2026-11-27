// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import {
  useCallback,
  createContext,
  createElement,
  useContext,
  useSyncExternalStore,
  useState,
  type SetStateAction,
  type ReactNode,
} from 'react'

import type { CollaborationPriority } from '../types'

export type IssueAssigneeTarget =
  | ''
  | `user:${number}`
  | `agent:${string}`
  | `resource:${string}`
  | `group:${string}`
  | `team:${number}`

export interface IssueDetailDraftSource<TWorkflow = unknown> {
  cloud_project_id?: string | number
  id: string
  version: number
  title: string
  description: string
  status: string
  priority: CollaborationPriority
  parent_id: string | null
  start_at?: string | null
  due_at: string | null
  tags: string[]
  assignee_user_id?: number | null
  assignee_agent_id?: string | null
  assignee_team_id?: number | null
  assignee_group_id?: string | null
  workflow?: TWorkflow | null
}

export interface IssueDetailDraftValue<TWorkflow = unknown> {
  title: string
  description: string
  status: string
  priority: CollaborationPriority
  parentId: string
  startDate: string
  dueDate: string
  tags: string[]
  assigneeTarget: IssueAssigneeTarget
  workflow: TWorkflow | null
}

export interface IssueDetailDraftInitial<TWorkflow = unknown> extends Partial<
  IssueDetailDraftValue<TWorkflow>
> {
  title: string
  description: string
  status: string
  priority: CollaborationPriority
}

export interface IssueDetailDraftOptions<TWorkflow = unknown> {
  source: IssueDetailDraftSource<TWorkflow> | null
  storage?: { key: string; milestoneId: string | null }
  allowedParentIds?: readonly string[]
  initial: IssueDetailDraftInitial<TWorkflow>
  normalizeDescription?: (description: string) => string
  startDateFromSource?: (startAt: string | null) => string
  dueDateFromSource?: (dueAt: string | null) => string
  pendingFields?: ReadonlySet<string>
}

type CachedIssueDraft = {
  source: IssueDetailDraftSource
  draft: IssueDetailDraftValue
}
const IssueDraftCacheContext = createContext<Map<string, CachedIssueDraft> | null>(null)

/** Keep draft data without keeping inactive editors, subscriptions or requests mounted. */
export function IssueDetailDraftProvider({
  scope,
  children,
}: {
  scope: unknown
  children: ReactNode
}) {
  const [owner, setOwner] = useState(() => ({
    scope,
    cache: new Map<string, CachedIssueDraft>(),
  }))
  if (!Object.is(owner.scope, scope)) {
    setOwner({ scope, cache: new Map<string, CachedIssueDraft>() })
  }
  return createElement(IssueDraftCacheContext.Provider, { value: owner.cache }, children)
}

export function issueAssigneeTarget(
  source: Pick<
    IssueDetailDraftSource,
    'assignee_user_id' | 'assignee_agent_id' | 'assignee_team_id' | 'assignee_group_id'
  >
): IssueAssigneeTarget {
  if (source.assignee_group_id) return `group:${source.assignee_group_id}`
  if (source.assignee_team_id) return `team:${source.assignee_team_id}`
  if (source.assignee_agent_id) return `agent:${source.assignee_agent_id}`
  if (source.assignee_user_id != null) return `user:${source.assignee_user_id}`
  return ''
}

export function parseIssueAssigneeTarget(target: IssueAssigneeTarget): {
  assigneeUserId: number | null
  assigneeAgentId: string | null
  assigneeTeamId: number | null
  assigneeGroupId?: string
} {
  return {
    assigneeUserId: target.startsWith('user:') ? Number(target.slice(5)) : null,
    assigneeAgentId: target.startsWith('agent:') ? target.slice(6) : null,
    assigneeTeamId: target.startsWith('team:') ? Number(target.slice(5)) : null,
    ...(target.startsWith('group:') ? { assigneeGroupId: target.slice(6) } : {}),
  }
}

function equalTags(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((tag, index) => tag === right[index])
}

function defaultDueDate(dueAt: string | null): string {
  return dueAt?.slice(0, 16) ?? ''
}

function identityDescription(description: string): string {
  return description
}

function draftFromSource<TWorkflow>(
  source: IssueDetailDraftSource<TWorkflow>,
  normalizeDescription: (description: string) => string,
  startDateFromSource: (startAt: string | null) => string,
  dueDateFromSource: (dueAt: string | null) => string
): IssueDetailDraftValue<TWorkflow> {
  return {
    title: source.title ?? '',
    description: normalizeDescription(source.description ?? ''),
    status: source.status ?? '',
    priority: source.priority ?? 'none',
    parentId: source.parent_id ?? '',
    startDate: startDateFromSource(source.start_at ?? null),
    dueDate: dueDateFromSource(source.due_at),
    tags: source.tags ?? [],
    assigneeTarget: issueAssigneeTarget(source),
    workflow: source.workflow ?? null,
  }
}

function mergeIssueDraft<TWorkflow>(
  current: IssueDetailDraftValue<TWorkflow>,
  previous: IssueDetailDraftValue<TWorkflow> | null,
  next: IssueDetailDraftValue<TWorkflow>,
  sameIssue: boolean,
  pendingFields: ReadonlySet<string> | undefined
): IssueDetailDraftValue<TWorkflow> {
  const merged = { ...current }
  const synchronize = <Field extends keyof IssueDetailDraftValue<TWorkflow>>(field: Field) => {
    const unchanged =
      field === 'tags'
        ? equalTags(current.tags, previous?.tags ?? [])
        : current[field] === previous?.[field]
    if (!sameIssue || (!pendingFields?.has(field) && unchanged)) merged[field] = next[field]
  }
  ;(Object.keys(next) as Array<keyof IssueDetailDraftValue<TWorkflow>>).forEach(synchronize)
  return merged
}

function createIssueDraftState<TWorkflow>(
  initialOptions: IssueDetailDraftOptions<TWorkflow>,
  cache: Map<string, CachedIssueDraft> | null,
  cacheKey: string | null
) {
  let options = initialOptions
  const cached = cacheKey ? cache?.get(cacheKey) : undefined
  let baseline = (cached?.source as IssueDetailDraftSource<TWorkflow> | undefined) ?? options.source
  const from = (source: IssueDetailDraftSource<TWorkflow>) =>
    draftFromSource(
      source,
      options.normalizeDescription ?? identityDescription,
      options.startDateFromSource ?? defaultDueDate,
      options.dueDateFromSource ?? defaultDueDate
    )
  const initial = options.initial
  const initialDraft: IssueDetailDraftValue<TWorkflow> = {
    title: initial.title,
    description: initial.description,
    status: initial.status,
    priority: initial.priority,
    parentId: initial.parentId ?? '',
    startDate: initial.startDate ?? '',
    dueDate: initial.dueDate ?? '',
    tags: initial.tags ?? [],
    assigneeTarget: initial.assigneeTarget ?? '',
    workflow: initial.workflow ?? null,
  }
  let draft: IssueDetailDraftValue<TWorkflow> = cached
    ? (cached.draft as IssueDetailDraftValue<TWorkflow>)
    : options.source
      ? from(options.source)
      : initialDraft
  const restoredContentDirty = Boolean(
    cached &&
    (cached.draft.title !== cached.source.title ||
      cached.draft.description !==
        (options.normalizeDescription ?? identityDescription)(cached.source.description ?? ''))
  )
  const dirty = () => {
    const source = options.source ? from(options.source) : initialDraft
    const title = options.source ? draft.title.trim() : draft.title
    return (
      title !== source.title ||
      draft.description !== source.description ||
      draft.status !== source.status ||
      draft.priority !== source.priority ||
      draft.parentId !== source.parentId ||
      draft.startDate !== source.startDate ||
      draft.dueDate !== source.dueDate ||
      !equalTags(draft.tags, source.tags) ||
      draft.assigneeTarget !== source.assigneeTarget ||
      JSON.stringify(draft.workflow) !== JSON.stringify(source.workflow)
    )
  }
  let snapshot = { draft, dirty: dirty(), restoredContentDirty }
  const listeners = new Set<() => void>()
  let stored: string | null | undefined
  const persist = () => {
    if (!options.source && options.storage) {
      const value =
        draft.title ||
        draft.description ||
        draft.priority !== 'none' ||
        draft.parentId ||
        draft.startDate ||
        draft.dueDate ||
        draft.assigneeTarget ||
        options.storage.milestoneId ||
        draft.tags.length
          ? JSON.stringify({
              title: draft.title,
              markdown: draft.description,
              milestoneId: options.storage.milestoneId,
              priority: draft.priority,
              parentId: draft.parentId,
              startDate: draft.startDate,
              dueDate: draft.dueDate,
              assigneeTarget: draft.assigneeTarget,
              tags: draft.tags,
            })
          : null
      if (stored !== value) {
        stored = value
        if (value === null) localStorage.removeItem(options.storage.key)
        else localStorage.setItem(options.storage.key, value)
      }
    }
    if (!cacheKey || !cache || !baseline) return
    if (JSON.stringify(from(baseline)) === JSON.stringify(draft)) cache.delete(cacheKey)
    else cache.set(cacheKey, { source: baseline, draft } as CachedIssueDraft)
  }
  const publish = () => {
    const nextDirty = dirty()
    if (snapshot.draft === draft && snapshot.dirty === nextDirty) return
    snapshot = { draft, dirty: nextDirty, restoredContentDirty }
    listeners.forEach(listener => listener())
  }
  const setDraft = (value: SetStateAction<IssueDetailDraftValue<TWorkflow>>) => {
    draft = typeof value === 'function' ? value(draft) : value
    persist()
    publish()
    return snapshot.dirty
  }
  return {
    getSnapshot: () => snapshot,
    getDraft: () => draft,
    subscribe(next: IssueDetailDraftOptions<TWorkflow>, listener: () => void) {
      options = next
      if (next.source && baseline !== next.source) {
        draft = mergeIssueDraft(
          draft,
          baseline ? from(baseline) : null,
          from(next.source),
          baseline?.id === next.source.id &&
            baseline.cloud_project_id === next.source.cloud_project_id,
          next.pendingFields
        )
        baseline = next.source
      }
      if (
        !next.source &&
        draft.parentId &&
        next.allowedParentIds?.length &&
        !next.allowedParentIds.includes(draft.parentId)
      )
        draft = { ...draft, parentId: '' }
      listeners.add(listener)
      persist()
      publish()
      return () => {
        listeners.delete(listener)
      }
    },
    setDraft,
    setField<K extends keyof IssueDetailDraftValue<TWorkflow>>(
      field: K,
      value: SetStateAction<IssueDetailDraftValue<TWorkflow>[K]>
    ) {
      return setDraft(current => ({
        ...current,
        [field]:
          typeof value === 'function'
            ? (
                value as (
                  previous: IssueDetailDraftValue<TWorkflow>[K]
                ) => IssueDetailDraftValue<TWorkflow>[K]
              )(current[field])
            : value,
      }))
    },
  }
}

export function useIssueDetailDraft<TWorkflow = unknown>(
  options: IssueDetailDraftOptions<TWorkflow>
) {
  const cache = useContext(IssueDraftCacheContext)
  const key = options.source
    ? JSON.stringify([options.source.cloud_project_id ?? null, options.source.id])
    : null
  const [owner, setOwner] = useState(() => ({
    cache,
    key,
    state: createIssueDraftState(options, cache, key),
  }))
  if (owner.cache !== cache || owner.key !== key)
    setOwner({ cache, key, state: createIssueDraftState(options, cache, key) })
  const state = owner.state
  const {
    source,
    storage,
    allowedParentIds,
    initial,
    pendingFields,
    normalizeDescription,
    startDateFromSource,
    dueDateFromSource,
  } = options
  const subscribe = useCallback(
    (listener: () => void) =>
      state.subscribe(
        {
          source,
          storage,
          allowedParentIds,
          initial,
          pendingFields,
          normalizeDescription,
          startDateFromSource,
          dueDateFromSource,
        },
        listener
      ),
    [
      state,
      source,
      storage,
      allowedParentIds,
      initial,
      pendingFields,
      normalizeDescription,
      startDateFromSource,
      dueDateFromSource,
    ]
  )
  const snapshot = useSyncExternalStore(subscribe, state.getSnapshot, state.getSnapshot)
  return {
    ...snapshot,
    setDraft: state.setDraft,
    setField: state.setField,
    getDraft: state.getDraft,
  }
}

export interface PersistIssueDetailDraftPort<TIssue> {
  update(
    issue: TIssue,
    draft: IssueDetailDraftValue,
    assignment: ReturnType<typeof parseIssueAssigneeTarget>
  ): Promise<TIssue>
  assign?(
    issue: TIssue,
    target: Exclude<IssueAssigneeTarget, ''>,
    notifyAssignee: boolean
  ): Promise<TIssue>
  clearAssignment?(issue: TIssue): Promise<TIssue>
  getAssigneeTarget(issue: TIssue): IssueAssigneeTarget
}

export async function persistIssueDetailDraft<TIssue>(
  issue: TIssue,
  draft: IssueDetailDraftValue,
  notifyAssignee: boolean,
  port: PersistIssueDetailDraftPort<TIssue>
): Promise<TIssue> {
  const updated = await port.update(issue, draft, parseIssueAssigneeTarget(draft.assigneeTarget))
  if (draft.assigneeTarget === port.getAssigneeTarget(issue)) return updated
  if (!draft.assigneeTarget) {
    return port.clearAssignment ? port.clearAssignment(updated) : updated
  }
  return port.assign ? port.assign(updated, draft.assigneeTarget, notifyAssignee) : updated
}
