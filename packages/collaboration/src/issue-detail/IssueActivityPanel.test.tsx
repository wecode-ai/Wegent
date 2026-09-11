// @vitest-environment jsdom

// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { SharedWorkspaceApi } from "../ports/SharedWorkspaceApi";
import type { CollaborationIssue } from "../types";
import { IssueActivityPanel } from "./IssueActivityPanel";

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

  function render(targetIssue: CollaborationIssue) {
    act(() => {
      root.render(
        <IssueActivityPanel
          api={
            {
              assignments: { create: vi.fn() },
              comments: { create: vi.fn() },
            } as unknown as Pick<SharedWorkspaceApi, "assignments" | "comments">
          }
          issue={targetIssue}
          members={[
            {
              id: 1,
              user_id: 7,
              user_name: "李明",
              email: null,
              role: "Developer",
            },
          ]}
          agents={[]}
          assignments={[]}
          comments={[]}
          executions={[]}
          canComment
          canAssign
          translate={(_key, fallback) => fallback ?? ""}
          onIssueChange={vi.fn()}
          onAssignmentsChange={vi.fn()}
          onCommentsChange={vi.fn()}
          onError={vi.fn()}
        />,
      );
    });
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

  it("clears the draft assignment when the issue changes", () => {
    render(issue);
    change("collaboration-issue-comment", "正在处理");
    change("collaboration-assignment-target", "human:7");
    change("collaboration-assignment-workflow-step", "开发");

    render({ ...issue, id: "issue-2", sequence_number: 2 });

    expect(
      (
        container.querySelector(
          '[data-testid="collaboration-issue-comment"]',
        ) as HTMLTextAreaElement
      ).value,
    ).toBe("");
    expect(
      (
        container.querySelector(
          '[data-testid="collaboration-assignment-target"]',
        ) as HTMLSelectElement
      ).value,
    ).toBe("");
    expect(
      (
        container.querySelector(
          '[data-testid="collaboration-assignment-workflow-step"]',
        ) as HTMLInputElement
      ).value,
    ).toBe("");
  });
});
