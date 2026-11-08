// @vitest-environment jsdom

import { act, type ComponentProps } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";
import { ProjectBoardAdapter } from "./ProjectBoardAdapter";
import { createCollaborationTranslator } from "../i18n";

type Props = ComponentProps<typeof ProjectBoardAdapter>;

function fixture(): Props {
  const issue = {
    id: "creator",
    title: "Creator",
    parent_id: null,
    tags: [],
    status: "pending",
    priority: "medium",
    sequence_number: 1,
    created_by_user_id: 7,
    created_at: "2026-11-04T00:00:00Z",
    updated_at: "2026-11-04T00:00:00Z",
  };
  return {
    project: {
      id: "project",
      project_key: "TEST",
      name: "Project",
      project_store: "local",
      task_provider: "local",
      current_user_id: 7,
      tags: [],
    },
    issues: [
      issue,
      { ...issue, id: "other", assignee_user_id: 8 },
      { ...issue, id: "ai", execution_state: "running" },
      { ...issue, id: "stand-in" },
      {
        ...issue,
        id: "question",
        execution_state: "running",
        assignee_user_id: 8,
        human_requests: [
          {
            id: "question-1",
            status: "pending",
            recipient_user_id: null,
            responsible_user_id: 7,
          },
        ],
      },
      { ...issue, id: "completed", status: "completed" },
    ],
    agents: [],
    members: [],
    taskBindings: [
      {
        id: "binding",
        issueId: "stand-in",
        deviceId: "device",
        taskId: "task",
      },
    ],
    boardError: null,
    statuses: [
      { id: "pending", name: "Pending", color: "gray" },
      { id: "completed", name: "Completed", color: "green" },
    ],
    labels: {
      groupBy: "Group",
      groupStatus: "Status",
      groupAssignee: "Assignee",
      groupPriority: "Priority",
      groupTag: "Tag",
      noIssues: "Empty",
      noPriority: "None",
      noTag: "None",
      search: "Search",
      unassigned: "None",
    },
    translate: createCollaborationTranslator("zh-CN"),
    onCreateIssue: vi.fn(),
    onMove: vi.fn(),
    onOpen: vi.fn(),
    onSaveViews: vi.fn(),
    renderIssueCard: ({ issue }) => (
      <span data-testid={`visible-${issue.id}`}>{issue.id}</span>
    ),
  } as unknown as Props;
}

