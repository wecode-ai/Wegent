// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import {
  collaborationMessages,
  localizeStandardStatuses,
  type CollaborationTranslate,
} from './i18n'

import type { CollaborationIssue, CollaborationProject, CollaborationStatus } from './types'

export const THREAD_STATUS_IDS = [
  'inbox',
  'pending',
  'in_progress',
  'in_review',
  'completed',
] as const

export function isThreadStatus(value: string): boolean {
  return THREAD_STATUS_IDS.some(status => status === value)
}

export interface CollaborationBoardGroup {
  id: string
  label: string
  color?: CollaborationStatus['color']
  issues: CollaborationIssue[]
}

interface TreeItem {
  id: string
  parent_id: string | null
}

/**
 * Collect an Issue and every descendant below it. Deleting an Issue soft
 * deletes its whole subtree on the server, so board state has to drop the
 * same closure instead of only the requested Issue.
 */
export function collectIssueSubtreeIds<T extends TreeItem>(
  items: T[],
  rootId: string
): Set<string> {
  const subtreeIds = new Set([rootId])
  let grew = true
  while (grew) {
    grew = false
    for (const item of items) {
      if (item.parent_id && subtreeIds.has(item.parent_id) && !subtreeIds.has(item.id)) {
        subtreeIds.add(item.id)
        grew = true
      }
    }
  }
  return subtreeIds
}

export function removeIssueSubtree<T extends TreeItem>(items: T[], rootId: string): T[] {
  const subtreeIds = collectIssueSubtreeIds(items, rootId)
  return items.filter(item => !subtreeIds.has(item.id))
}

function assigneeLabel(issue: CollaborationIssue, unassigned: string): string {
  return (
    issue.assignee_group_name ??
    issue.assignee_name ??
    issue.assignee_agent_name ??
    issue.assignee_team_name ??
    unassigned
  )
}

export function groupBoardIssues(
  project: CollaborationProject,
  issues: CollaborationIssue[],
  statuses: CollaborationStatus[],
  unassigned: string,
  noTag: string
): CollaborationBoardGroup[] {
  const groupBy = project.board_config?.group_by ?? 'status'
  if (groupBy === 'status') {
    return statuses.map(status => ({
      id: status.id,
      label: status.name,
      color: status.color,
      issues: issues.filter(issue => issue.status === status.id),
    }))
  }

  const groups = new Map<string, CollaborationIssue[]>()
  for (const issue of issues) {
    const keys =
      groupBy === 'priority'
        ? [issue.priority]
        : groupBy === 'assignee'
          ? [assigneeLabel(issue, unassigned)]
          : issue.tags.length > 0
            ? issue.tags
            : [noTag]
    for (const key of keys) groups.set(key, [...(groups.get(key) ?? []), issue])
  }
  return [...groups.entries()].map(([id, groupedIssues]) => ({
    id,
    label: id,
    issues: groupedIssues,
  }))
}

export function projectStatuses(
  project: CollaborationProject,
  messages: (typeof collaborationMessages)['zh-CN'] | (typeof collaborationMessages)['en'],
  translate: CollaborationTranslate,
  issues: readonly CollaborationIssue[] = []
): CollaborationStatus[] {
  const statuses = project.board_config?.statuses
  const configured =
    statuses && statuses.length > 0
      ? localizeStandardStatuses(statuses, translate)
      : threadStatuses(messages)
  if (project.resource_type !== 'chat_group' && !issues.some(issue => issue.group_id))
    return configured
  const unified = threadStatuses(messages)
  const ids = new Set(unified.map(status => status.id))
  if (project.resource_type !== 'chat_group') {
    for (const status of configured) {
      if (!ids.has(status.id)) {
        unified.push(status)
        ids.add(status.id)
      }
    }
  }
  for (const issue of issues) {
    if (ids.has(issue.status)) continue
    unified.push(
      configured.find(status => status.id === issue.status) ?? {
        id: issue.status,
        name: issue.status,
        color: 'gray',
      }
    )
    ids.add(issue.status)
  }
  return unified
}

export function threadStatuses(
  messages: (typeof collaborationMessages)['zh-CN'] | (typeof collaborationMessages)['en']
): CollaborationStatus[] {
  return [
    { id: 'inbox', name: messages.statusInbox, color: 'gray' },
    { id: 'pending', name: messages.statusPending, color: 'blue' },
    {
      id: 'in_progress',
      name: messages.statusInProgress,
      color: 'orange',
    },
    { id: 'in_review', name: messages.statusInReview, color: 'purple' },
    { id: 'completed', name: messages.statusCompleted, color: 'green' },
  ]
}
