// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import type { CollaborationPriority } from '../types'

export interface CollaborationIssueCardItem {
  id: string
  title: string
  priority: CollaborationPriority
  created_at?: string | null
  due_at?: string | null
  updated_at?: string | null
  tags?: readonly string[] | null
  is_unread?: boolean
  assignee_name?: string | null
  assignee_agent_id?: string | null
  assignee_agent_name?: string | null
  assignee_team_id?: number | null
  assignee_team_name?: string | null
}

export interface CollaborationIssueCardDisplay {
  showAssignee: boolean
  showDate: boolean
  showPriority: boolean
  showReference?: boolean
  showTags: boolean
}

export interface CollaborationIssueCardLabels {
  assignee: string
  createdAt: string
  priority: Record<CollaborationPriority, string>
  unassigned: string
}

export interface CollaborationIssueCardModel {
  assigneeKind: 'agent' | 'team' | 'user' | null
  assigneeName: string | null
  date: {
    value: string
    label: string
  } | null
  priority: CollaborationPriority
  priorityLabel: string
  reference: string
  shortReference: string
  tags: readonly string[]
  title: string
  unread: boolean
}

export function resolveIssueCardAssignee(
  item: CollaborationIssueCardItem,
  agentNames?: Readonly<Record<string, string>>
): Pick<CollaborationIssueCardModel, 'assigneeKind' | 'assigneeName'> {
  if (item.assignee_name) {
    return { assigneeKind: 'user', assigneeName: item.assignee_name }
  }
  if (item.assignee_team_name) {
    return { assigneeKind: 'team', assigneeName: item.assignee_team_name }
  }
  if (item.assignee_agent_id) {
    return {
      assigneeKind: 'agent',
      assigneeName: item.assignee_agent_name ?? agentNames?.[item.assignee_agent_id] ?? null,
    }
  }
  return { assigneeKind: null, assigneeName: null }
}

function formatIssueCardDate(value?: string | null): string | null {
  if (!value) return null
  const date = value.slice(0, 10)
  return /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : value
}

export function createCollaborationIssueCardModel({
  agentNames,
  item,
  labels,
  reference,
  now = new Date(),
}: {
  agentNames?: Readonly<Record<string, string>>
  item: CollaborationIssueCardItem
  labels: CollaborationIssueCardLabels
  reference: string
  now?: Date
}): CollaborationIssueCardModel {
  const assignee = resolveIssueCardAssignee(item, agentNames)
  const date = formatIssueCardDate(item.created_at)
  const shortReference = reference.match(/-(\d+)$/)?.[1]
  return {
    ...assignee,
    date: date
      ? {
          value: date,
          label: date.startsWith(`${now.getFullYear()}-`) ? date.slice(5) : date,
        }
      : null,
    priority: item.priority,
    priorityLabel: labels.priority[item.priority],
    reference,
    shortReference: shortReference ? `#${shortReference}` : reference,
    tags: item.tags ?? [],
    title: item.title,
    unread: Boolean(item.is_unread),
  }
}
