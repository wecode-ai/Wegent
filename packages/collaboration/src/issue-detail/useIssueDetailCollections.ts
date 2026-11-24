import { useCallback, useMemo, useSyncExternalStore, type SetStateAction } from 'react'
import type { TodoEditorProps, SharedEditorTeam } from './issueEditorSupport'
import type { CollaborationAttachment, CollaborationGroup, CollaborationMember } from '../types'
import type {
  SharedIssueDetailAgent,
  SharedIssueDetailCollaborator,
  SharedIssueDetailDelivery,
  SharedIssueDetailDeliveryDetail,
  SharedIssueDetailTaskBinding,
} from './createSharedIssueDetailPort'

type Port = TodoEditorProps['port']
interface Collections {
  deliveries: SharedIssueDetailDelivery[]
  selectedDelivery: SharedIssueDetailDeliveryDetail | null
  tasks: SharedIssueDetailTaskBinding[]
  attachments: CollaborationAttachment[]
  collaborators: SharedIssueDetailCollaborator[]
  projectMembers: CollaborationMember[]
  projectAgents: SharedIssueDetailAgent[]
  projectGroups: CollaborationGroup[]
  wegentTeams: SharedEditorTeam[]
}
interface Observation {
  invitedOnly: boolean
  scope: string
  groups: CollaborationGroup[] | undefined
  initialTasks: SharedIssueDetailTaskBinding[] | undefined
  currentDeliveryId: string | null | undefined
  assignee: string | null | undefined
  refreshKey: string | number | undefined
  loadTeams: TodoEditorProps['loadTeams']
}
const mergeGroups = (...groups: CollaborationGroup[][]) => [
  ...new Map(groups.flat().map(group => [group.id, group])).values(),
]

function createCollections(
  port: Port,
  issueId: string | null,
  projectId: string | null,
  initial: Observation
) {
  let snapshot: Collections = {
    deliveries: [],
    selectedDelivery: null,
    tasks: initial.initialTasks ?? [],
    attachments: [],
    collaborators: [],
    projectMembers: [],
    projectAgents: [],
    projectGroups: initial.invitedOnly ? [] : (initial.groups ?? []),
    wegentTeams: [],
  }
  const listeners = new Set<() => void>()
  let observation = initial
  let started = false
  let lifetime = 0
  const revisions = new Map<keyof Collections | 'currentDelivery', number>()
  const update = <K extends keyof Collections>(key: K, value: SetStateAction<Collections[K]>) => {
    snapshot = {
      ...snapshot,
      [key]:
        typeof value === 'function'
          ? (value as (current: Collections[K]) => Collections[K])(snapshot[key])
          : value,
    }
    for (const listener of listeners) listener()
  }
  const load = async <T>(
    key: keyof Collections | 'currentDelivery',
    read: () => Promise<T>,
    apply: (value: T) => void
  ) => {
    if (!listeners.size) return
    const owner = lifetime
    const revision = (revisions.get(key) ?? 0) + 1
    revisions.set(key, revision)
    try {
      const result = await read()
      if (listeners.size && owner === lifetime && revisions.get(key) === revision) apply(result)
    } catch {
      // Detail sources remain independent and retain already available data.
    }
  }
  const refreshTasks = async () => {
    if (issueId)
      await load(
        'tasks',
        () => port.taskBindings.list(issueId, projectId),
        tasks => update('tasks', tasks.length ? tasks : (observation.initialTasks ?? tasks))
      )
  }
  const refreshAttachments = async () => {
    if (issueId)
      await load(
        'attachments',
        () => port.attachments.list(issueId),
        rows => update('attachments', rows)
      )
  }
  const refreshDeliveries = async () => {
    if (issueId)
      await load(
        'deliveries',
        () => port.deliveries.list(issueId),
        rows =>
          update('deliveries', current => {
            const existing = current.find(row => row.id === observation.currentDeliveryId)
            return existing && !rows.some(row => row.id === existing.id)
              ? [existing, ...rows]
              : rows
          })
      )
  }
  const hydrateCurrentDelivery = () => {
    const id = observation.currentDeliveryId
    revisions.set('currentDelivery', (revisions.get('currentDelivery') ?? 0) + 1)
    if (issueId && id)
      void load(
        'currentDelivery',
        () => port.deliveries.get(id),
        delivery =>
          update('deliveries', rows => [delivery, ...rows.filter(row => row.id !== delivery.id)])
      )
  }
  const refresh = () => {
    if (issueId) {
      void refreshAttachments()
      void load(
        'collaborators',
        () => port.collaborators.list(issueId),
        rows => update('collaborators', rows)
      )
    }
    void refreshTasks()
    if (!observation.invitedOnly && (projectId || issueId)) {
      void load(
        'projectMembers',
        () => port.members.list(projectId ?? ''),
        rows => update('projectMembers', rows)
      )
    }
    if (!projectId) return
    void refreshDeliveries()
    if (observation.invitedOnly) return
    void load(
      'projectAgents',
      () => port.agents.list(projectId),
      rows =>
        update(
          'projectAgents',
          rows.filter(row => row.status !== 'inactive')
        )
    )
    void load(
      'projectGroups',
      () => port.collaborationGroups.list(projectId),
      rows => update('projectGroups', mergeGroups(observation.groups ?? [], rows))
    )
    void load(
      'wegentTeams',
      () => observation.loadTeams?.() ?? Promise.resolve([]),
      rows =>
        update(
          'wegentTeams',
          rows.filter(row => row.is_active !== false)
        )
    )
  }
  return {
    scope: initial.scope,
    getOwner: () => lifetime,
    isActive: (owner = lifetime) => listeners.size > 0 && owner === lifetime,
    getSnapshot: () => snapshot,
    subscribe(next: Observation, listener: () => void) {
      const previous = observation
      observation = next
      listeners.add(listener)
      if (next.initialTasks?.length && !snapshot.tasks.length) update('tasks', next.initialTasks)
      if (
        !started ||
        previous.groups !== next.groups ||
        previous.assignee !== next.assignee ||
        previous.refreshKey !== next.refreshKey ||
        previous.loadTeams !== next.loadTeams
      ) {
        if (!next.invitedOnly && next.groups?.length)
          update('projectGroups', mergeGroups(snapshot.projectGroups, next.groups))
        refresh()
      }
      if (!started || previous.currentDeliveryId !== next.currentDeliveryId)
        hydrateCurrentDelivery()
      started = true
      return () => {
        listeners.delete(listener)
        queueMicrotask(() => {
          if (!listeners.size) {
            lifetime++
            started = false
          }
        })
      }
    },
    invalidateAttachments: () =>
      revisions.set('attachments', (revisions.get('attachments') ?? 0) + 1),
    refreshTaskBindings: refreshTasks,
    refreshAttachments,
    refreshDeliveries,
    refreshExecutionArtifacts: async () => {
      await Promise.all([refreshTasks(), refreshDeliveries()])
    },
    setDeliveries: (value: SetStateAction<Collections['deliveries']>) =>
      update('deliveries', value),
    setSelectedDelivery: (value: SetStateAction<Collections['selectedDelivery']>) =>
      update('selectedDelivery', value),
    setTasks: (value: SetStateAction<Collections['tasks']>) => update('tasks', value),
    setAttachments: (value: SetStateAction<Collections['attachments']>) =>
      update('attachments', value),
    setCollaborators: (value: SetStateAction<Collections['collaborators']>) =>
      update('collaborators', value),
    openDelivery: async (id: string) => {
      if (issueId)
        await load(
          'selectedDelivery',
          () => port.deliveries.get(id),
          value => update('selectedDelivery', value)
        )
    },
  }
}

