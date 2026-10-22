// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import type {
  CollaborationIssue,
  CollaborationProject,
  CollaborationStatus,
} from "./types";

export interface CollaborationBoardGroup {
  id: string;
  label: string;
  color?: CollaborationStatus["color"];
  issues: CollaborationIssue[];
}

interface TreeItem {
  id: string;
  parent_id: string | null;
}

/**
 * Collect an Issue and every descendant below it. Deleting an Issue soft
 * deletes its whole subtree on the server, so board state has to drop the
 * same closure instead of only the requested Issue.
 */
export function collectIssueSubtreeIds<T extends TreeItem>(
  items: T[],
  rootId: string,
): Set<string> {
  const subtreeIds = new Set([rootId]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const item of items) {
      if (
        item.parent_id &&
        subtreeIds.has(item.parent_id) &&
        !subtreeIds.has(item.id)
      ) {
        subtreeIds.add(item.id);
        grew = true;
      }
    }
  }
  return subtreeIds;
}

export function removeIssueSubtree<T extends TreeItem>(
  items: T[],
  rootId: string,
): T[] {
  const subtreeIds = collectIssueSubtreeIds(items, rootId);
  return items.filter((item) => !subtreeIds.has(item.id));
}

function assigneeLabel(issue: CollaborationIssue, unassigned: string): string {
  return (
    issue.assignee_group_name ??
    issue.assignee_name ??
    issue.assignee_agent_name ??
    issue.assignee_team_name ??
    unassigned
  );
}

export function groupBoardIssues(
  project: CollaborationProject,
  issues: CollaborationIssue[],
  statuses: CollaborationStatus[],
  unassigned: string,
  noTag: string,
): CollaborationBoardGroup[] {
  const groupBy = project.board_config?.group_by ?? "status";
  if (groupBy === "status") {
    return statuses.map((status) => ({
      id: status.id,
      label: status.name,
      color: status.color,
      issues: issues.filter((issue) => issue.status === status.id),
    }));
  }

  const groups = new Map<string, CollaborationIssue[]>();
  for (const issue of issues) {
    const keys =
      groupBy === "priority"
        ? [issue.priority]
        : groupBy === "assignee"
          ? [assigneeLabel(issue, unassigned)]
          : issue.tags.length > 0
            ? issue.tags
            : [noTag];
    for (const key of keys)
      groups.set(key, [...(groups.get(key) ?? []), issue]);
  }
  return [...groups.entries()].map(([id, groupedIssues]) => ({
    id,
    label: id,
    issues: groupedIssues,
  }));
}
