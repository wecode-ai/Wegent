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

interface LaneItem {
  id: string;
  parent_id: string | null;
  status: string;
}

export function reorderLaneItems<T extends LaneItem>(
  items: T[],
  itemId: string,
  status: string,
  beforeItemId: string | null,
): { items: T[]; laneIds: string[] } | null {
  const item = items.find((candidate) => candidate.id === itemId);
  if (!item) return null;
  const inLane = (candidate: T) =>
    candidate.parent_id === item.parent_id &&
    candidate.status === status &&
    candidate.id !== itemId;
  const currentLaneIds = items.filter(inLane).map((candidate) => candidate.id);
  if (item.status === status) {
    if (!beforeItemId) return null;
    const laneOrder = items.filter(
      (candidate) =>
        candidate.parent_id === item.parent_id && candidate.status === status,
    );
    const itemIndex = laneOrder.findIndex(
      (candidate) => candidate.id === itemId,
    );
    if (laneOrder[itemIndex + 1]?.id === beforeItemId) return null;
  }
  const laneIds = [...currentLaneIds];
  const beforeIndex = beforeItemId ? laneIds.indexOf(beforeItemId) : -1;
  laneIds.splice(beforeIndex >= 0 ? beforeIndex : laneIds.length, 0, itemId);
  const laneItems = new Map(
    items.filter(inLane).map((candidate) => [candidate.id, candidate]),
  );
  laneItems.set(itemId, { ...item, status });
  return {
    items: [
      ...items.filter(
        (candidate) => !inLane(candidate) && candidate.id !== itemId,
      ),
      ...laneIds.map((id) => laneItems.get(id)!),
    ],
    laneIds,
  };
}

function assigneeLabel(issue: CollaborationIssue, unassigned: string): string {
  return (
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
