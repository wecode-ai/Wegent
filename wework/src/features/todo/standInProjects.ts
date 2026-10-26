import type { CollaborationProject } from '@wegent/collaboration'
import type { StandInProjectRef } from '@/api/personalStandIn'

export function findStandInProject(projects: CollaborationProject[], reference: StandInProjectRef) {
  return projects.find(
    project =>
      project.id === reference.id &&
      (project.project_store === 'local' ? 'local' : 'cloud') === reference.store
  )
}
