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
  const permissions = {
    edit_content: false,
    comment: false,
    claim: false,
    handoff: false,
    assign: false,
    execute: false,
    submit_review: false,
    complete: false,
    reopen: false,
  };

  it("uses server permissions and fails closed when a cloud issue omits them", () => {
    expect(canEditCollaborationIssue({ project_store: "backend" })).toBe(false);
    expect(
      canEditCollaborationIssue({
        project_store: "backend",
        permissions: { ...permissions, edit_content: true },
      }),
    ).toBe(true);
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
      permissions: {
        ...permissions,
        comment: true,
        assign: true,
        execute: true,
      },
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
      canSubmitReview: false,
      canComplete: false,
      canReopen: false,
    });
    expect(
      getCollaborationIssueActionPermissions(
        { project_store: "backend" },
        {
          permissions: {
            ...permissions,
            comment: true,
          },
        },
      ),
    ).toEqual({
      canEdit: false,
      canComment: true,
      canAssign: false,
      canStartWork: false,
      canSubmitReview: false,
      canComplete: false,
      canReopen: false,
    });
    expect(
      getCollaborationIssueActionPermissions(
        { project_store: "backend" },
        { permissions },
      ),
    ).toEqual({
      canEdit: false,
      canComment: false,
      canAssign: false,
      canStartWork: false,
      canSubmitReview: false,
      canComplete: false,
      canReopen: false,
    });
  });

  it("uses the server assignment capability", () => {
    expect(
      canAssignCollaborationIssue(
        { project_store: "backend" },
        { permissions: { ...permissions, assign: true } },
      ),
    ).toBe(true);
    expect(
      canAssignCollaborationIssue(
        { project_store: "backend" },
        { permissions },
      ),
    ).toBe(false);
  });

  it("keeps comment and execution capabilities independent", () => {
    expect(
      canCommentCollaborationIssue(
        { project_store: "backend" },
        { permissions: { ...permissions, comment: true } },
      ),
    ).toBe(true);
    expect(
      canCommentCollaborationIssue(
        { project_store: "backend" },
        { permissions },
      ),
    ).toBe(false);
    expect(
      canStartWorkOnCollaborationIssue(
        { project_store: "backend" },
        { permissions: { ...permissions, execute: true } },
      ),
    ).toBe(true);
    expect(
      canStartWorkOnCollaborationIssue(
        { project_store: "backend" },
        { permissions },
      ),
    ).toBe(false);
  });
});
