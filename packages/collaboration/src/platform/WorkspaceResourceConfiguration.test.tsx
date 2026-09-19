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
  description: "负责产品交付",
  instructions: "实现工作应该 @Codex 来完成",
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
  execution_requirements: {
    required_tags: ["macos"],
  },
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
    // Radix restores focus in a zero-delay timer when a popover unmounts.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }

  async function change(
    element: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement,
    value: string,
  ) {
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(
        Object.getPrototypeOf(element),
        "value",
      )?.set;
      setter?.call(element, value);
      element.dispatchEvent(new Event("change", { bubbles: true }));
    });
  }

  it("only requests responsibilities from ordinary members, including after changing the leader", async () => {
    await act(async () =>
      root.render(
        <WorkspaceCollaborationGroupsConfiguration
          groups={[]}
          members={[]}
          agents={[codexAgent, claudeAgent]}
          locale="zh-CN"
          commands={commands}
          canManage
          initialCreateOpen
        />,
      ),
    );
    expect(
      container.querySelector(
        'select[data-testid="collaboration-group-leader"]',
      ),
    ).toBeNull();
    expect(byTestId("collaboration-group-create-member-agent-1")).toBeNull();
    await click(byTestId("collaboration-group-leader"));
    await click(byTestId("collaboration-group-leader-agent-1"));
    expect(
      byTestId("collaboration-group-create-responsibility-agent-1"),
    ).toBeNull();
    await click(byTestId("collaboration-group-create-add-members"));
    expect(byTestId("collaboration-group-create-member-agent-1")).toBeNull();
    await click(byTestId("collaboration-group-create-member-agent-2"));
    await click(byTestId("collaboration-group-members-done"));
    await change(
      byTestId<HTMLInputElement>(
        "collaboration-group-create-responsibility-agent-2",
      ),
      "审查代码",
    );
    await click(byTestId("collaboration-group-leader"));
    await click(byTestId("collaboration-group-leader-agent-2"));
    expect(
      byTestId<HTMLInputElement>(
        "collaboration-group-create-responsibility-agent-1",
      ).value,
    ).toBe("");
    expect(
      byTestId("collaboration-group-create-responsibility-agent-2"),
    ).toBeNull();
    expect(byTestId("collaboration-group-remove-member-agent-2")).toBeNull();
    expect(
      byTestId("collaboration-group-remove-member-agent-1"),
    ).not.toBeNull();
    await click(byTestId("collaboration-group-remove-member-agent-1"));
    expect(
      byTestId("collaboration-group-create-responsibility-agent-1"),
    ).toBeNull();
    expect(
      byTestId("collaboration-group-create-responsibility-agent-2"),
    ).toBeNull();
    commands.createCollaborationGroup = vi.fn(async () => group);
    await change(
      byTestId<HTMLInputElement>("collaboration-group-name"),
      "单人小队",
    );
    await click(byTestId("collaboration-group-create-next"));
    await click(byTestId("collaboration-group-create-next"));
    await click(byTestId("collaboration-group-create"));
    expect(commands.createCollaborationGroup).toHaveBeenCalledWith(
      expect.objectContaining({
        leader: { kind: "agent", id: "2", responsibility: "" },
        members: [{ kind: "agent", id: "2", responsibility: "" }],
      }),
    );
  });

  it("searches people and agents and restores keyboard focus on Escape", async () => {
    await act(async () =>
      root.render(
        <WorkspaceCollaborationGroupsConfiguration
          groups={[]}
          members={[]}
          agents={[codexAgent, claudeAgent]}
          locale="en"
          commands={commands}
          canManage
          initialCreateOpen
        />,
      ),
    );
    await click(byTestId("collaboration-group-leader"));
    const search = byTestId<HTMLInputElement>(
      "collaboration-group-leader-search",
    );
    await change(search, "missing");
    expect(container.textContent).toContain("No matching people or agents");
    await change(search, "codex");
    expect(byTestId("collaboration-group-leader-agent-2")).toBeNull();
    await act(async () => {
      search.dispatchEvent(
        new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }),
      );
    });
    expect(document.activeElement).toBe(
      byTestId("collaboration-group-leader-agent-1"),
    );
    await act(async () => {
      document.activeElement!.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
      );
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(byTestId("collaboration-group-leader-search")).toBeNull();
    expect(document.activeElement).toBe(byTestId("collaboration-group-leader"));
  });

  it("creates a fully configured group through the three-step dialog", async () => {
    commands.createCollaborationGroup = vi.fn(async (input) => ({
      ...group,
      name: input.name,
      description: input.description ?? "",
      instructions: input.instructions ?? "",
      leader: {
        ...input.leader,
        responsibility: input.leader.responsibility ?? "",
      },
      members: input.members.map((member) => ({
        ...member,
        responsibility: member.responsibility ?? "",
      })),
      stages: (input.stages ?? []).map((stage) => ({
        ...stage,
        description: stage.description ?? "",
        assignee: stage.assignee
          ? {
              ...stage.assignee,
              responsibility: stage.assignee.responsibility ?? "",
            }
          : null,
      })),
      execution_requirements: {
        required_tags: input.executionRequirements?.requiredTags ?? [],
      },
    }));

    await act(async () => {
      root.render(
        <WorkspaceCollaborationGroupsConfiguration
          groups={[]}
          members={[]}
          agents={[codexAgent, claudeAgent]}
          locale="zh-CN"
          commands={commands}
          canManage
        />,
      );
    });

    await click(byTestId("collaboration-group-open-create"));
    await change(
      byTestId<HTMLInputElement>("collaboration-group-name"),
      "交付小组",
    );
    await click(byTestId("collaboration-group-leader"));
    await click(byTestId("collaboration-group-leader-agent-1"));
    await click(byTestId("collaboration-group-create-add-members"));
    await click(
      byTestId<HTMLInputElement>("collaboration-group-create-member-agent-2"),
    );
    await click(byTestId("collaboration-group-members-done"));
    expect(
      byTestId("collaboration-group-create-responsibility-agent-1"),
    ).toBeNull();
    await change(
      byTestId<HTMLInputElement>(
        "collaboration-group-create-responsibility-agent-2",
      ),
      "代码审查",
    );
    await change(
      byTestId<HTMLInputElement>("collaboration-group-description"),
      "负责产品交付",
    );
    await click(byTestId("collaboration-group-create-next"));
    expect(
      byTestId("collaboration-group-create-tab-rules").getAttribute(
        "aria-selected",
      ),
    ).toBe("true");
    await change(
      byTestId<HTMLTextAreaElement>("collaboration-group-create-instructions"),
      "实现工作应该 @",
    );
    await click(byTestId("collaboration-group-create-mention-agent-1"));
    await click(byTestId("collaboration-group-create-stage-add"));
    const createStage = container.querySelector<HTMLElement>(
      ".collaboration-group-stage-card",
    )!;
    await change(
      createStage.querySelector<HTMLInputElement>("input")!,
      "代码审查",
    );
    await change(
      createStage.querySelector<HTMLSelectElement>("select")!,
      "agent:2",
    );
    await click(byTestId("collaboration-group-create-next"));
    await change(
      byTestId<HTMLInputElement>(
        "collaboration-group-create-environment-tag-input",
      ),
      "macos",
    );
    await click(byTestId("collaboration-group-create-environment-tag-add"));
    await click(byTestId("collaboration-group-create"));

    expect(commands.createCollaborationGroup).toHaveBeenCalledWith({
      name: "交付小组",
      description: "负责产品交付",
      leader: { kind: "agent", id: "1", responsibility: "" },
      members: [
        { kind: "agent", id: "1", responsibility: "" },
        { kind: "agent", id: "2", responsibility: "代码审查" },
      ],
      coordinationMode: "manager",
      instructions: "实现工作应该 @Codex",
      stages: [
        {
          id: expect.any(String),
          name: "代码审查",
          description: "",
          assignee: {
            kind: "agent",
            id: "2",
            responsibility: "代码审查",
          },
        },
      ],
      executionRequirements: {
        requiredTags: ["macos"],
      },
    });
  });

  it("edits member delegation rules, workflow stages, and environment requirements", async () => {
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
      byTestId("collaboration-group-detail-tab-members").getAttribute(
        "aria-selected",
      ),
    ).toBe("true");
    await click(byTestId("collaboration-group-detail-tab-rules"));
    expect(
      byTestId<HTMLTextAreaElement>("collaboration-group-detail-instructions")
        .value,
    ).toBe("实现工作应该 @Codex 来完成");
    expect(
      container.querySelector<HTMLSelectElement>(
        '[data-testid="collaboration-group-stage-stage-1"] select',
      )?.options[0].textContent,
    ).toBe("由负责人执行");
    await click(byTestId("collaboration-group-rule-mention-trigger"));
    await click(byTestId("collaboration-group-rule-mention-agent-2"));
    expect(
      byTestId<HTMLTextAreaElement>("collaboration-group-detail-instructions")
        .value,
    ).toContain("@Claude Code");
    await click(byTestId("collaboration-group-detail-tab-environment"));
    expect(
      container.querySelector(
        '[data-testid="collaboration-group-environment-tag-remove-macos"]',
      ),
    ).not.toBeNull();
    await change(
      byTestId<HTMLInputElement>("collaboration-group-environment-tag-input"),
      "gpu",
    );
    await click(byTestId("collaboration-group-environment-tag-add"));
    await click(byTestId("collaboration-group-detail-tab-members"));
    await click(
      byTestId<HTMLInputElement>("collaboration-group-detail-member-agent-2"),
    );
    await click(byTestId("collaboration-group-detail-save"));

    expect(commands.updateCollaborationGroup).toHaveBeenCalledWith(
      group.id,
      expect.objectContaining({
        members: [{ kind: "agent", id: "1", responsibility: "Implement" }],
        instructions: expect.stringContaining("@Claude Code"),
        stages: [
          expect.objectContaining({
            id: "stage-1",
            assignee: null,
          }),
        ],
        executionRequirements: {
          requiredTags: ["macos", "gpu"],
        },
      }),
    );
  });
});
