import type { WorkspaceStandInSettings } from '@wegent/collaboration'

export interface StandInProjectRef {
  id: string
  store: 'local' | 'cloud'
}

export interface StandInHandlingPolicy {
  automatic: boolean
  askBeforeAct: boolean
}

export interface StandInDingTalkConnection {
  id: string
  profile: string
  name: string
  kind: 'group' | 'direct'
  policy: StandInHandlingPolicy
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
  dingtalk?: StandInDingTalkConnection[]
  collaboration?: StandInRole['collaboration']
}

export interface StandInRole extends WorkspaceStandInSettings {
  id: string
  name: string
  agentResourceId?: number | null
  agentProject?: StandInProjectRef
  dingtalk?: StandInDingTalkConnection[]
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

export interface PersonalStandInAgent {
  id: number
  name: string
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
      policy: { automatic: true, askBeforeAct: true },
    },
  }
}

export function roleIncludesProject(role: StandInRole, project: StandInProjectRef): boolean {
  const matches = (value: StandInProjectRef) =>
    value.id === project.id && value.store === project.store
  return (
    role.collaboration.enabled &&
    !role.collaboration.excludedProjects.some(matches) &&
    (role.collaboration.allProjects || role.collaboration.projects.some(matches)) &&
    (!role.agentProject || matches(role.agentProject))
  )
}

export function standInRoleName(role: StandInRole, index: number, fallback: string): string {
  return role.name?.trim() || `${fallback}${index ? ` ${index + 1}` : ''}`
}

export function disconnectStandInProject(
  role: StandInRole,
  project: StandInProjectRef
): StandInRole {
  const matches = (value: StandInProjectRef) =>
    value.id === project.id && value.store === project.store
  if (role.agentProject && !matches(role.agentProject)) return role
  const source = role.collaboration
  const projects = source.projects.filter(value => !matches(value))
  const excludedProjects =
    source.allProjects && !source.excludedProjects.some(matches)
      ? [...source.excludedProjects, project]
      : source.excludedProjects
  const enabled = role.agentProject ? false : source.enabled
  if (
    projects.length === source.projects.length &&
    excludedProjects === source.excludedProjects &&
    enabled === source.enabled
  )
    return role
  return {
    ...role,
    collaboration: {
      ...source,
      enabled,
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
