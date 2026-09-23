// @vitest-environment jsdom

// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type {
  CollaborationAgent,
  CollaborationGroup,
  CollaborationMember,
} from "../types";
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

const humanMember: CollaborationMember = {
  id: 7,
  user_id: 7,
  user_name: "Alice",
  email: "alice@example.com",
  role: "Developer",
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
      removeCollaborationGroup: vi.fn(async () => undefined),
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

  it("adds the current user by default and labels them as me", async () => {
    commands.createCollaborationGroup = vi.fn(async () => group);
    await act(async () =>
      root.render(
        <WorkspaceCollaborationGroupsConfiguration
          groups={[]}
          members={[humanMember]}
          agents={[]}
          locale="zh-CN"
          currentUserId={humanMember.user_id}
          commands={commands}
          canManage
          initialCreateOpen
        />,
      ),
    );

    expect(container.textContent).toContain("我");
    expect(container.textContent).not.toContain(humanMember.user_name);
    expect(container.textContent).toContain(
      "负责人接收任务并协调推进，可在成员行切换。",
    );
    expect(byTestId("collaboration-group-leader-human-7")).not.toBeNull();
    expect(
      byTestId("collaboration-group-create-responsibility-human-7"),
    ).not.toBeNull();
    await change(
      byTestId<HTMLInputElement>("collaboration-group-name"),
      "我的协作小组",
    );
    await click(byTestId("collaboration-group-create"));

    expect(commands.createCollaborationGroup).toHaveBeenCalledWith(
      expect.objectContaining({
        leader: { kind: "human", id: "7", responsibility: "" },
        members: [{ kind: "human", id: "7", responsibility: "" }],
      }),
    );
  });

  it("keeps responsibilities editable for the leader after changing the leader", async () => {
    await act(async () =>
      root.render(
        <WorkspaceCollaborationGroupsConfiguration
          groups={[]}
          members={[humanMember]}
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
    await click(byTestId("collaboration-group-create-add-members"));
    expect(
      byTestId("collaboration-group-create-member-agent-1"),
    ).not.toBeNull();
    await click(byTestId("collaboration-group-create-member-human-7"));
    await click(byTestId("collaboration-group-create-member-agent-1"));
    await change(
      byTestId<HTMLInputElement>(
        "collaboration-group-create-responsibility-agent-1",
      ),
      "审查代码",
    );
    await click(byTestId("collaboration-group-leader"));
    await click(byTestId("collaboration-group-leader-agent-1"));
    expect(
      byTestId<HTMLInputElement>(
        "collaboration-group-create-responsibility-human-7",
      ).value,
    ).toBe("");
    expect(
      byTestId<HTMLInputElement>(
        "collaboration-group-create-responsibility-agent-1",
      ).value,
    ).toBe("审查代码");
    expect(
      container.querySelector(".collaboration-group-roster-item:first-child")
        ?.textContent,
    ).toContain("Codex");
    expect(
      container.querySelector(".collaboration-group-roster-item:first-child")
        ?.textContent,
    ).toContain("负责人");
    expect(byTestId("collaboration-group-remove-member-agent-1")).toBeNull();
    expect(
      byTestId("collaboration-group-remove-member-human-7"),
    ).not.toBeNull();
    await click(byTestId("collaboration-group-remove-member-human-7"));
    expect(
      byTestId("collaboration-group-create-responsibility-agent-1"),
    ).not.toBeNull();
    expect(
      byTestId("collaboration-group-create-responsibility-human-7"),
    ).toBeNull();
    commands.createCollaborationGroup = vi.fn(async () => group);
    await change(
      byTestId<HTMLInputElement>("collaboration-group-name"),
      "单人小队",
    );
    await click(byTestId("collaboration-group-create"));
    expect(commands.createCollaborationGroup).toHaveBeenCalledWith(
      expect.objectContaining({
        leader: { kind: "agent", id: "1", responsibility: "" },
        members: [{ kind: "agent", id: "1", responsibility: "" }],
      }),
    );
  });

  it("searches people and agents and restores keyboard focus on Escape", async () => {
    await act(async () =>
      root.render(
        <WorkspaceCollaborationGroupsConfiguration
          groups={[]}
          members={[humanMember]}
          agents={[codexAgent, claudeAgent]}
          locale="en"
          commands={commands}
          canManage
          initialCreateOpen
        />,
      ),
    );
    await click(byTestId("collaboration-group-create-add-members"));
    const search = byTestId<HTMLInputElement>(
      "collaboration-group-members-search",
    );
    await change(search, "missing");
    expect(container.textContent).toContain("No matching people or agents");
    await change(search, "alice");
    expect(byTestId("collaboration-group-create-member-agent-2")).toBeNull();
    await act(async () => {
      search.dispatchEvent(
        new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }),
      );
    });
    expect(document.activeElement).toBe(
      byTestId("collaboration-group-create-member-human-7"),
    );
    await act(async () => {
      document.activeElement!.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
      );
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(byTestId("collaboration-group-members-search")).toBeNull();
    expect(document.activeElement).toBe(
      byTestId("collaboration-group-create-add-members"),
    );
  });

  it("keeps the standalone creator isolated from the group collection without a default-Agent action", async () => {
    await act(async () =>
      root.render(
        <WorkspaceCollaborationGroupsConfiguration
          groups={[group]}
          members={[humanMember]}
          agents={[codexAgent]}
          locale="zh-CN"
          commands={commands}
          canManage
          initialCreateOpen
          showGroupCollection={false}
        />,
      ),
    );

    expect(
      container.querySelector(
        `[data-testid="collaboration-group-${group.id}"]`,
      ),
    ).toBeNull();
    expect(container.querySelector(".collaboration-platform-panel")).toBeNull();
    expect(
      container.querySelector(".collaboration-group-people-editor.is-compact"),
    ).toBeTruthy();
    expect(byTestId("collaboration-group-create-close")).toBeTruthy();
    expect(container.querySelector('section[aria-label="负责人"]')).toBeNull();
    await click(byTestId("collaboration-group-create-add-members"));
    expect(byTestId("collaboration-group-members-search")).toBeTruthy();
    expect(
      byTestId(`collaboration-group-create-member-agent-${codexAgent.team_id}`),
    ).toBeTruthy();
    expect(container.querySelectorAll('[role="alert"]')).toHaveLength(0);
    expect(
      byTestId("collaboration-group-agent-action-create-default"),
    ).toBeNull();
  });

  it("creates a collaboration group from the lightweight form", async () => {
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
          members={[humanMember]}
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
    await click(byTestId("collaboration-group-create-add-members"));
    await click(byTestId("collaboration-group-create-member-human-7"));
    await click(byTestId("collaboration-group-create-member-agent-1"));
    await click(byTestId("collaboration-group-leader"));
    await click(byTestId("collaboration-group-leader-agent-1"));
    expect(
      byTestId("collaboration-group-create-responsibility-agent-1"),
    ).not.toBeNull();
    await change(
      byTestId<HTMLInputElement>(
        "collaboration-group-create-responsibility-human-7",
      ),
      "代码审查",
    );
    await change(
      byTestId<HTMLInputElement>("collaboration-group-description"),
      "负责产品交付",
    );
    await click(byTestId("collaboration-group-create"));

    expect(commands.createCollaborationGroup).toHaveBeenCalledWith({
      name: "交付小组",
      description: "负责产品交付",
      leader: { kind: "agent", id: "1", responsibility: "" },
      members: [
        { kind: "agent", id: "1", responsibility: "" },
        { kind: "human", id: "7", responsibility: "代码审查" },
      ],
      coordinationMode: "manager",
      instructions: "",
      stages: [],
      executionRequirements: {
        requiredTags: [],
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
    await click(byTestId("collaboration-group-remove-member-agent-2"));
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

  it("deletes a collaboration group from its detail page after confirmation", async () => {
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
    await click(byTestId("collaboration-group-detail-delete"));
    expect(commands.removeCollaborationGroup).not.toHaveBeenCalled();
    await click(byTestId("collaboration-group-detail-delete-confirm"));

    expect(commands.removeCollaborationGroup).toHaveBeenCalledWith(group.id);
  });
});
