// @vitest-environment jsdom

// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { IssueAutomationExecutionSummary } from "./IssueAutomationExecutionSummary";
import type { SharedWorkflowNode } from "./workflowTypes";

const nodes: SharedWorkflowNode[] = [
  {
    id: "claude",
    name: "Claude 实现",
    depends_on: [],
    required: true,
    workspace_policy: "none",
    required_assignee_type: "agent",
    required_assignee_id: "agent-claude",
    status: "running",
  },
  {
    id: "codex",
    name: "Codex 验证",
    depends_on: ["claude"],
    required: true,
    workspace_policy: "none",
    required_assignee_type: "agent",
    required_assignee_id: "agent-codex",
    status: "blocked",
  },
];

describe("IssueAutomationExecutionSummary", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  function render(targetNodes: SharedWorkflowNode[], issueCompleted = false) {
    act(() => {
      root.render(
        <IssueAutomationExecutionSummary
          nodes={targetNodes}
          agents={[
            { id: "agent-claude", name: "Claude" },
            { id: "agent-codex", name: "Codex" },
          ]}
          location="cloud"
          issueCompleted={issueCompleted}
          translate={(_key, fallback) => fallback ?? ""}
        />,
      );
    });
  }

  it("shows the rule chain, the active agent, and the blocked dependency", () => {
    render(nodes);

    expect(
      container.querySelector(
        '[data-testid="collaboration-automation-rule-chain"]',
      )?.textContent,
    ).toBe("Claude 实现 → Codex 验证");
    expect(
      container.querySelector(
        '[data-testid="collaboration-automation-stage-0"]',
      )?.textContent,
    ).toContain("执行中 · Claude · 云端空间");
    expect(
      container.querySelector(
        '[data-testid="collaboration-automation-stage-1"]',
      )?.textContent,
    ).toContain("等待 Claude 实现 完成");
    expect(container.textContent).toContain(
      "Claude 实现 完成后将自动进入 Codex 验证",
    );
  });

  it("shows the next agent running only after Claude completes", () => {
    render([
      { ...nodes[0], status: "completed" },
      { ...nodes[1], status: "running" },
    ]);

    expect(
      container.querySelector(
        '[data-testid="collaboration-automation-progress"]',
      )?.textContent,
    ).toContain("1 / 2");
    expect(
      container.querySelector(
        '[data-testid="collaboration-automation-stage-1"]',
      )?.textContent,
    ).toContain("执行中 · Codex · 云端空间");
  });

  it("shows the automatic Issue completion result", () => {
    render(
      nodes.map((node) => ({ ...node, status: "completed" })),
      true,
    );

    expect(
      container.querySelector(
        '[data-testid="collaboration-automation-progress"]',
      )?.textContent,
    ).toContain("2 / 2");
    expect(container.textContent).toContain(
      "所有自动化阶段已完成，Issue 已自动完成",
    );
  });
});
