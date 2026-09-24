// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import type {
  CollaborationIssue,
  CollaborationProject,
  CollaborationView,
} from "./types";

export function canEditCollaborationIssue(
  issue: Pick<CollaborationIssue, "can_edit">,
): boolean {
  return issue.can_edit === true;
}

export function canCommentCollaborationIssue(
  project: Pick<CollaborationProject, "access_role" | "project_store">,
  issue: Pick<CollaborationIssue, "can_view_detail">,
): boolean {
  if (issue.can_view_detail === false) return false;
  const role =
    project.access_role ??
    (project.project_store === "local" ? "Owner" : "Viewer");
  return role === "Owner" || role === "Maintainer" || role === "Developer";
}

export function canAssignCollaborationIssue(
  project: Pick<CollaborationProject, "access_role" | "project_store">,
): boolean {
  const role =
    project.access_role ??
    (project.project_store === "local" ? "Owner" : "Viewer");
  return role === "Owner" || role === "Maintainer";
}

export function canStartWorkOnCollaborationIssue(
  issue: Pick<CollaborationIssue, "can_view_detail">,
): boolean {
  return issue.can_view_detail !== false;
}

export interface CollaborationIssueActionPermissions {
  canEdit: boolean;
  canComment: boolean;
  canAssign: boolean;
  canStartWork: boolean;
}

export function getCollaborationIssueActionPermissions(
  project: Pick<CollaborationProject, "access_role" | "project_store">,
  issue: Pick<CollaborationIssue, "can_edit" | "can_view_detail">,
): CollaborationIssueActionPermissions {
  const role =
    project.access_role ??
    (project.project_store === "local" ? "Owner" : "Viewer");
  const canStartWork =
    canStartWorkOnCollaborationIssue(issue) &&
    (role === "Owner" || role === "Maintainer" || role === "Developer");
  return {
    canEdit: canEditCollaborationIssue(issue),
    canComment: canCommentCollaborationIssue(project, issue),
    canAssign: canStartWork && canAssignCollaborationIssue(project),
    canStartWork,
  };
}

export function canAccessCollaborationProjectView(
  project: Pick<CollaborationProject, "access_role"> &
    Partial<Pick<CollaborationProject, "project_store">>,
  view: CollaborationView,
): boolean {
  const accessRole =
    project.access_role ??
    (project.project_store === "local" ? "Owner" : "Viewer");
  if (view === "board" || view === "table") return true;
  if (view === "files")
    return (
      accessRole === "Owner" ||
      accessRole === "Maintainer" ||
      accessRole === "Developer"
    );
  return accessRole === "Owner" || accessRole === "Maintainer";
}
