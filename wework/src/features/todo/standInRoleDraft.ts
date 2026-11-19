import {
  newStandInRole,
  standInRoleName,
  type PersonalStandInSettings,
  type StandInProjectRef,
} from '@/api/personalStandIn'

export interface InitialStandInRoleRequest {
  defaultRoleName: string
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
  const roles = current.roles.map((row, index) =>
    row.name ? row : { ...row, name: standInRoleName(row, index, request.defaultRoleName) }
  )
  return { draft: { ...current, roles: [...roles, role] }, role }
}
