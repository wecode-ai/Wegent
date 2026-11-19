// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import type { SharedWorkspaceApi, WorkspaceBoardSnapshot } from '../ports/SharedWorkspaceApi'
import type { CollaborationProject, CollaborationIssue } from '../types'
export const externalGitBoardStatuses = [
  'inbox',
  'pending',
  'in_progress',
  'in_review',
  'completed',
] as const
export const defaultExternalGitBoardPageSize = 100

export function isExternalGitProject(project: CollaborationProject): boolean {
  return project.task_provider === 'github' || project.task_provider === 'gitlab'
}

export function canPreloadHomeSnapshot(project: CollaborationProject): boolean {
  return project.task_provider !== 'dingtalk_aitable'
}

export async function loadExternalGitStatusPages(
  api: SharedWorkspaceApi,
  projectId: string,
  status: string,
  options: {
    parentId: string | null
    pageSize: number
    eager: boolean
    isCurrent?(): boolean
  }
): Promise<{
  items: CollaborationIssue[]
  taskBindings: WorkspaceBoardSnapshot['taskBindings']
  nextCursor: string | null
}> {
  const items: CollaborationIssue[] = []
  const taskBindings: WorkspaceBoardSnapshot['taskBindings'] = []
  const seenCursors = new Set<string>()
  let cursor: string | null = null

  do {
    const page = await api.issues.listPage(projectId, {
      status,
      parentId: options.parentId,
      cursor,
      limit: options.pageSize,
    })
    if (options.isCurrent && !options.isCurrent()) return { items, taskBindings, nextCursor: null }
    items.push(...page.items)
    taskBindings.push(...page.taskBindings)

    const nextCursor = page.nextCursor
    if (!options.eager || !nextCursor || seenCursors.has(nextCursor)) {
      return { items, taskBindings, nextCursor }
    }
    seenCursors.add(nextCursor)
    cursor = nextCursor
  } while (cursor)

  return { items, taskBindings, nextCursor: null }
}

export async function loadExternalGitBoardSnapshot(
  api: SharedWorkspaceApi,
  projectId: string,
  options: {
    parentId: string | null
    pageSize: number
    eager: boolean
    isCurrent?(): boolean
  },
  previousSnapshot?: WorkspaceBoardSnapshot | null
): Promise<{
  snapshot: WorkspaceBoardSnapshot
  pageCursors: Record<string, string | null>
}> {
  const [pages, members, agents] = await Promise.all([
    Promise.all(
      externalGitBoardStatuses.map(status =>
        loadExternalGitStatusPages(api, projectId, status, options)
      )
    ),
    api.members.list(projectId),
    api.agents.list(projectId),
  ])

  const retainedItems = (previousSnapshot?.items ?? []).filter(
    item => item.parent_id !== options.parentId
  )
  const retainedItemIds = new Set(retainedItems.map(item => item.id))
  const retainedBindings = (previousSnapshot?.taskBindings ?? []).filter(
    binding => binding.issueId && retainedItemIds.has(binding.issueId)
  )
  return {
    snapshot: {
      items: [...retainedItems, ...pages.flatMap(page => page.items)],
      members,
      agents,
      taskBindings: [...retainedBindings, ...pages.flatMap(page => page.taskBindings)],
    },
    pageCursors: Object.fromEntries(
      pages.map((page, index) => [externalGitBoardStatuses[index], page.nextCursor])
    ),
  }
}