export function useIssueDetailCollections(props: TodoEditorProps) {
  const item = props.mode === 'edit' ? props.item : null
  const project = props.project
  const projectId = String(project?.id ?? item?.cloud_project_id ?? '') || null
  const issueId = item?.id ?? null
  const scope = JSON.stringify([
    project?.project_store,
    projectId,
    issueId,
    props.currentUserId ?? project?.current_user_id,
    project?.access_role,
    item?.can_view_detail,
    item?.invited_only,
  ])
  const { initialTaskBindings: initialTasks, loadTeams, taskRefreshKey: refreshKey } = props
  const invitedOnly = item?.invited_only === true
  const groups = project?.collaboration_groups
  const currentDeliveryId = item?.current_delivery_id
  const assignee = item?.assignee_agent_id
  const source = useMemo(
    () =>
      createCollections(props.port, issueId, projectId, {
        scope,
        invitedOnly,
        groups: undefined,
        initialTasks: undefined,
        currentDeliveryId: undefined,
        assignee: undefined,
        refreshKey: undefined,
        loadTeams: undefined,
      }),
    [props.port, issueId, projectId, scope, invitedOnly]
  )
  const subscribe = useCallback(
    (listener: () => void) =>
      source.subscribe(
        {
          scope,
          invitedOnly,
          groups,
          initialTasks,
          currentDeliveryId,
          assignee,
          refreshKey,
          loadTeams,
        },
        listener
      ),
    [
      source,
      scope,
      invitedOnly,
      groups,
      initialTasks,
      currentDeliveryId,
      assignee,
      refreshKey,
      loadTeams,
    ]
  )
  const snapshot = useSyncExternalStore(subscribe, source.getSnapshot, source.getSnapshot)
  return { ...snapshot, ...source }
}
