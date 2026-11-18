// @vitest-environment jsdom
// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

import { act, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createCollaborationTranslator } from "../i18n";
import type { CollaborationIssue, CollaborationProject } from "../types";
import {
  createTestWorkflowNode,
  strategyRevision,
} from "./strategyTestFixtures";
import { IssueWorkflowPanel } from "./IssueWorkflowPanel";

let root: Root | undefined;
let container: HTMLDivElement;
const translate = createCollaborationTranslator("en");
const project = {
  access_role: "Maintainer",
  agentic_strategy_enabled: true,
  collaboration_strategy: strategyRevision,
} as CollaborationProject;
const issue = {
  id: "issue-1",
  version: 4,
  priority: "high",
  workflow: {
    version: 1,
    definition_version: 1,
    strategy_snapshot: strategyRevision,
    strategy_state: "active",
    current_stage_id: "requirement_intake",
    nodes: [
      createTestWorkflowNode("requirement_intake", {
        required_deliverables: [
          {
            id: "acceptance",
            name: "Acceptance criteria",
            description: "",
            value_type: "text",
          },
        ],
      }),
      createTestWorkflowNode("joint_review", {
        depends_on: ["requirement_intake"],
        status: "blocked",
      }),
    ],
  },
} as CollaborationIssue;

async function render(
  overrides: Partial<ComponentProps<typeof IssueWorkflowPanel>> = {},
) {
  if (!root) {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  }
  const onAction = overrides.onAction ?? vi.fn(async () => undefined);
  await act(async () =>
    root!.render(
      <IssueWorkflowPanel
        project={project}
        issue={issue}
        editable
        translate={translate}
        onAction={onAction}
        {...overrides}
      />,
    ),
  );
  return onAction;
}
function button(id: string) {
  return container.querySelector<HTMLButtonElement>(`[data-testid="${id}"]`)!;
}
async function fillReason(reason: string) {
  await act(async () => {
    const input = container.querySelector<HTMLTextAreaElement>(
      '[data-testid="todo-workflow-reason"]',
    )!;
    Object.getOwnPropertyDescriptor(
      HTMLTextAreaElement.prototype,
      "value",
    )!.set!.call(input, reason);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
async function fillField(testId: string, value: string) {
  await act(async () => {
    const input = container.querySelector<
      HTMLInputElement | HTMLTextAreaElement
    >(`[data-testid="${testId}"]`)!;
    const prototype =
      input instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(
      input,
      value,
    );
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  container?.remove();
});

describe("Issue collaboration strategy stages", () => {
  it("shows readable stage names and actionable evidence errors, retaining the retry key", async () => {
    const onAction = vi.fn().mockRejectedValue(
      Object.assign(new Error("Submit missing evidence"), {
        detail: {
          current_stage_id: "requirement_intake",
          missing_deliverables: [
            { id: "acceptance", name: "Acceptance criteria" },
          ],
        },
      }),
    );
    await render({ onAction });
    expect(container.textContent).toContain("Requirement proposal");
    expect(container.textContent).not.toContain("requirement_intake");
    expect(container.textContent).not.toContain("depends_on");
    expect(button("todo-workflow-approve-joint_review").disabled).toBe(true);
    await act(async () =>
      button("todo-workflow-approve-requirement_intake").click(),
    );
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      "Acceptance criteria",
    );
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      "Requirement proposal",
    );
    await act(async () =>
      button("todo-workflow-approve-requirement_intake").click(),
    );
    expect(onAction.mock.calls[0][0].idempotency_key).toBe(
      onAction.mock.calls[1][0].idempotency_key,
    );
  });

  it("requires an explicit reason when attaching a strategy to an existing Issue", async () => {
    const onAction = await render({ issue: { ...issue, workflow: null } });
    expect(onAction).not.toHaveBeenCalled();
    await act(async () => button("issue-strategy-apply").click());
    expect(button("todo-workflow-confirm").disabled).toBe(true);
    await fillReason("Confirmed inbox migration");
    await act(async () => button("todo-workflow-confirm").click());
    expect(onAction).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "apply_project",
        reason: "Confirmed inbox migration",
      }),
      undefined,
    );
  });

  it("upgrades only through a reasoned action and retains the visible old snapshot", async () => {
    const onAction = await render({
      project: {
        ...project,
        collaboration_strategy: { ...strategyRevision, version: 2 },
      },
    });
    expect(container.textContent).toContain("This Issue uses strategy v1");
    expect(onAction).not.toHaveBeenCalled();
    await act(async () => button("issue-strategy-upgrade").click());
    await fillReason("Adopt revised acceptance rules");
    await act(async () => button("todo-workflow-confirm").click());
    expect(onAction).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "upgrade_strategy",
        reason: "Adopt revised acceptance rules",
      }),
      undefined,
    );
  });

  it("records QA rework target and reason while restricting force to maintainers", async () => {
    const qaIssue = {
      ...issue,
      workflow: {
        ...issue.workflow!,
        current_stage_id: "quality_acceptance",
        nodes: [createTestWorkflowNode("quality_acceptance")],
      },
    };
    const onAction = await render({ issue: qaIssue });
    await act(async () =>
      button("todo-workflow-reject-quality_acceptance").click(),
    );
    await fillReason("Visual states incomplete");
    await act(async () => {
      const select = container.querySelector<HTMLSelectElement>(
        '[data-testid="issue-strategy-rework-target"]',
      )!;
      select.value = "development_preparation";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await act(async () => button("todo-workflow-confirm").click());
    expect(onAction).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "decide_node",
        action: "reject",
        rework_to: "development_preparation",
        reason: "Visual states incomplete",
      }),
      undefined,
    );
    await render({ project: { ...project, access_role: "Developer" } });
    expect(
      container.querySelector(
        '[data-testid="todo-workflow-force-requirement_intake"]',
      ),
    ).toBeNull();
  });

  it("records waiting or blocking only after a reason is confirmed", async () => {
    const onAction = await render();
    await act(async () =>
      button("issue-strategy-wait-requirement_intake").click(),
    );
    await fillReason("Awaiting product clarification");
    await act(async () => button("todo-workflow-confirm").click());
    expect(onAction).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "set_stage_state",
        state: "waiting",
        reason: "Awaiting product clarification",
      }),
      undefined,
    );
  });

  it("presents coordinator conditions and clarification with a recorded integration decision", async () => {
    await render({
      issue: {
        ...issue,
        workflow: {
          ...issue.workflow!,
          coordinator_decision: {
            strategy_version: 1,
            issue_version: 4,
            stage: "requirement_intake",
            next_owner: "product-owner",
            next_action: "Complete acceptance evidence",
            satisfied_conditions: ["Definition complete"],
            missing_conditions: ["Acceptance evidence missing"],
            evidence_refs: ["delivery:1"],
            clarification: "Confirm expected behavior",
            idempotency_key: "check-1",
            integration_status: "recorded",
          },
        },
      },
    });
    expect(container.textContent).toContain("product-owner");
    expect(container.textContent).toContain("Acceptance evidence missing");
    expect(
      container.querySelector('[data-testid="issue-strategy-clarification"]')
        ?.textContent,
    ).toContain("Confirm expected behavior");
    expect(
      container.querySelector(
        '[data-testid="issue-strategy-coordinator-recorded"]',
      )?.textContent,
    ).toContain("coordinator recommendation is recorded");
  });

  it("records a role review without advancing the Issue version", async () => {
    const reviewerIssue = {
      ...issue,
      workflow: {
        ...issue.workflow!,
        current_stage_id: "joint_review",
        nodes: [
          createTestWorkflowNode("requirement_intake", { status: "completed" }),
          createTestWorkflowNode("joint_review"),
        ],
      },
    } as CollaborationIssue;
    const onAction = await render({
      issue: reviewerIssue,
      project: { ...project, current_user_id: 8 },
      members: [
        {
          id: 8,
          user_id: 8,
          user_name: "developer",
          email: null,
          role: "Developer",
        },
      ],
    });
    await act(async () =>
      button("todo-workflow-review-no_objection-joint_review").click(),
    );
    await fillField("issue-strategy-review-evidence", "issue:issue-1:4");
    await act(async () => button("issue-strategy-review-submit").click());
    expect(onAction).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "record_stage_review",
        node_id: "joint_review",
        review: expect.objectContaining({
          decision: "no_objection",
          function_role: "development",
        }),
      }),
      undefined,
    );
  });

  it("shows shared PR state and records a successful release for maintainers", async () => {
    const releaseIssue = {
      ...issue,
      status: "in_review",
      workflow: {
        ...issue.workflow!,
        current_stage_id: "release_launch",
        change_request_state: {
          required_pr_ids: ["github:weibo/wegent#9"],
          pull_requests: {
            "github:weibo/wegent#9": {
              url: "https://github.com/weibo/wegent/pull/9",
              repository: "weibo/wegent",
              number: 9,
              state: "merged",
              head_sha: "a".repeat(40),
              checks_summary: "success",
              mergeable: "MERGED",
            },
          },
        },
        nodes: [createTestWorkflowNode("release_launch")],
      },
    } as CollaborationIssue;
    const onAction = await render({ issue: releaseIssue });
    expect(container.textContent).toContain("weibo/wegent#9");
    expect(
      container.querySelector(
        '[data-testid="todo-workflow-approve-release_launch"]',
      ),
    ).toBeNull();
    await act(async () =>
      button("issue-workflow-release-open-release_launch").click(),
    );
    await fillField("issue-workflow-release-version", "v3.0.0");
    await fillField(
      "issue-workflow-release-url",
      "https://example.com/releases/v3",
    );
    await fillField("issue-workflow-release-mergeCommits", "b".repeat(40));
    await fillField(
      "issue-workflow-release-onlineVerification",
      "Production checks passed",
    );
    await fillField(
      "issue-workflow-release-rollbackSummary",
      "Previous artifact retained",
    );
    await fillField(
      "issue-workflow-release-retrospective",
      "No remaining blockers",
    );
    await act(async () => button("issue-workflow-release-submit").click());
    expect(onAction).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "record_release",
        release: expect.objectContaining({
          version: "v3.0.0",
          merge_commits: ["b".repeat(40)],
          successful: true,
        }),
      }),
      undefined,
    );
  });

  it("shows the latest quality review and blocked handoff without leaving the stage", async () => {
    const qualityIssue = {
      ...issue,
      workflow: {
        ...issue.workflow!,
        current_stage_id: "quality_acceptance",
        quality_blocked: true,
        nodes: [
          createTestWorkflowNode("quality_acceptance", {
            status: "ready",
            attempts: 2,
          }),
        ],
        stage_reviews: [
          {
            stage_id: "quality_acceptance",
            function_role: "qa",
            reviewer_id: 9,
            decision: "objection",
            comment: "Regression failed",
            evidence_refs: ["comment:qa-1"],
            issue_version: 4,
            strategy_version: 1,
            created_at: "2026-11-18T09:00:00Z",
            idempotency_key: "qa-review-1",
          },
        ],
      },
    } as CollaborationIssue;
    await render({ issue: qualityIssue });
    expect(container.textContent).toContain(
      "Acceptance is blocked. Engineering must fix it and request review again.",
    );
    expect(
      container.querySelector('[data-testid="issue-strategy-review-qa"]')
        ?.textContent,
    ).toContain("Regression failed");
    expect(container.textContent).toContain("2 attempts");
    expect(
      container.querySelector<HTMLButtonElement>(
        '[data-testid="todo-workflow-approve-quality_acceptance"]',
      )?.disabled,
    ).toBe(true);
  });

  it("preserves active stage completion after flag rollback while hiding condition checks", async () => {
    await render({ project: { ...project, agentic_strategy_enabled: false } });
    expect(container.textContent).toContain("Requirement proposal");
    expect(button("todo-workflow-approve-requirement_intake").disabled).toBe(
      false,
    );
    expect(
      container.querySelector('[data-testid="issue-strategy-evaluate"]'),
    ).toBeNull();
    await render({ editable: false });
    expect(
      container.querySelector(
        '[data-testid="todo-workflow-approve-requirement_intake"]',
      ),
    ).toBeNull();
  });

  it("preserves legacy human stage names without offering strategy replacement", async () => {
    await render({
      issue: {
        ...issue,
        workflow: {
          version: 1,
          definition_version: 1,
          nodes: [
            createTestWorkflowNode("old_node", { name: "Historical review" }),
          ],
        },
      },
    });
    expect(container.textContent).toContain("Historical review");
    expect(container.textContent).not.toContain("old_node");
    expect(
      container.querySelector('[data-testid="issue-strategy-apply"]'),
    ).toBeNull();
  });
});
