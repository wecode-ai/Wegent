// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  canAccessCollaborationProjectView,
  canAssignCollaborationIssue,
  canCommentCollaborationIssue,
  canEditCollaborationIssue,
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
    expect(canAccessCollaborationProjectView(project, "automation")).toBe(
      false,
    );
    expect(canAccessCollaborationProjectView(project, "manage")).toBe(false);
  });

  it("uses the explicit local project marker for trusted owner access", () => {
    const project = {
      project_store: "local" as const,
      access_role: undefined,
    };

    expect(canAccessCollaborationProjectView(project, "files")).toBe(true);
    expect(canAccessCollaborationProjectView(project, "automation")).toBe(true);
    expect(canAccessCollaborationProjectView(project, "manage")).toBe(true);
  });

  it("keeps edit, comment, assignment and start-work permissions independent", () => {
    const readOnlyIssue = {
      can_edit: false,
      can_view_detail: true,
    };

    expect(
      getCollaborationIssueActionPermissions(
        { access_role: "Owner", project_store: "backend" },
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
        { access_role: "Reporter", project_store: "backend" },
        readOnlyIssue,
      ),
    ).toEqual({
      canEdit: false,
      canComment: true,
      canAssign: false,
      canStartWork: true,
    });
    expect(
      getCollaborationIssueActionPermissions(
        { access_role: "RestrictedAnalyst", project_store: "backend" },
        readOnlyIssue,
      ),
    ).toEqual({
      canEdit: false,
      canComment: false,
      canAssign: false,
      canStartWork: true,
    });
  });

  it("requires project management permission for assignment", () => {
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
    ).toBe(false);
  });

  it("uses membership for comments and visibility for starting work", () => {
    const reporter = {
      access_role: "Reporter" as const,
      project_store: "backend" as const,
    };

    expect(
      canCommentCollaborationIssue(reporter, { can_view_detail: true }),
    ).toBe(true);
    expect(
      canCommentCollaborationIssue(reporter, { can_view_detail: false }),
    ).toBe(false);
    expect(canStartWorkOnCollaborationIssue({ can_view_detail: true })).toBe(
      true,
    );
    expect(canStartWorkOnCollaborationIssue({ can_view_detail: false })).toBe(
      false,
    );
  });
});