describe("active project needs-my-input quick filter", () => {
  it("separates native local handling identity zero from the authenticated permission identity", () => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    const container = document.createElement("div");
    const root = createRoot(container);
    const props = fixture();
    props.project = {
      ...props.project,
      board_views: {
        schema_version: 1,
        default_view_id: "personal",
        views: [
          {
            id: "personal",
            name: "Personal",
            columns: [{ id: "pending", type: "status", value: "pending" }],
            filter: { needs_my_input: true },
          },
        ],
      },
    };
    const issues = [
      { ...props.issues[0], created_by_user_id: 0 },
      { ...props.issues[1], created_by_user_id: 7, assignee_user_id: null },
    ];
    try {
      act(() =>
        root.render(
          <ProjectBoardAdapter
            {...props}
            issues={issues}
            participationUserId={0}
          />,
        ),
      );
      const filter = container.querySelector<HTMLButtonElement>(
        '[data-testid="project-needs-my-input-filter"]',
      )!;
      expect(filter.textContent).toBe("待我处理1");
      act(() => filter.click());
      expect(
        container.querySelector('[data-testid="visible-creator"]'),
      ).toBeTruthy();
      expect(
        container.querySelector('[data-testid="visible-other"]'),
      ).toBeNull();
      expect(props.project.current_user_id).toBe(7);
      act(() =>
        root.render(
          <ProjectBoardAdapter
            {...props}
            issues={issues}
            participationUserId={7}
          />,
        ),
      );
      expect(filter.getAttribute("aria-pressed")).toBe("false");
      act(() => filter.click());
      expect(
        container.querySelector('[data-testid="visible-creator"]'),
      ).toBeNull();
      expect(
        container.querySelector('[data-testid="visible-other"]'),
      ).toBeTruthy();
      expect(props.onSaveViews).not.toHaveBeenCalled();
    } finally {
      act(() => root.unmount());
      localStorage.clear();
    }
  });

  it("uses current human responsibility, live host execution and resets without saving views", () => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    const container = document.createElement("div");
    const root = createRoot(container);
    const props = fixture();
    const isIssueRunning = vi.fn((_issue, bindings) => bindings.length > 0);
    const filter = () =>
      container.querySelector<HTMLButtonElement>(
        '[data-testid="project-needs-my-input-filter"]',
      )!;
    const visible = (id: string) =>
      container.querySelector(`[data-testid="visible-${id}"]`);
    try {
      act(() =>
        root.render(
          <ProjectBoardAdapter {...props} isIssueRunning={isIssueRunning} />,
        ),
      );
      expect(filter().textContent).toBe("待我处理2");
      expect(filter().getAttribute("aria-pressed")).toBe("false");
      act(() => filter().click());
      expect(filter().getAttribute("aria-pressed")).toBe("true");
      expect(visible("creator")).toBeTruthy();
      expect(visible("question")).toBeTruthy();
      for (const id of ["other", "ai", "stand-in", "completed"])
        expect(visible(id)).toBeNull();
      expect(props.onSaveViews).not.toHaveBeenCalled();

      act(() =>
        root.render(
          <ProjectBoardAdapter {...props} isIssueRunning={() => false} />,
        ),
      );
      expect(filter().getAttribute("aria-pressed")).toBe("true");
      expect(filter().textContent).toBe("待我处理3");
      expect(visible("stand-in")).toBeTruthy();

      act(() =>
        root.render(
          <ProjectBoardAdapter
            {...props}
            isIssueRunning={isIssueRunning}
            project={{ ...props.project, id: "second-project" }}
          />,
        ),
      );
      expect(filter().getAttribute("aria-pressed")).toBe("false");
      expect(visible("stand-in")).toBeTruthy();
      act(() => filter().click());
      act(() =>
        root.render(
          <ProjectBoardAdapter
            {...props}
            isIssueRunning={isIssueRunning}
            project={{
              ...props.project,
              id: "second-project",
              current_user_id: 8,
            }}
          />,
        ),
      );
      expect(filter().getAttribute("aria-pressed")).toBe("false");
      expect(filter().textContent).toBe("待我处理1");
      expect(props.onSaveViews).not.toHaveBeenCalled();
    } finally {
      act(() => root.unmount());
      localStorage.clear();
    }
  });

  it("keeps browser live execution matching when a host customizes cards", async () => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    const container = document.createElement("div");
    const root = createRoot(container);
    const props = fixture();
    const listRuntimeWork = vi.fn().mockResolvedValue({
      projects: [],
      chats: [
        { deviceId: "device", tasks: [{ taskId: "task", running: true }] },
      ],
      totalTasks: 1,
    });
    try {
      await act(async () =>
        root.render(
          <ProjectBoardAdapter
            {...props}
            runtime={
              { work: { listRuntimeWork } } as unknown as Props["runtime"]
            }
          />,
        ),
      );
      expect(listRuntimeWork).toHaveBeenCalledTimes(1);
      const filter = container.querySelector<HTMLButtonElement>(
        '[data-testid="project-needs-my-input-filter"]',
      )!;
      expect(filter.textContent).toBe("待我处理2");
      act(() => filter.click());
      expect(
        container.querySelector('[data-testid="visible-stand-in"]'),
      ).toBeNull();
      expect(
        container.querySelector('[data-testid="visible-question"]'),
      ).toBeTruthy();
    } finally {
      act(() => root.unmount());
      localStorage.clear();
    }
  });
});
