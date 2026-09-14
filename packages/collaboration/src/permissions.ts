// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import type {
  CollaborationIssue,
  CollaborationProject,
  CollaborationView,
} from "./types";

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
  automationSupported = true,
): boolean {
  const accessRole =
    project.access_role ??
    (project.project_store === "local" ? "Owner" : "RestrictedAnalyst");
  if (view === "board" || view === "table") return true;
  if (view === "files") return accessRole !== "RestrictedAnalyst";
  if (view === "automation") {
    return automationSupported && accessRole !== "RestrictedAnalyst";
  }
  return accessRole === "Owner" || accessRole === "Maintainer";
}
