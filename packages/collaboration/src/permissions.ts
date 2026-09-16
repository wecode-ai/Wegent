// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import type {
  CollaborationIssue,
  CollaborationProject,
  CollaborationView,
} from "./types";

type CollaborationIssueMutation =
  | { kind: "status"; status: string }
  | { kind: "priority" }
  | {
      kind: "assignee";
      assigneeId: string | null;
      assigneeType: "user" | "agent" | "team" | null;
    }
  | { kind: "tag" };

function isLocalProject(
  project: Pick<CollaborationProject, "project_store">,
): boolean {
  return project.project_store === "local";
}

export function canEditCollaborationIssue(
  projectOrIssue:
    | Pick<CollaborationProject, "project_store">
    | (Pick<CollaborationIssue, "permissions"> & {
        project_store?: CollaborationProject["project_store"];
      }),
  issue?: Pick<CollaborationIssue, "permissions">,
): boolean {
  const project = issue
    ? (projectOrIssue as Pick<CollaborationProject, "project_store">)
    : {
        project_store:
          "project_store" in projectOrIssue
            ? (projectOrIssue.project_store ?? "backend")
            : "backend",
      };
  const targetIssue = issue ?? projectOrIssue;
  return (
    isLocalProject(project) ||
    ("permissions" in targetIssue &&
      targetIssue.permissions?.edit_content === true)
  );
}

export function canCommentCollaborationIssue(
  project: Pick<CollaborationProject, "project_store">,
  issue: Pick<CollaborationIssue, "permissions">,
): boolean {
  return isLocalProject(project) || issue.permissions?.comment === true;
}

export function canAssignCollaborationIssue(
  project: Pick<CollaborationProject, "project_store">,
  issue: Pick<CollaborationIssue, "permissions">,
): boolean {
  return (
    isLocalProject(project) ||
    issue.permissions?.assign === true ||
    issue.permissions?.claim === true ||
    issue.permissions?.handoff === true
  );
}

export function canStartWorkOnCollaborationIssue(
  project: Pick<CollaborationProject, "project_store">,
  issue: Pick<CollaborationIssue, "permissions">,
): boolean {
  return isLocalProject(project) || issue.permissions?.execute === true;
}

export function canApplyCollaborationIssueMutation(
  project: Pick<CollaborationProject, "current_user_id" | "project_store">,
  issue: Pick<
    CollaborationIssue,
    | "assignee_agent_id"
    | "assignee_team_id"
    | "assignee_user_id"
    | "permissions"
    | "status"
  >,
  mutation: CollaborationIssueMutation,
): boolean {
  if (isLocalProject(project)) return true;
  const permissions = issue.permissions;
  if (!permissions) return false;
  if (mutation.kind === "priority" || mutation.kind === "tag") {
    return permissions.edit_content;
  }
  if (mutation.kind === "status") {
    if (mutation.status === issue.status) return permissions.edit_content;
    if (issue.status === "completed") return permissions.reopen;
    if (mutation.status === "completed") return permissions.complete;
    if (mutation.status === "in_review") return permissions.submit_review;
    return permissions.edit_content;
  }
  const currentUserId = project.current_user_id;
  const isUnassigned =
    issue.assignee_user_id == null &&
    !issue.assignee_agent_id &&
    issue.assignee_team_id == null;
  const claimsForCurrentUser =
    isUnassigned &&
    mutation.assigneeType === "user" &&
    Number(mutation.assigneeId) === currentUserId;
  return (
    permissions.assign ||
    permissions.handoff ||
    (permissions.claim && claimsForCurrentUser)
  );
}

export interface CollaborationIssueActionPermissions {
  canEdit: boolean;
  canComment: boolean;
  canAssign: boolean;
  canStartWork: boolean;
  canSubmitReview: boolean;
  canComplete: boolean;
  canReopen: boolean;
}

export function getCollaborationIssueActionPermissions(
  project: Pick<CollaborationProject, "project_store">,
  issue: Pick<CollaborationIssue, "permissions">,
): CollaborationIssueActionPermissions {
  const canStartWork = canStartWorkOnCollaborationIssue(project, issue);
  return {
    canEdit: canEditCollaborationIssue(project, issue),
    canComment: canCommentCollaborationIssue(project, issue),
    canAssign: canAssignCollaborationIssue(project, issue),
    canStartWork,
    canSubmitReview:
      isLocalProject(project) || issue.permissions?.submit_review === true,
    canComplete:
      isLocalProject(project) || issue.permissions?.complete === true,
    canReopen: isLocalProject(project) || issue.permissions?.reopen === true,
  };
}

export function canAccessCollaborationProjectView(
  project: Pick<CollaborationProject, "access_role"> &
    Partial<Pick<CollaborationProject, "project_store">>,
  view: CollaborationView,
): boolean {
  const accessRole =
    project.access_role ??
    (project.project_store === "local" ? "Owner" : "RestrictedAnalyst");
  if (view === "board" || view === "table") return true;
  if (view === "files") return accessRole !== "RestrictedAnalyst";
  return accessRole === "Owner" || accessRole === "Maintainer";
}
