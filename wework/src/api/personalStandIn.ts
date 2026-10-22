import type { WorkspaceStandInSettings, CollaborationProject } from '@wegent/collaboration'

export interface StandInProjectRef {
  id: string
  store: 'local' | 'cloud'
}

export interface StandInRole extends WorkspaceStandInSettings {
  id: string
  name: string
  agentResourceId?: number | null
  agentProject?: StandInProjectRef
  collaboration: {
    enabled: boolean
    allProjects: boolean
    projects: StandInProjectRef[]
    excludedProjects: StandInProjectRef[]
    tags: string[]
  }
}

export interface PersonalStandInSettings {
  userId: number
  executionDeviceId: string
  version: number
  selectionErrors?: { issueId: string; title: string; error: string }[]
  autoSelect: boolean
  roles: StandInRole[]
}

export interface PersonalStandInAgent {
  id: number
  name: string
}

export function newStandInRole(deviceId: string, id = crypto.randomUUID()): StandInRole {
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

export function standInRoleName(
  role: StandInRole,
  index: number,
  projects: CollaborationProject[],
  fallback: string
): string {
  if (role.name?.trim()) return role.name
  const scope =
    role.agentProject ??
    (!role.collaboration.allProjects && role.collaboration.projects.length === 1
      ? role.collaboration.projects[0]
      : undefined)
  const project =
    scope &&
    projects.find(
      project =>
        project.id === scope.id &&
        (project.project_store === 'local' ? 'local' : 'cloud') === scope.store
    )
  return project ? project.name : `${fallback}${index ? ` ${index + 1}` : ''}`
}

type SettingsListener = (settings: PersonalStandInSettings) => void
const listeners = new Set<SettingsListener>()

export function subscribePersonalStandIn(listener: SettingsListener) {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function publishPersonalStandIn(settings: PersonalStandInSettings) {
  for (const listener of listeners) listener(settings)
}
