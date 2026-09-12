// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import type {
  CollaborationAssignment,
  CollaborationIssue,
  CollaborationWorkspace,
} from "../types";

export function visibleIssueAssignments(
  _issue: CollaborationIssue,
  assignments: CollaborationAssignment[] | undefined,
): CollaborationAssignment[] {
  return assignments ?? [];
}

export function sortCollaborationWorkspaces(
  workspaces: CollaborationWorkspace[],
): CollaborationWorkspace[] {
  return [...workspaces].sort((left, right) =>
    right.updated_at.localeCompare(left.updated_at),
  );
}

export function filterCollaborationWorkspaces(
  workspaces: CollaborationWorkspace[],
  query: string,
): CollaborationWorkspace[] {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return workspaces;
  return workspaces.filter(
    (workspace) =>
      workspace.name.toLowerCase().includes(normalized) ||
      workspace.description.toLowerCase().includes(normalized),
  );
}
