// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

export interface WorkspaceHomeProject {
  id: string
  project_key: string
  name: string
  description: string
  project_store: 'local' | 'backend'
  location: 'local' | 'cloud'
  updated_at: string
}

export interface WorkspaceHomeItem {
  id: string
  title: string
  status: string
  assignee_user_id: number | null
  created_by_user_id: number
  created_by_user_name?: string | null
  created_at: string
  updated_at: string
  completed_at: string | null
}

export interface WorkspaceHomeMyWorkItem extends WorkspaceHomeItem {
  project_key: string
}

export interface WorkspaceHomeMember {
  user_id: number
  user_name: string
}

export interface WorkspaceHomeItemEntry<Item extends WorkspaceHomeItem> {
  item: Item
  spaceKey: string
}

export interface WorkspaceHomeStats {
  projectCount: number
  itemCount: number
  completedCount: number
  weeklyNewCount: number
  weeklyCompletedCount: number
  inProgressCount: number
}

export interface WorkspaceHomeSnapshot<
  Project extends WorkspaceHomeProject,
  Item extends WorkspaceHomeItem,
  MyWorkItem extends WorkspaceHomeMyWorkItem,
> {
  stats: WorkspaceHomeStats
  recentActivity: Array<WorkspaceHomeItemEntry<Item>>
  myTodos: MyWorkItem[]
  sortedProjects: Project[]
  projectByKey: Map<string, Project>
}

const MAX_RECENT_ACTIVITY = 5
const MAX_MY_TODOS = 5
const WEEK_MS = 7 * 86_400_000

export function workspaceProjectKey(
  project: Pick<WorkspaceHomeProject, 'id' | 'project_store'>
): string {
  return `${project.project_store}:${project.id}`
}

export function isWorkspaceTimestampWithinLastWeek(
  timestamp: string | null | undefined,
  nowMs: number
): boolean {
  if (!timestamp) return false
  const valueMs = new Date(timestamp).getTime()
  return !Number.isNaN(valueMs) && valueMs >= nowMs - WEEK_MS
}

export function workspaceProjectMatchesQuery(
  project: Pick<WorkspaceHomeProject, 'name'>,
  query: string
): boolean {
  return !query || project.name.toLowerCase().includes(query.trim().toLowerCase())
}

export function createWorkspaceHomeSnapshot<
  Project extends WorkspaceHomeProject,
  Item extends WorkspaceHomeItem,
  MyWorkItem extends WorkspaceHomeMyWorkItem,
>({
  projects,
  projectItems,
  myWork,
  searchQuery,
  nowMs,
}: {
  projects: Project[]
  projectItems: Record<string, Item[]>
  myWork: MyWorkItem[]
  searchQuery: string
  nowMs: number
}): WorkspaceHomeSnapshot<Project, Item, MyWorkItem> {
  const visibleProjects = projects.filter(project =>
    workspaceProjectMatchesQuery(project, searchQuery)
  )
  const allItemEntries = Object.entries(projectItems).flatMap(([spaceKey, items]) =>
    items.map(item => ({ item, spaceKey }))
  )
  const allItems = allItemEntries.map(entry => entry.item)

  return {
    stats: {
      projectCount: projects.length,
      itemCount: allItems.length,
      completedCount: allItems.filter(item => item.status === 'completed').length,
      weeklyNewCount: allItems.filter(item =>
        isWorkspaceTimestampWithinLastWeek(item.created_at, nowMs)
      ).length,
      weeklyCompletedCount: allItems.filter(
        item =>
          item.status === 'completed' &&
          isWorkspaceTimestampWithinLastWeek(item.completed_at, nowMs)
      ).length,
      inProgressCount: allItems.filter(item => item.status === 'in_progress').length,
    },
    recentActivity: [...allItemEntries]
      .sort((left, right) => right.item.updated_at.localeCompare(left.item.updated_at))
      .slice(0, MAX_RECENT_ACTIVITY),
    myTodos: myWork.filter(item => item.status !== 'completed').slice(0, MAX_MY_TODOS),
    sortedProjects: [...visibleProjects].sort((left, right) =>
      right.updated_at.localeCompare(left.updated_at)
    ),
    projectByKey: new Map(projects.map(project => [workspaceProjectKey(project), project])),
  }
}
