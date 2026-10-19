// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import type {
  CollaborationIssue,
  CollaborationProject,
  CollaborationRole,
  CollaborationView,
} from "./types";

type ProjectRoleSource = Pick<
  CollaborationProject,
  "access_role" | "project_store"
>;

/** Resolve the effective role, treating a local project as owner-trusted. */
function resolveProjectRole(project: ProjectRoleSource): CollaborationRole {
  return (
    project.access_role ??
    (project.project_store === "local" ? "Owner" : "Viewer")
  );
}

/** Developer and above may change Issue content. */
function canModifyIssues(role: CollaborationRole): boolean {
  return role === "Owner" || role === "Maintainer" || role === "Developer";
}

export function canEditCollaborationIssue(
  issue: Pick<CollaborationIssue, "can_edit">,
): boolean {
  return issue.can_edit === true;
}

export function canCommentCollaborationIssue(
  project: ProjectRoleSource,
  issue: Pick<CollaborationIssue, "can_view_detail">,
): boolean {
  if (issue.can_view_detail === false) return false;
  return canModifyIssues(resolveProjectRole(project));
}

export function canAssignCollaborationIssue(
  project: ProjectRoleSource,
): boolean {
  return canModifyIssues(resolveProjectRole(project));
}

export function canStartWorkOnCollaborationIssue(
  issue: Pick<CollaborationIssue, "can_view_detail">,
): boolean {
  return issue.can_view_detail !== false;
}

/** Only Maintainers and Owners may change an Issue's security level. */
export function canManageCollaborationIssueSecurity(
  project: ProjectRoleSource,
): boolean {
  const role = resolveProjectRole(project);
  return role === "Owner" || role === "Maintainer";
}

export interface CollaborationIssueActionPermissions {
  canEdit: boolean;
  canComment: boolean;
  canAssign: boolean;
  canStartWork: boolean;
}

export function getCollaborationIssueActionPermissions(
  project: ProjectRoleSource & Pick<CollaborationProject, "current_user_id">,
  issue: Pick<
    CollaborationIssue,
    "can_edit" | "can_view_detail" | "created_by_user_id"
  >,
): CollaborationIssueActionPermissions {
  const canViewDetail = canStartWorkOnCollaborationIssue(issue);
  const canWork = canViewDetail && canModifyIssues(resolveProjectRole(project));
  return {
    canEdit: canEditCollaborationIssue(issue),
    canComment: canCommentCollaborationIssue(project, issue),
    canAssign: canViewDetail && canAssignCollaborationIssue(project),
    canStartWork: canWork,
  };
}

export function canAccessCollaborationProjectView(
  project: ProjectRoleSource,
  view: CollaborationView,
): boolean {
  const role = resolveProjectRole(project);
  if (
    view === "board" ||
    view === "calendar" ||
    view === "gantt" ||
    view === "table"
  )
    return true;
  if (view === "files") return canModifyIssues(role);
  return role === "Owner" || role === "Maintainer";
}
