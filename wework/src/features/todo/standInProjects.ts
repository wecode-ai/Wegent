import type { CollaborationProject } from '@wegent/collaboration'
import { dequal } from 'dequal'
import type { StandInProjectRef, StandInRole } from '@/api/personalStandIn'

export type ProjectSource = StandInRole['collaboration']

export function projectRefKey(ref: StandInProjectRef) {
  return `${ref.store}:${ref.id}`
}

export function hasAllCollaborationSources(source: ProjectSource): boolean {
  return (
    source.allProjects &&
    !source.excludedProjects.length &&
    source.includeParticipatingIssues === true &&
    source.includeIndependentIssues === true &&
    (source.projectTrigger ?? 'both') === 'both' &&
    (source.participatingTrigger ?? 'both') === 'both'
  )
}

/** Newly created legacy roles could have an all-projects default before any intake was set up. */
export function effectiveProjectSource(source: ProjectSource): ProjectSource {
  return !source.enabled &&
    source.allProjects &&
    !source.projects.length &&
    !source.excludedProjects.length &&
    !source.includeIndependentIssues &&
    !source.includeParticipatingIssues
    ? { ...source, allProjects: false }
    : source
}

function comparableSource(source: ProjectSource) {
  const byReference = (a: StandInProjectRef, b: StandInProjectRef) =>
    projectRefKey(a).localeCompare(projectRefKey(b))
  return {
    ...effectiveProjectSource(source),
    includeParticipatingIssues: Boolean(source.includeParticipatingIssues),
    includeIndependentIssues: Boolean(source.includeIndependentIssues),
    projectTrigger: source.projectTrigger ?? 'both',
    participatingTrigger: source.participatingTrigger ?? 'both',
    projects: [...source.projects].sort(byReference),
    excludedProjects: [...source.excludedProjects].sort(byReference),
    projectPolicies: [...(source.projectPolicies ?? [])].sort(byReference),
    tags: [...source.tags].sort(),
    tagFilters: {
      projects: [...(source.tagFilters?.projects ?? source.tags)].sort(),
      participating: [...(source.tagFilters?.participating ?? source.tags)].sort(),
      independent: [...(source.tagFilters?.independent ?? source.tags)].sort(),
    },
  }
}

export function updateProjectSource(
  source: ProjectSource,
  patch: Partial<ProjectSource>,
  saved?: ProjectSource
) {
  const next = { ...effectiveProjectSource(source), ...patch }
  next.enabled = Boolean(
    next.allProjects ||
    next.projects.length ||
    next.includeIndependentIssues ||
    next.includeParticipatingIssues
  )
  return saved && dequal(comparableSource(next), comparableSource(saved)) ? saved : next
}

export function findStandInProject(projects: CollaborationProject[], reference: StandInProjectRef) {
  return projects.find(
    project =>
      project.id === reference.id &&
      (project.project_store === 'local' ? 'local' : 'cloud') === reference.store
  )
}
