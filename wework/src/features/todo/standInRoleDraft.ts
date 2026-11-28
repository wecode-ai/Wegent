import {
  newStandInRole,
  type PersonalStandInSettings,
  type StandInProjectRef,
} from '@/api/personalStandIn'

export interface InitialStandInRoleRequest {
  project?: StandInProjectRef
  projectRoleName?: string
}

/** Invoke only for an explicit creation action or an actively observed ready source. */
export function createStandInRoleDraft(
  current: PersonalStandInSettings,
  request: InitialStandInRoleRequest
) {
  const role = newStandInRole(current.executionDeviceId)
  role.enabled = true
  if (request.project) {
    role.name = request.projectRoleName ?? ''
    role.collaboration = {
      ...role.collaboration,
      enabled: true,
      allProjects: false,
      projects: [request.project],
    }
  }
  return { draft: { ...current, roles: [...current.roles, role] }, role }
}

export function editedReferencedTeam(
  previous: { teamRef?: string | null; name?: string; prompt: string } | undefined,
  next: { name?: string; prompt: string }
) {
  return Boolean(
    previous?.teamRef?.startsWith('LA-') &&
    (previous.prompt !== next.prompt || previous.name !== next.name)
  )
}
