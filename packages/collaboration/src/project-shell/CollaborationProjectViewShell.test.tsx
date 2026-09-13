// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import {
  buildCollaborationProjectViewOptions,
  resolveCollaborationProjectView,
  synchronizeCollaborationProjectView,
  type CollaborationProjectViewExtension,
  type CollaborationProjectViewSlots,
} from "./CollaborationProjectViewShell";

const labels = {
  board: "Board",
  files: "Files",
  automation: "Automation",
  manage: "Manage",
};

const testIds = {
  board: "board",
  files: "files",
  automation: "automation",
  manage: "manage",
};

const slots: CollaborationProjectViewSlots = {
  board: "board-content",
  files: "files-content",
  automation: "automation-content",
  manage: "manage-content",
};

const extensions: CollaborationProjectViewExtension[] = [];

describe("CollaborationProjectViewShell permissions", () => {
  it.each(["files", "automation", "manage"] as const)(
    "falls back to board instead of mounting RestrictedAnalyst %s content",
    (view) => {
      const options = buildCollaborationProjectViewOptions({
        project: { access_role: "RestrictedAnalyst" },
        labels,
        testIds,
        automationSupported: true,
      });

      expect(
        resolveCollaborationProjectView({
          extensions,
          options,
          slots,
          view,
        }),
      ).toEqual({
        content: "board-content",
        view: "board",
        viewChanged: true,
      });
    },
  );

  it("falls back to board instead of mounting unsupported automation content", () => {
    const options = buildCollaborationProjectViewOptions({
      project: { access_role: "Owner" },
      labels,
      testIds,
      automationSupported: false,
    });

    expect(
      resolveCollaborationProjectView({
        extensions,
        options,
        slots,
        view: "automation",
      }),
    ).toEqual({
      content: "board-content",
      view: "board",
      viewChanged: true,
    });
  });

  it("notifies the host to replace an inaccessible view with board", () => {
    const onViewChange = vi.fn();

    synchronizeCollaborationProjectView(
      {
        content: "board-content",
        view: "board",
        viewChanged: true,
      },
      onViewChange,
    );

    expect(onViewChange).toHaveBeenCalledOnce();
    expect(onViewChange).toHaveBeenCalledWith("board");
  });

  it("keeps an accessible view without requesting a host state correction", () => {
    const options = buildCollaborationProjectViewOptions({
      project: { access_role: "Owner" },
      labels,
      testIds,
      automationSupported: true,
    });

    const resolved = resolveCollaborationProjectView({
      extensions,
      options,
      slots,
      view: "files",
    });
    const onViewChange = vi.fn();

    synchronizeCollaborationProjectView(resolved, onViewChange);

    expect(resolved).toEqual({
      content: "files-content",
      view: "files",
      viewChanged: false,
    });
    expect(onViewChange).not.toHaveBeenCalled();
  });

  it("keeps desktop-only views available for explicitly local projects", () => {
    const options = buildCollaborationProjectViewOptions({
      project: { access_role: undefined, project_store: "local" },
      labels,
      testIds,
      automationSupported: true,
    });

    expect(options.map((option) => option.id)).toEqual([
      "board",
      "table",
      "files",
      "automation",
      "manage",
    ]);
  });
});
