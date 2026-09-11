// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { Children, type ReactElement, type ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return {
    ...actual,
    useMemo: <T,>(factory: () => T) => factory(),
    useState: <T,>(initialValue: T) => [initialValue, vi.fn()],
  };
});

vi.mock("./issue-detail", () => ({
  createSharedIssueDetailPort: () => ({
    issues: {
      create: vi.fn(),
      update: vi.fn(),
      assign: vi.fn(),
    },
  }),
}));

import { IssueCreate, IssueDetail } from "./IssueDetail";
import { SharedIssueDetailEditor } from "./SharedIssueDetailEditor";
import { collaborationMessages } from "./i18n";
import type { SharedWorkspaceApi } from "./ports/SharedWorkspaceApi";
import type { CollaborationIssue, CollaborationProject } from "./types";

const project = {
  id: "project-1",
  project_key: "PRJ",
  name: "Project",
  description: "",
  project_store: "backend",
  task_provider: "local",
  provider_config: {},
  created_by_user_id: 1,
  status: "active",
  tags: [],
  version: 1,
  created_at: "2026-09-11T00:00:00Z",
  updated_at: "2026-09-11T00:00:00Z",
} satisfies CollaborationProject;

const issue = {
  id: "issue-1",
  cloud_project_id: project.id,
  sequence_number: 1,
  parent_id: null,
  created_by_user_id: 1,
  assignee_user_id: null,
  title: "Issue",
  description: "",
  status: "inbox",
  priority: "none",
  due_at: "2026-09-12T02:30:00Z",
  tags: [],
  sort_order: 0,
  version: 1,
  created_at: "2026-09-11T00:00:00Z",
  updated_at: "2026-09-11T00:00:00Z",
  completed_at: null,
} satisfies CollaborationIssue;

function descendants(node: ReactNode): ReactElement[] {
  if (!node || typeof node !== "object" || !("props" in node)) return [];
  const element = node as ReactElement;
  return [
    element,
    ...Children.toArray(element.props.children).flatMap((child) =>
      descendants(child),
    ),
  ];
}

function editorFrom(element: ReactElement): ReactElement {
  const editor = descendants(element).find(
    (candidate) => candidate.type === SharedIssueDetailEditor,
  );
  expect(editor).toBeDefined();
  return editor!;
}

describe("IssueDetail browser due date boundary", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it.each([
    [
      "create",
      () =>
        IssueCreate({
          api: {} as SharedWorkspaceApi,
          project,
          allIssues: [],
          messages: collaborationMessages["zh-CN"],
          onClose: vi.fn(),
          onCreated: vi.fn(),
          onError: vi.fn(),
        }),
    ],
    [
      "edit",
      () =>
        IssueDetail({
          api: {} as SharedWorkspaceApi,
          project,
          issue,
          allIssues: [issue],
          comments: [],
          messages: collaborationMessages["zh-CN"],
          onClose: vi.fn(),
          onChange: vi.fn(),
          onCommentsChange: vi.fn(),
          onConflict: vi.fn(),
          onError: vi.fn(),
        }),
    ],
  ])(
    "wires %s datetime-local values through local time and UTC",
    (_, render) => {
      vi.stubEnv("TZ", "Asia/Shanghai");
      const editor = editorFrom(render());
      const extensions = editor.props.extensions;

      expect(extensions.dueDateInputType).toBe("datetime-local");
      expect(extensions.dueDateFromSource(issue.due_at)).toBe(
        "2026-09-12T10:30",
      );
      expect(extensions.dueDateToSource("2026-09-12T10:30")).toBe(
        "2026-09-12T02:30:00.000Z",
      );
    },
  );
});
