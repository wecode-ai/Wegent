import type { CollaborationProject } from '@wegent/collaboration'
import { dequal } from 'dequal'
import type { StandInProjectRef, StandInProjectScopeKind, StandInRole } from '@/api/personalStandIn'

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
  const filters = new Map(source.projectTagFilters?.map(row => [projectRefKey(row), row.tags]))
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
    projectTagFilters: source.allProjects
      ? [...(source.projectTagFilters ?? [])]
          .sort(byReference)
          .map(row => ({ ...row, tags: [...row.tags].sort() }))
      : source.projects
          .slice()
          .sort(byReference)
          .map(ref => ({
            ...ref,
            tags: [
              ...(filters.get(projectRefKey(ref)) ?? source.tagFilters?.projects ?? source.tags),
            ].sort(),
          })),
  }
}

export function updateProjectSource(
  source: ProjectSource,
  patch: Partial<ProjectSource>,
  saved?: ProjectSource
) {
  const current = effectiveProjectSource(source)
  const next = { ...current, ...patch }
  const clearInheritedTags = (scope: StandInProjectScopeKind) => {
    if ((next.tagFilters?.[scope] ?? next.tags).length) {
      next.tagFilters = { ...next.tagFilters, [scope]: [] }
    }
  }
  if (next.allProjects && !current.allProjects) {
    clearInheritedTags('projects')
  }
  if (next.includeParticipatingIssues && !current.includeParticipatingIssues) {
    clearInheritedTags('participating')
  }
  if (next.includeIndependentIssues && !current.includeIndependentIssues) {
    clearInheritedTags('independent')
  }
  if (patch.projects || patch.excludedProjects || next.allProjects !== current.allProjects) {
    const previousKeys = new Set(current.projects.map(projectRefKey))
    const filters = new Map(current.projectTagFilters?.map(row => [projectRefKey(row), row]))
    const excluded = new Set(next.excludedProjects.map(projectRefKey))
    const inheritsTags = (next.tagFilters?.projects ?? next.tags).length > 0
    const oldDefault = current.tagFilters?.projects ?? current.tags
    const projectTagFilters = next.allProjects
      ? (current.allProjects
          ? [...filters.values()]
          : current.projects.flatMap(ref => {
              const filter = filters.get(projectRefKey(ref))
              if (filter) return [filter]
              return oldDefault.length ? [{ ...ref, tags: oldDefault }] : []
            })
        ).filter(row => !excluded.has(projectRefKey(row)))
      : next.projects.flatMap(ref => {
          const key = projectRefKey(ref)
          const previous = filters.get(key)
          if (previous && previousKeys.has(key)) return [previous]
          return inheritsTags && !previousKeys.has(key) ? [{ ...ref, tags: [] }] : []
        })
    next.projectTagFilters = projectTagFilters.length ? projectTagFilters : undefined
  }
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
