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

export function canAccessCollaborationProjectView(
  project: Pick<CollaborationProject, "access_role"> &
    Partial<Pick<CollaborationProject, "project_store">>,
  view: CollaborationView,
  automationSupported = true,
): boolean {
  const accessRole =
    project.access_role ??
    (project.project_store === "local" ? "Owner" : "RestrictedAnalyst");
  if (view === "board") return true;
  if (view === "files") return accessRole !== "RestrictedAnalyst";
  if (view === "automation") {
    return automationSupported && accessRole !== "RestrictedAnalyst";
  }
  return accessRole === "Owner" || accessRole === "Maintainer";
}
