import type { WorkspaceStandInSettings } from '@wegent/collaboration'

export interface StandInProjectRef {
  id: string
  store: 'local' | 'cloud'
}

export interface StandInHandlingPolicy {
  automatic: boolean
  askBeforeAct: boolean
  immediate?: boolean
  sessionStrategy?: 'independent' | 'reuse'
}

export interface StandInSourceConnection {
  providerId: string
  id: string
  profile: string
  name: string
  kind: string
  scope?: 'all'
  /** Plugin-owned collection configuration, separate from resource access identity. */
  collectionKey?: string
  configurationSummary?: string
  /** Git event source selected by the connection UI. */
  transport?: 'cli'
  policy: StandInHandlingPolicy
  /** Host-owned intake boundary, prepared when the subscription is enabled. */
  boundary?: { partition: string; sequence: number }
  /** Git repository webhook binding; credentials are never stored here. */
  subscriptionId?: string
  generation?: string
  resumePending?: boolean
  /** Draft-only takeover intent, consumed by the host during save. */
  pendingTakeover?: boolean
}

export interface StandInProjectPolicy extends StandInProjectRef {
  policy: StandInHandlingPolicy
}

export interface StandInIdentity extends Partial<
  Pick<WorkspaceStandInSettings, 'model' | 'modelOptions' | 'workspace'>
> {
  enabled: boolean
  prompt: string
  preferences: string
  calendar?: { policy: StandInHandlingPolicy }
  connections?: StandInSourceConnection[]
  collaboration?: StandInRole['collaboration']
}

export interface StandInRole extends WorkspaceStandInSettings {
  id: string
  name: string
  migrationSource?: string
  previousExecutionDevices?: string[]
  calendar?: { policy: StandInHandlingPolicy }
  connections?: StandInSourceConnection[]
  collaboration: {
    enabled: boolean
    allProjects: boolean
    projects: StandInProjectRef[]
    excludedProjects: StandInProjectRef[]
    tags: string[]
    policy?: StandInHandlingPolicy
    projectPolicies?: StandInProjectPolicy[]
  }
}

export interface PersonalStandInSettings {
  userId: number
  executionDeviceId: string
  version: number
  primary?: StandInIdentity
  roles: StandInRole[]
  lifecycle?: { status: 'stopping' | 'stopped' }
}

/** Explicitly connecting/enabling a source replaces the old second intake switch. */
export function connectionChangeEnablesIdentity(
  previous: Pick<StandInIdentity, 'connections' | 'calendar' | 'collaboration'>,
  next: Pick<StandInIdentity, 'connections' | 'calendar' | 'collaboration'>
): boolean {
  const key = (source: StandInSourceConnection) =>
    JSON.stringify([
      source.providerId,
      source.profile,
      source.kind,
      source.id,
      source.collectionKey,
    ])
  return Boolean(
    (next.collaboration?.enabled && !previous.collaboration?.enabled) ||
    (next.calendar && !previous.calendar) ||
    (next.calendar?.policy.automatic && !previous.calendar?.policy.automatic) ||
    next.connections?.some(source => {
      const old = previous.connections?.find(row => key(row) === key(source))
      return !old || (source.policy.automatic && !old.policy.automatic)
    })
  )
}

export function standInPolicy(
  role: StandInRole,
  project?: StandInProjectRef
): StandInHandlingPolicy {
  return (
    role.collaboration.projectPolicies?.find(
      row => row.id === project?.id && row.store === project.store
    )?.policy ??
    role.collaboration.policy ?? { automatic: role.enabled, askBeforeAct: false }
  )
}

export function standInConversationTaskId(userId: number, roleId?: string): string {
  return `stand-in-chat-${userId}-${roleId ? `role-${roleId}` : 'primary'}`
}

export function newStandInRole(deviceId: string, id: string = crypto.randomUUID()): StandInRole {
  return {
    id,
    name: '',
    enabled: false,
    prompt: '',
    executionDeviceId: deviceId,
    version: 0,
    collaboration: {
      enabled: false,
      allProjects: true,
      projects: [],
      excludedProjects: [],
      tags: [],
      policy: { automatic: true, askBeforeAct: true, immediate: true },
    },
  }
}

export function roleIncludesProject(
  role: Pick<StandInRole, 'collaboration'>,
  project: StandInProjectRef
): boolean {
  return role.collaboration.enabled && roleSelectsProject(role, project)
}

/** Check the saved project scope and exclusions independently of source enablement. */
export function roleSelectsProject(
  role: Pick<StandInRole, 'collaboration'>,
  project: StandInProjectRef
): boolean {
  const matches = (value: StandInProjectRef) =>
    value.id === project.id && value.store === project.store
  return (
    !role.collaboration.excludedProjects.some(matches) &&
    (role.collaboration.allProjects || role.collaboration.projects.some(matches))
  )
}

export function standInRoleName(role: StandInRole, index: number, fallback: string): string {
  return role.name?.trim() || `${fallback}${index ? ` ${index + 1}` : ''}`
}

/** Remove one project from the saved scope while retaining all other grants and switches. */
export function disconnectStandInProject(
  role: StandInRole,
  project: StandInProjectRef
): StandInRole {
  const matches = (value: StandInProjectRef) =>
    value.id === project.id && value.store === project.store
  const source = role.collaboration
  const projects = source.projects.filter(value => !matches(value))
  const excludedProjects =
    source.allProjects && !source.excludedProjects.some(matches)
      ? [...source.excludedProjects, project]
      : source.excludedProjects
  if (projects.length === source.projects.length && excludedProjects === source.excludedProjects)
    return role
  return {
    ...role,
    collaboration: {
      ...source,
      projects,
      excludedProjects,
    },
  }
}

type SettingsListener = (settings: PersonalStandInSettings) => void
const listeners = new Set<SettingsListener>()

export function subscribePersonalStandIn(listener: SettingsListener) {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function publishPersonalStandIn(settings: PersonalStandInSettings) {
  for (const listener of listeners) listener(settings)
}
