// @vitest-environment jsdom

// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { SharedWorkspaceApi } from "../ports/SharedWorkspaceApi";
import type {
  CollaborationAgent,
  CollaborationAssignment,
  CollaborationComment,
  CollaborationExecution,
  CollaborationIssue,
  CollaborationMember,
} from "../types";
import {
  activityDisplayBody,
  issueActivityEntries,
  IssueActivityPanel,
} from "./IssueActivityPanel";

const issue = {
  id: "issue-1",
  cloud_project_id: "project-1",
  sequence_number: 1,
  parent_id: null,
  created_by_user_id: 1,
  assignee_user_id: null,
  title: "Issue one",
  description: "",
  status: "inbox",
  priority: "none",
  due_at: null,
  tags: [],
  sort_order: 0,
  version: 1,
  created_at: "2026-09-11T00:00:00Z",
  updated_at: "2026-09-11T00:00:00Z",
  completed_at: null,
} satisfies CollaborationIssue;

describe("IssueActivityPanel", () => {
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

  function render(
    targetIssue: CollaborationIssue,
    options: {
      assignments?: CollaborationAssignment[];
      executions?: CollaborationExecution[];
      comments?: CollaborationComment[];
      api?: Pick<SharedWorkspaceApi, "assignments" | "comments">;
      onAssignmentsChange?: ReturnType<typeof vi.fn>;
      onCommentsChange?: ReturnType<typeof vi.fn>;
      onError?: ReturnType<typeof vi.fn>;
      canComment?: boolean;
      canAssign?: boolean;
      members?: CollaborationMember[];
      agents?: CollaborationAgent[];
    } = {},
  ) {
    const api =
      options.api ??
      ({
        assignments: { create: vi.fn() },
        comments: { create: vi.fn() },
      } as unknown as Pick<SharedWorkspaceApi, "assignments" | "comments">);
    const onAssignmentsChange = options.onAssignmentsChange ?? vi.fn();
    const onCommentsChange = options.onCommentsChange ?? vi.fn();
    act(() => {
      root.render(
        <IssueActivityPanel
          api={api}
          issue={targetIssue}
          members={
            options.members ?? [
              {
                id: 1,
                user_id: 7,
                user_name: "李明",
                email: null,
                role: "Developer",
              },
            ]
          }
          agents={options.agents ?? []}
          assignments={options.assignments ?? []}
          comments={options.comments ?? []}
          executions={options.executions ?? []}
          canComment={options.canComment ?? true}
          canAssign={options.canAssign ?? true}
          translate={(_key, fallback) => fallback ?? ""}
          onIssueChange={vi.fn()}
          onAssignmentsChange={onAssignmentsChange}
          onCommentsChange={onCommentsChange}
          onError={options.onError ?? vi.fn()}
        />,
      );
    });
    return { api, onAssignmentsChange, onCommentsChange };
  }

  function change(testId: string, value: string) {
    const target = container.querySelector<HTMLElement>(
      `[data-testid="${testId}"]`,
    ) as HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;
    const prototype =
      target instanceof HTMLSelectElement
        ? HTMLSelectElement.prototype
        : target instanceof HTMLTextAreaElement
          ? HTMLTextAreaElement.prototype
          : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, "value")?.set?.call(
      target,
      value,
    );
    act(() => {
      target.dispatchEvent(new Event("change", { bubbles: true }));
      target.dispatchEvent(new Event("input", { bubbles: true }));
    });
  }

  async function click(testId: string) {
    const target = container.querySelector<HTMLButtonElement>(
      `[data-testid="${testId}"]`,
    );
    expect(target).toBeTruthy();
    await act(async () => {
      target?.click();
      await Promise.resolve();
      await Promise.resolve();
    });
  }

  it("keeps one comment composer and clears it when the issue changes", () => {
    render(issue);
    change("collaboration-issue-comment", "正在处理");

    render({ ...issue, id: "issue-2", sequence_number: 2 });

    expect(
      (
        container.querySelector(
          '[data-testid="collaboration-issue-comment"]',
        ) as HTMLTextAreaElement
      ).value,
    ).toBe("");
    expect(
      container.querySelector(
        '[data-testid="collaboration-assignment-target"]',
      ),
    ).toBeNull();
    expect(
      container.querySelector(
        '[data-testid="collaboration-assignment-workflow-step"]',
      ),
    ).toBeNull();
    expect(container.querySelectorAll("textarea")).toHaveLength(1);
  });

  it("expands the one-line composer on focus and collapses it when empty", () => {
    render(issue);

    const textarea = container.querySelector<HTMLTextAreaElement>(
      '[data-testid="collaboration-issue-comment"]',
    );
    const composer = textarea?.closest<HTMLElement>(
      ".issue-comment-composer-shell",
    );
    expect(composer?.dataset.expanded).toBe("false");

    act(() => textarea?.focus());
    expect(composer?.dataset.expanded).toBe("true");

    act(() => textarea?.blur());
    expect(composer?.dataset.expanded).toBe("false");

    act(() => textarea?.focus());
    change("collaboration-issue-comment", "补充上下文");
    act(() => textarea?.blur());
    expect(composer?.dataset.expanded).toBe("true");
  });

  it("inserts a selected mention into the shared comment body", async () => {
    render(issue);

    await click("collaboration-issue-mention-trigger");
    expect(
      container.querySelector(
        '[data-testid="collaboration-issue-mention-popup"]',
      ),
    ).toBeTruthy();
    await click("collaboration-issue-mention-member-7");

    expect(
      (
        container.querySelector(
          '[data-testid="collaboration-issue-comment"]',
        ) as HTMLTextAreaElement
      ).value,
    ).toBe("@李明 ");
    expect(
      container.querySelector(
        '[data-testid="collaboration-issue-assignment-preview"]',
      ),
    ).toBeNull();
    expect(
      container
        .querySelector('[data-testid="collaboration-issue-comment-submit"]')
        ?.getAttribute("aria-label"),
    ).toBe("发送");
  });

  it("replaces the typed mention trigger instead of inserting a second at sign", async () => {
    render(issue);

    change("collaboration-issue-comment", "@");
    await click("collaboration-issue-mention-member-7");

    expect(
      (
        container.querySelector(
          '[data-testid="collaboration-issue-comment"]',
        ) as HTMLTextAreaElement
      ).value,
    ).toBe("@李明 ");
  });

  it("inserts the exact selected collaborator when names share a prefix", async () => {
    const prefixMember = {
      id: 2,
      user_id: 8,
      user_name: "李",
      email: null,
      role: "Developer",
    } satisfies CollaborationMember;
    render(issue, {
      members: [
        prefixMember,
        {
          id: 1,
          user_id: 7,
          user_name: "李明",
          email: null,
          role: "Developer",
        },
      ],
    });

    await click("collaboration-issue-mention-trigger");
    await click("collaboration-issue-mention-member-7");

    expect(
      (
        container.querySelector(
          '[data-testid="collaboration-issue-comment"]',
        ) as HTMLTextAreaElement
      ).value,
    ).toBe("@李明 ");
  });

  it("keeps mention insertion independent from assignment", async () => {
    render(issue);

    await click("collaboration-issue-mention-trigger");
    await click("collaboration-issue-mention-member-7");
    expect(
      (
        container.querySelector(
          '[data-testid="collaboration-issue-comment"]',
        ) as HTMLTextAreaElement
      ).value,
    ).toBe("@李明 ");
    expect(
      container.querySelector(
        '[data-testid="collaboration-issue-assignment-preview"]',
      ),
    ).toBeNull();
    expect(
      container
        .querySelector('[data-testid="collaboration-issue-comment-submit"]')
        ?.getAttribute("aria-label"),
    ).toBe("发送");
    expect(
      container.querySelector<HTMLElement>(".issue-comment-composer-shell")
        ?.dataset.expanded,
    ).toBe("true");
  });

  it("does not infer an assignment from manually typed mention text", () => {
    render(issue, {
      members: [
        {
          id: 2,
          user_id: 8,
          user_name: "李",
          email: null,
          role: "Developer",
        },
      ],
    });

    change("collaboration-issue-comment", "@李明 看一下");

    expect(
      container.querySelector(
        '[data-testid="collaboration-issue-assignment-preview"]',
      ),
    ).toBeNull();
    expect(
      container
        .querySelector('[data-testid="collaboration-issue-comment-submit"]')
        ?.getAttribute("aria-label"),
    ).toBe("发送");
  });

  it("does not turn an agent mention into an assignment", async () => {
    render(issue, {
      agents: [{ id: "agent-1", name: "李明" }],
    });

    await click("collaboration-issue-mention-trigger");
    await click("collaboration-issue-mention-agent-agent-1");

    expect(
      container.querySelector(
        '[data-testid="collaboration-issue-assignment-preview"]',
      ),
    ).toBeNull();
  });

  it("keeps assignment available when commenting is disabled", async () => {
    const assignment = {
      id: "assignment-1",
      issue_id: issue.id,
      target_type: "human",
      target_id: "7",
      target_name: "李明",
      workflow_step: null,
      body: "",
      comment_id: null,
      created_by_user_id: 1,
      created_by_user_name: "项目经理",
      status: "active",
      created_at: "2026-09-14T00:00:00Z",
      updated_at: "2026-09-14T00:00:00Z",
    } satisfies CollaborationAssignment;
    const api = {
      assignments: {
        create: vi.fn().mockResolvedValue({
          issue,
          assignment,
          comment: null,
        }),
      },
      comments: { create: vi.fn() },
    } as unknown as Pick<SharedWorkspaceApi, "assignments" | "comments">;
    const { onAssignmentsChange } = render(issue, {
      canComment: false,
      canAssign: true,
      api,
    });

    change("collaboration-issue-comment", "请处理登录异常");
    expect(
      container.querySelector<HTMLButtonElement>(
        '[data-testid="collaboration-issue-comment-submit"]',
      )?.disabled,
    ).toBe(true);

    await click("collaboration-issue-assignment-trigger");
    await click("collaboration-issue-assign-member-7");
    expect(api.assignments?.create).toHaveBeenCalledWith(issue.id, {
      targetType: "human",
      targetId: "7",
      workflowStep: null,
      notifyTarget: true,
    });
    expect(onAssignmentsChange).toHaveBeenCalledWith([assignment]);
  });

  it("submits a plain body through comments.create", async () => {
    const comment = {
      id: "comment-1",
      issue_id: issue.id,
      author: "李明",
      body: "已确认接口契约",
      created_at: "2026-09-12T00:00:00Z",
    } satisfies CollaborationComment;
    const api = {
      assignments: { create: vi.fn() },
      comments: { create: vi.fn().mockResolvedValue(comment) },
    } as unknown as Pick<SharedWorkspaceApi, "assignments" | "comments">;
    const { onCommentsChange } = render(issue, { api });

    change("collaboration-issue-comment", comment.body);
    await click("collaboration-issue-comment-submit");

    expect(api.comments.create).toHaveBeenCalledWith(issue.id, comment.body);
    expect(api.assignments?.create).not.toHaveBeenCalled();
    expect(onCommentsChange).toHaveBeenCalledWith([comment]);
    expect(
      container.querySelector<HTMLElement>(".issue-comment-composer-shell")
        ?.dataset.expanded,
    ).toBe("false");
  });

  it("clears the composer before a pending comment request resolves", async () => {
    let resolveComment: ((comment: CollaborationComment) => void) | undefined;
    const pendingComment = new Promise<CollaborationComment>((resolve) => {
      resolveComment = resolve;
    });
    const comment = {
      id: "comment-1",
      issue_id: issue.id,
      author: "李明",
      body: "已确认接口契约",
      created_at: "2026-09-12T00:00:00Z",
    } satisfies CollaborationComment;
    const api = {
      assignments: { create: vi.fn() },
      comments: { create: vi.fn().mockReturnValue(pendingComment) },
    } as unknown as Pick<SharedWorkspaceApi, "assignments" | "comments">;
    render(issue, { api });

    change("collaboration-issue-comment", comment.body);
    const submitButton = container.querySelector<HTMLButtonElement>(
      '[data-testid="collaboration-issue-comment-submit"]',
    );
    act(() => submitButton?.click());

    expect(
      (
        container.querySelector(
          '[data-testid="collaboration-issue-comment"]',
        ) as HTMLTextAreaElement
      ).value,
    ).toBe("");

    await act(async () => {
      resolveComment?.(comment);
      await pendingComment;
    });
  });

  it("restores the submitted body when comment creation fails", async () => {
    const onError = vi.fn();
    const api = {
      assignments: { create: vi.fn() },
      comments: {
        create: vi.fn().mockRejectedValue(new Error("request failed")),
      },
    } as unknown as Pick<SharedWorkspaceApi, "assignments" | "comments">;
    render(issue, { api, onError });

    change("collaboration-issue-comment", "  保留失败内容  ");
    await click("collaboration-issue-comment-submit");

    expect(
      (
        container.querySelector(
          '[data-testid="collaboration-issue-comment"]',
        ) as HTMLTextAreaElement
      ).value,
    ).toBe("  保留失败内容  ");
    expect(onError).toHaveBeenCalledOnce();
  });

  it("does not restore a stale submission after switching issues", async () => {
    let rejectComment: ((error: Error) => void) | undefined;
    const pendingComment = new Promise<CollaborationComment>(
      (_resolve, reject) => {
        rejectComment = reject;
      },
    );
    const onError = vi.fn();
    const api = {
      assignments: { create: vi.fn() },
      comments: { create: vi.fn().mockReturnValue(pendingComment) },
    } as unknown as Pick<SharedWorkspaceApi, "assignments" | "comments">;
    render(issue, { api, onError });

    change("collaboration-issue-comment", "旧 Issue 内容");
    act(() => {
      container
        .querySelector<HTMLButtonElement>(
          '[data-testid="collaboration-issue-comment-submit"]',
        )
        ?.click();
    });
    render({ ...issue, id: "issue-2", sequence_number: 2 }, { api, onError });

    await act(async () => {
      rejectComment?.(new Error("request failed"));
      await pendingComment.catch(() => undefined);
    });

    expect(
      (
        container.querySelector(
          '[data-testid="collaboration-issue-comment"]',
        ) as HTMLTextAreaElement
      ).value,
    ).toBe("");
    expect(onError).not.toHaveBeenCalled();
  });

  it("does not publish a stale successful submission after switching issues", async () => {
    let resolveComment: ((comment: CollaborationComment) => void) | undefined;
    const pendingComment = new Promise<CollaborationComment>((resolve) => {
      resolveComment = resolve;
    });
    const submittedComment = {
      id: "comment-old-issue",
      issue_id: issue.id,
      author: "李明",
      body: "旧 Issue 评论",
      created_at: "2026-09-12T00:00:00Z",
    } satisfies CollaborationComment;
    const onCommentsChange = vi.fn();
    const api = {
      assignments: { create: vi.fn() },
      comments: { create: vi.fn().mockReturnValue(pendingComment) },
    } as unknown as Pick<SharedWorkspaceApi, "assignments" | "comments">;
    render(issue, { api, onCommentsChange });

    change("collaboration-issue-comment", submittedComment.body);
    act(() => {
      container
        .querySelector<HTMLButtonElement>(
          '[data-testid="collaboration-issue-comment-submit"]',
        )
        ?.click();
    });
    render(
      { ...issue, id: "issue-2", sequence_number: 2 },
      { api, onCommentsChange },
    );

    await act(async () => {
      resolveComment?.(submittedComment);
      await pendingComment;
    });

    expect(onCommentsChange).not.toHaveBeenCalled();
  });

  it("submits a recognized mention as a normal comment", async () => {
    const comment = {
      id: "comment-1",
      issue_id: issue.id,
      author: "项目经理",
      body: "@李明 请处理登录异常",
      created_at: "2026-09-12T00:00:00Z",
    } satisfies CollaborationComment;
    const api = {
      assignments: { create: vi.fn() },
      comments: { create: vi.fn().mockResolvedValue(comment) },
    } as unknown as Pick<SharedWorkspaceApi, "assignments" | "comments">;
    const { onAssignmentsChange, onCommentsChange } = render(issue, { api });

    await click("collaboration-issue-mention-trigger");
    await click("collaboration-issue-mention-member-7");
    change("collaboration-issue-comment", comment.body);
    await click("collaboration-issue-comment-submit");

    expect(api.assignments?.create).not.toHaveBeenCalled();
    expect(api.comments.create).toHaveBeenCalledWith(issue.id, comment.body);
    expect(onAssignmentsChange).not.toHaveBeenCalled();
    expect(onCommentsChange).toHaveBeenCalledWith([comment]);
    expect(
      (
        container.querySelector(
          '[data-testid="collaboration-issue-comment"]',
        ) as HTMLTextAreaElement
      ).value,
    ).toBe("");
    expect(
      container.querySelector<HTMLElement>(".issue-comment-composer-shell")
        ?.dataset.expanded,
    ).toBe("false");
    expect(
      container.querySelector(
        '[data-testid="collaboration-issue-assignment-preview"]',
      ),
    ).toBeNull();
    expect(
      container
        .querySelector('[data-testid="collaboration-issue-comment-submit"]')
        ?.getAttribute("aria-label"),
    ).toBe("发送");
  });

  it("submits a mention of an active assignee as a normal comment", async () => {
    const activeAssignment = {
      id: "assignment-1",
      issue_id: issue.id,
      target_type: "human",
      target_id: "7",
      target_name: "李明",
      workflow_step: null,
      body: "",
      comment_id: "assignment-1",
      created_by_user_id: 1,
      created_by_user_name: "项目经理",
      status: "active",
      created_at: "2026-09-12T00:00:00Z",
      updated_at: "2026-09-12T00:00:00Z",
    } satisfies CollaborationAssignment;
    const body = "@李明 请继续补充验证结果";
    const comment = {
      id: "comment-2",
      issue_id: issue.id,
      author: "项目经理",
      body,
      created_at: "2026-09-12T00:01:00Z",
    } satisfies CollaborationComment;
    const api = {
      assignments: { create: vi.fn() },
      comments: { create: vi.fn().mockResolvedValue(comment) },
    } as unknown as Pick<SharedWorkspaceApi, "assignments" | "comments">;
    const { onCommentsChange } = render(issue, {
      api,
      assignments: [activeAssignment],
    });

    await click("collaboration-issue-mention-trigger");
    await click("collaboration-issue-mention-member-7");
    change("collaboration-issue-comment", body);

    expect(
      container.querySelector(
        '[data-testid="collaboration-issue-assignment-preview"]',
      ),
    ).toBeNull();
    expect(
      container
        .querySelector('[data-testid="collaboration-issue-comment-submit"]')
        ?.getAttribute("aria-label"),
    ).toBe("发送");

    await click("collaboration-issue-comment-submit");

    expect(api.assignments?.create).not.toHaveBeenCalled();
    expect(api.comments.create).toHaveBeenCalledWith(issue.id, body);
    expect(onCommentsChange).toHaveBeenCalledWith([comment]);
  });

  it("renders an assignment comment event only once", () => {
    const assignment = {
      id: "comment-1",
      comment_id: "comment-1",
      created_at: "2026-09-12T00:00:00Z",
    } as CollaborationAssignment;
    const comment = {
      id: "comment-1",
      created_at: "2026-09-12T00:00:00Z",
    } as CollaborationComment;

    expect(issueActivityEntries([assignment], [comment], [])).toEqual([
      {
        kind: "assignment",
        at: "2026-09-12T00:00:00Z",
        assignment,
      },
    ]);
  });

  it("converts internal automation markers into product language", () => {
    expect(
      activityDisplayBody("CLAUDE_STAGE_PLAN_SUBMITTED", "分配给 @Claude"),
    ).toBe("自动化规则已将当前阶段分配给 Claude");
    expect(
      activityDisplayBody("LOCAL_AUTOMATION_CLAUDE_STAGE_E2E_COMPLETED", ""),
    ).toBe("Claude 已完成，Codex 阶段已自动解锁");
    expect(
      activityDisplayBody("LOCAL_AUTOMATION_CODEX_STAGE_E2E_COMPLETED", ""),
    ).toBe("Codex 已完成，所有自动化阶段已完成");
    expect(activityDisplayBody("正常评论", "")).toBe("正常评论");
  });

  it("does not show an execution from before the current assignment", () => {
    const assignment = {
      id: "assignment-1",
      issue_id: issue.id,
      target_type: "agent",
      target_id: "agent-1",
      target_name: "Codex",
      workflow_step: null,
      body: "",
      comment_id: null,
      created_by_user_id: 1,
      created_by_user_name: "李明",
      status: "active",
      created_at: "2026-09-12T09:00:00Z",
      updated_at: "2026-09-12T09:00:00Z",
    } satisfies CollaborationAssignment;
    const staleExecution = {
      id: 1,
      loop_item_id: issue.id,
      cloud_project_id: issue.cloud_project_id,
      task_title: "Old run",
      task_status: null,
      task_priority: null,
      executor_type: "agent",
      agent_id: "agent-1",
      assigner_user_id: 1,
      executor_owner_user_id: null,
      status: "completed",
      display_state: "已完成",
      observed_state: "completed",
      sync_state: "synced",
      queued_at: null,
      execution_note: null,
      runtime_profile_id: null,
      runtime_source: "旧运行环境",
      can_select_runtime: false,
      waiting_runtime_reason: null,
      version: 1,
      created_at: "2026-09-12T08:00:00Z",
      updated_at: "2026-09-12T08:30:00Z",
    } satisfies CollaborationExecution;

    render(issue, {
      assignments: [assignment],
      executions: [staleExecution],
    });

    const current = container.querySelector(
      '[data-testid="collaboration-current-assignment"]',
    );
    expect(current?.textContent).toContain("已分配");
    expect(current?.textContent).not.toContain("已完成");
    expect(current?.textContent).not.toContain("旧运行环境");
  });
});
