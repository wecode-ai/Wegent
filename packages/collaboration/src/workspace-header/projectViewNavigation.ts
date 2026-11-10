export type CollaborationProjectView =
  | 'milestones'
  | 'board'
  | 'calendar'
  | 'gantt'
  | 'table'
  | 'files'
  | 'manage'

export type ProjectViewGroup = 'work' | 'plan' | 'admin'

export interface ProjectViewMetadata {
  group?: ProjectViewGroup
  parent?: 'timeline'
  oldTestIdAliases?: readonly string[]
}

export interface CollaborationProjectViewOption<
  View extends CollaborationProjectView = CollaborationProjectView,
> extends ProjectViewMetadata {
  id: View
  label: string
  testId: string
}

export type ProjectViewMetadataMap = Partial<
  Record<CollaborationProjectView, ProjectViewMetadata>
>

/** Opt-in metadata for hosts; omitting it preserves the existing navigation. */
export const groupedProjectViewMetadata = {
  board: { group: 'work' },
  calendar: { group: 'plan', parent: 'timeline' },
  gantt: { group: 'plan', parent: 'timeline' },
  milestones: { group: 'plan' },
  table: { group: 'plan' },
  files: { group: 'admin' },
  manage: { group: 'admin' },
} as const satisfies ProjectViewMetadataMap

const viewOrder: CollaborationProjectView[] = [
  'board',
  'gantt',
  'calendar',
  'milestones',
  'table',
  'files',
  'manage',
]

export interface ProjectViewEntry<
  View extends CollaborationProjectView = CollaborationProjectView,
> {
  id: View | 'timeline'
  option: CollaborationProjectViewOption<View>
  segments?: CollaborationProjectViewOption<View>[]
}

export interface ProjectViewNavigationGroup<
  View extends CollaborationProjectView = CollaborationProjectView,
> {
  id: ProjectViewGroup
  entries: ProjectViewEntry<View>[]
}

export function hasGroupedProjectViews(
  options: readonly CollaborationProjectViewOption[],
): boolean {
  return (
    options.length > 0 &&
    options.every((option) => {
      const expected = groupedProjectViewMetadata[option.id]
      return (
        expected &&
        option.group === expected.group &&
        option.parent === ('parent' in expected ? expected.parent : undefined)
      )
    })
  )
}

export function buildProjectViewNavigation<
  View extends CollaborationProjectView,
>(
  options: readonly CollaborationProjectViewOption<View>[],
): ProjectViewNavigationGroup<View>[] {
  if (!hasGroupedProjectViews(options)) return []
  const sorted = [...options].sort(
    (a, b) => viewOrder.indexOf(a.id) - viewOrder.indexOf(b.id),
  )
  return (['work', 'plan', 'admin'] as const).flatMap((id) => {
    const members = sorted.filter((option) => option.group === id)
    const segments = members.filter((option) => option.parent === 'timeline')
    const entries: ProjectViewEntry<View>[] = members
      .filter((option) => !option.parent)
      .map((option) => ({ id: option.id, option }))
    if (segments[0]) {
      entries.unshift({
        id: 'timeline',
        option: segments[0],
        segments: [...segments].reverse(),
      })
    }
    return entries.length ? [{ id, entries }] : []
  })
}

export function resolveGroupedProjectView<
  View extends CollaborationProjectView,
>(
  options: readonly CollaborationProjectViewOption<View>[],
  value: CollaborationProjectView,
): View | undefined {
  const exact = options.find((option) => option.id === value)
  if (exact) return exact.id
  const groups = buildProjectViewNavigation(options)
  const group = groups.find(
    (candidate) => candidate.id === groupedProjectViewMetadata[value]?.group,
  )
  return (
    group?.entries[0]?.option.id ??
    groups.find((candidate) => candidate.id === 'work')?.entries[0]?.option.id
  )
}

export interface ProjectViewSelection {
  planView: CollaborationProjectView
  timelineView?: CollaborationProjectView
}

/** Create once per authenticated host session; never persist this map. */
export function createProjectViewSelectionMemory() {
  return new Map<string, ProjectViewSelection>()
}

export type ProjectViewSelectionMemory = ReturnType<
  typeof createProjectViewSelectionMemory
>
