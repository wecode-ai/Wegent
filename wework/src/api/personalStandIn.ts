import type { WorkspaceStandInSettings } from '@wegent/collaboration'
import type {
  RuntimeCommandApprovalMode,
  RuntimePermissionMode,
} from '@wegent/chat-core/runtime-permission'

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
  /** Resources excluded from this account and kind's continuous intake. */
  excludedResources?: { id: string; name: string }[]
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

export interface StandInTaskPermissions {
  permissionMode: RuntimePermissionMode
  commandApproval?: RuntimeCommandApprovalMode
}

export interface StandInIdentity extends Partial<
  Pick<WorkspaceStandInSettings, 'model' | 'modelOptions' | 'workspace'>
> {
  enabled: boolean
  selfLearningEnabled?: boolean
  prompt: string
  preferences: string
  taskPermissions?: StandInTaskPermissions
  calendar?: { policy: StandInHandlingPolicy }
  connections?: StandInSourceConnection[]
  collaboration?: StandInRole['collaboration']
}

export interface StandInRole extends WorkspaceStandInSettings {
  id: string
  selfLearningEnabled?: boolean
  name: string
  taskPermissions?: StandInTaskPermissions
  migrationSource?: string
  previousExecutionDevices?: string[]
  calendar?: { policy: StandInHandlingPolicy }
  connections?: StandInSourceConnection[]
  collaboration: {
    enabled: boolean
    allProjects: boolean
    includeIndependentIssues?: boolean
    includeParticipatingIssues?: boolean
    projects: StandInProjectRef[]
    excludedProjects: StandInProjectRef[]
    tags: string[]
    policy?: StandInHandlingPolicy
    projectPolicies?: StandInProjectPolicy[]
  }
}

export type StandInDelegationRoute = Pick<
  StandInRole,
  'id' | 'name' | 'prompt' | 'enabled' | 'executionDeviceId'
>

export interface StandInTeam {
  id: string
  name: string
  leadId: string
  members: Record<string, string>
  memberRoutes?: Record<string, Pick<StandInRole, 'executionDeviceId' | 'name'>>
}

export type StandInShareDefinition =
  | { kind: 'assistant'; definition: { id: string; name: string; prompt: string } }
  | { kind: 'team'; definition: Pick<StandInTeam, 'id' | 'name' | 'leadId' | 'members'> }

export interface StandInShareEntry {
  owner_user_id: number
  owner_name: string
  recipient_user_id: number
  recipient_name: string
  resource_kind: StandInShareDefinition['kind']
  source_id: string
  name: string
  revision: number
  local_revision?: number | null
  allow_copy: boolean
  direct_enabled: boolean
  revoked: boolean
  derived?: boolean
}

export interface StandInSharePublish {
  recipient_user_id: number
  allow_copy: boolean
  root: StandInShareDefinition
  assistants?: StandInShareDefinition[]
  base_revisions?: Record<string, number>
}

export interface StandInShareApi {
  list(
    userId: number,
    deviceId: string
  ): Promise<{
    received: StandInShareEntry[]
    sent: StandInShareEntry[]
    publication_revisions: Record<string, number>
  }>
  searchUsers(
    userId: number,
    deviceId: string,
    query: string
  ): Promise<{ users: { id: number; user_name: string }[] }>
  definition(
    userId: number,
    deviceId: string,
    kind: StandInShareDefinition['kind'],
    id: string
  ): Promise<StandInShareDefinition>
  publish(userId: number, deviceId: string, share: StandInSharePublish): Promise<void>
  direct(userId: number, deviceId: string, share: StandInShareEntry): Promise<void>
  revoke(userId: number, deviceId: string, share: StandInShareEntry): Promise<void>
  copy(
    userId: number,
    deviceId: string,
    share: StandInShareEntry,
    update?: boolean
  ): Promise<PersonalStandInSettings>
}

export type StandInConversationScope =
  | 'collaboration'
  | `team:${string}`
  | `shared:${number}:${StandInShareDefinition['kind']}:${string}`

export interface PersonalStandInSettings {
  userId: number
  executionDeviceId: string
  version: number
  primary?: StandInIdentity
  roles: StandInRole[]
  teams?: StandInTeam[]
  delegationRoutes?: StandInDelegationRoute[]
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
  role: Pick<StandInRole, 'collaboration' | 'enabled'>,
  project?: StandInProjectRef
): StandInHandlingPolicy {
  return (
    role.collaboration.projectPolicies?.find(
      row => row.id === project?.id && row.store === project.store
    )?.policy ??
    role.collaboration.policy ?? { automatic: role.enabled, askBeforeAct: false }
  )
}

export function standInConversationTaskId(
  userId: number,
  roleId?: string,
  scope?: StandInConversationScope
): string {
  if (scope?.startsWith('shared:')) {
    return `stand-in-shared-chat-${userId}-${scope.slice(7).replaceAll(':', '-')}`
  }
  if (scope?.startsWith('team:')) {
    return `stand-in-team-chat-${userId}-${scope.slice(5)}-${roleId ?? '@primary'}`
  }
  return `stand-in-chat-${userId}-${roleId ? `role-${roleId}` : 'primary'}${scope ? `-${scope}` : ''}`
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

/** Primary setup starts without a selected source until the user chooses its scope. */
export function newStandInPrimaryRole(deviceId: string): StandInRole {
  const role = newStandInRole(deviceId, '@primary')
  return {
    ...role,
    collaboration: {
      ...role.collaboration,
      allProjects: false,
      policy: { automatic: true, askBeforeAct: true, immediate: false },
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
