// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  canAccessCollaborationProjectView,
  canAssignCollaborationIssue,
  canCommentCollaborationIssue,
  canEditCollaborationIssue,
  canManageCollaborationIssueSecurity,
  canStartWorkOnCollaborationIssue,
  getCollaborationIssueActionPermissions,
} from "./permissions";

describe("collaboration permissions", () => {
  it("fails closed when a cloud issue omits can_edit", () => {
    expect(canEditCollaborationIssue({})).toBe(false);
    expect(canEditCollaborationIssue({ can_edit: false })).toBe(false);
    expect(canEditCollaborationIssue({ can_edit: true })).toBe(true);
  });

  it("fails closed when a backend project omits access_role", () => {
    const project = {
      project_store: "backend" as const,
      access_role: undefined,
    };

    expect(canAccessCollaborationProjectView(project, "board")).toBe(true);
    expect(canAccessCollaborationProjectView(project, "files")).toBe(false);
    expect(canAccessCollaborationProjectView(project, "manage")).toBe(false);
  });

  it("uses the explicit local project marker for trusted owner access", () => {
    const project = {
      project_store: "local" as const,
      access_role: undefined,
    };

    expect(canAccessCollaborationProjectView(project, "files")).toBe(true);
    expect(canAccessCollaborationProjectView(project, "manage")).toBe(true);
  });

  it("keeps edit, comment, assignment and start-work permissions independent", () => {
    const readOnlyIssue = {
      can_edit: false,
      can_view_detail: true,
      created_by_user_id: 99,
    };

    expect(
      getCollaborationIssueActionPermissions(
        {
          access_role: "Owner",
          project_store: "backend",
          current_user_id: 7,
        },
        readOnlyIssue,
      ),
    ).toEqual({
      canEdit: false,
      canComment: true,
      canAssign: true,
      canStartWork: true,
    });
    expect(
      getCollaborationIssueActionPermissions(
        {
          access_role: "Developer",
          project_store: "backend",
          current_user_id: 7,
        },
        readOnlyIssue,
      ),
    ).toEqual({
      canEdit: false,
      canComment: true,
      canAssign: true,
      canStartWork: true,
    });
    expect(
      getCollaborationIssueActionPermissions(
        {
          access_role: "Viewer",
          project_store: "backend",
          current_user_id: 7,
        },
        readOnlyIssue,
      ),
    ).toEqual({
      canEdit: false,
      canComment: false,
      canAssign: false,
      canStartWork: false,
    });
  });

  it("lets members assign and denies read-only creators", () => {
    expect(
      canAssignCollaborationIssue({
        access_role: "Maintainer",
        project_store: "backend",
      }),
    ).toBe(true);
    expect(
      canAssignCollaborationIssue({
        access_role: "Developer",
        project_store: "backend",
      }),
    ).toBe(true);
    expect(
      canAssignCollaborationIssue({
        access_role: "Viewer",
        project_store: "backend",
      }),
    ).toBe(false);
  });

  it("does not grant creators assignment control outside their role", () => {
    expect(
      getCollaborationIssueActionPermissions(
        {
          access_role: "Viewer",
          project_store: "backend",
          current_user_id: 7,
        },
        {
          can_edit: false,
          can_view_detail: true,
          created_by_user_id: 7,
        },
      ),
    ).toEqual({
      canEdit: false,
      canComment: false,
      canAssign: false,
      canStartWork: false,
    });
  });

  it("uses membership for comments and visibility for starting work", () => {
    const developer = {
      access_role: "Developer" as const,
      project_store: "backend" as const,
    };

    expect(
      canCommentCollaborationIssue(developer, { can_view_detail: true }),
    ).toBe(true);
    expect(
      canCommentCollaborationIssue(developer, { can_view_detail: false }),
    ).toBe(false);
    expect(canStartWorkOnCollaborationIssue({ can_view_detail: true })).toBe(
      true,
    );
    expect(canStartWorkOnCollaborationIssue({ can_view_detail: false })).toBe(
      false,
    );
  });

  it("restricts issue security changes to maintainers and owners", () => {
    const role = (
      access_role: "Owner" | "Maintainer" | "Developer" | "Viewer",
    ) =>
      canManageCollaborationIssueSecurity({
        access_role,
        project_store: "backend",
      });

    expect(role("Owner")).toBe(true);
    expect(role("Maintainer")).toBe(true);
    expect(role("Developer")).toBe(false);
    expect(role("Viewer")).toBe(false);
  });
});
