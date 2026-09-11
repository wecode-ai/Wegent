// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  canAccessCollaborationProjectView,
  canEditCollaborationIssue,
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
});
