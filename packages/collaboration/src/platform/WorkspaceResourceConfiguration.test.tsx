// @vitest-environment jsdom

// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { CollaborationAgent, CollaborationGroup } from "../types";
import {
  WorkspaceCollaborationGroupsConfiguration,
  type WorkspaceResourceCommands,
} from "./WorkspaceResourceConfiguration";

const codexAgent: CollaborationAgent = {
  id: "agent-1",
  team_id: 1,
  name: "Codex",
  runtime: "codex",
};

const claudeAgent: CollaborationAgent = {
  id: "agent-2",
  team_id: 2,
  name: "Claude Code",
  runtime: "claude_code",
};

const group: CollaborationGroup = {
  id: "group-1",
  workspace_id: "workspace-1",
  owner_type: "project",
  owner_id: "project-1",
  name: "Delivery team",
  description: "",
  leader: { kind: "agent", id: "1", responsibility: "Lead" },
  members: [
    { kind: "agent", id: "1", responsibility: "Implement" },
    { kind: "agent", id: "2", responsibility: "Review" },
  ],
  coordination_mode: "manager",
  stages: [
    {
      id: "stage-1",
      name: "Review",
      description: "",
      assignee: { kind: "agent", id: "2", responsibility: "Review" },
    },
  ],
  version: 1,
  created_by_user_id: 1,
  created_at: "2026-09-14T00:00:00Z",
  updated_at: "2026-09-14T00:00:00Z",
};

describe("WorkspaceCollaborationGroupsConfiguration", () => {
  let container: HTMLDivElement;
  let root: Root;
  let commands: WorkspaceResourceCommands;

  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    commands = {
      searchUsers: vi.fn(async () => []),
      addMember: vi.fn(),
      updateMember: vi.fn(),
      removeMember: vi.fn(),
      createCollaborationGroup: vi.fn(),
      updateCollaborationGroup: vi.fn(async () => group),
      removeCollaborationGroup: vi.fn(),
    };
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  function byTestId<T extends HTMLElement>(testId: string) {
    return container.querySelector<T>(`[data-testid="${testId}"]`)!;
  }

  async function click(element: HTMLElement) {
    await act(async () => {
      element.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
  }

  it("clears stage assignees when the referenced member is removed", async () => {
    await act(async () => {
      root.render(
        <WorkspaceCollaborationGroupsConfiguration
          groups={[group]}
          members={[]}
          agents={[codexAgent, claudeAgent]}
          locale="zh-CN"
          commands={commands}
          canManage
        />,
      );
    });

    await click(byTestId("collaboration-group-manage-group-1"));
    expect(
      container.querySelector<HTMLSelectElement>(
        '[data-testid="collaboration-group-stage-stage-1"] select',
      )?.options[0].textContent,
    ).toBe("由负责人执行");
    await click(
      byTestId<HTMLInputElement>("collaboration-group-detail-member-agent-2"),
    );
    await click(byTestId("collaboration-group-detail-save"));

    expect(commands.updateCollaborationGroup).toHaveBeenCalledWith(
      group.id,
      expect.objectContaining({
        members: [{ kind: "agent", id: "1", responsibility: "Implement" }],
        stages: [
          expect.objectContaining({
            id: "stage-1",
            assignee: null,
          }),
        ],
      }),
    );
  });
});
