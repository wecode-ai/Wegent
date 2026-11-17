// @vitest-environment jsdom

import { act, type ComponentProps } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  SharedIssueDetailEditor,
  type SharedIssueDetailExtensionContext,
} from "./SharedIssueDetailEditor";
import type { SharedIssueDetailPort } from "./issue-detail/createSharedIssueDetailPort";
import type { CollaborationIssue, CollaborationProject } from "./types";

const project = {
  id: "project-1",
  name: "Project",
  project_store: "local",
  task_provider: "local",
  access_role: "Owner",
} as CollaborationProject;
const issue = {
  id: "ISSUE-1",
  cloud_project_id: project.id,
  title: "Keep editing text",
  description: "",
  status: "inbox",
  priority: "none",
  parent_id: null,
  tags: ["old"],
  version: 1,
  can_edit: true,
} as CollaborationIssue;

let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  localStorage.clear();
  vi.unstubAllGlobals();
});

function fixture() {
  const update = vi.fn(async (_id: string, values: object) => ({
    ...issue,
    ...values,
    version: 2,
  }));
  const create = vi.fn(async () => issue);
  const list = vi.fn(async () => []);
  const port = {
    issues: { get: vi.fn(async () => issue), update, create, assign: vi.fn() },
    attachments: { list },
    collaborators: { list },
    taskBindings: { list },
    deliveries: { list },
    members: { list },
    agents: { list },
    collaborationGroups: { list },
  } as unknown as SharedIssueDetailPort;
  const props = {
    port,
    mode: "edit",
    item: issue,
    project,
    editable: true,
    allItems: [issue],
    presentation: "workspace-panel",
    readFirst: true,
    onClose: vi.fn(),
    onUpdated: vi.fn(),
    onAddChild: vi.fn(),
    onOpenRelatedIssue: vi.fn(),
  } satisfies ComponentProps<typeof SharedIssueDetailEditor>;
  return { props, update, create };
}

function control<T extends HTMLElement>(testId: string): T {
  const element = document.querySelector<T>(`[data-testid="${testId}"]`);
  expect(element).not.toBeNull();
  return element!;
}

describe("Issue structure readiness", () => {
  it("disables structural actions during refresh and restores them without disabling discussion", async () => {
    const { props, update } = fixture();
    const activity = vi.fn((_context: SharedIssueDetailExtensionContext) => (
      <div data-testid="discussion" />
    ));
    const render = async (ready: boolean) =>
      act(async () =>
        root.render(
          <SharedIssueDetailEditor
            {...props}
            structuralWritesEnabled={ready}
            extensions={{ renderActivity: activity }}
          />,
        ),
      );
    await render(false);
    for (const name of ["status", "parent", "assignee"]) {
      expect(
        control<HTMLButtonElement>(`cloud-todo-detail-${name}`).disabled,
      ).toBe(true);
    }
    expect(
      container.querySelector('[data-testid="cloud-todo-detail-tag-input"]'),
    ).toBeNull();
    expect(
      container.querySelector('[data-testid="issue-hierarchy-add-child"]'),
    ).toBeNull();
    expect(
      control<HTMLTextAreaElement>("cloud-todo-detail-title").readOnly,
    ).toBe(false);
    expect(
      control<HTMLSelectElement>("cloud-todo-detail-priority").disabled,
    ).toBe(false);
    expect(control("discussion")).toBeTruthy();
    expect(activity.mock.lastCall?.[0]).toMatchObject({
      editable: true,
      commentAssignment: undefined,
      commentActions: { canToggle: false, moves: [] },
    });

    await render(true);
    for (const name of ["status", "parent", "assignee"]) {
      expect(
        control<HTMLButtonElement>(`cloud-todo-detail-${name}`).disabled,
      ).toBe(false);
    }
    expect(control("cloud-todo-detail-tag-input")).toBeTruthy();
    expect(control("issue-hierarchy-add-child")).toBeTruthy();
    const status = control<HTMLSelectElement>("cloud-todo-detail-status");
    await act(async () => {
      status.value = "pending";
      status.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(update).toHaveBeenCalledExactlyOnceWith(issue.id, {
      version: 1,
      status: "pending",
    });
  });

  it("does not grant content or assignment permission when a snapshot becomes ready", async () => {
    const { props, update } = fixture();
    await act(async () =>
      root.render(
        <SharedIssueDetailEditor
          {...props}
          editable={false}
          canAssign={false}
          structuralWritesEnabled
        />,
      ),
    );
    expect(
      control<HTMLSelectElement>("cloud-todo-detail-status").disabled,
    ).toBe(true);
    expect(
      control<HTMLButtonElement>("cloud-todo-detail-assignee").disabled,
    ).toBe(true);
    expect(
      control<HTMLTextAreaElement>("cloud-todo-detail-title").readOnly,
    ).toBe(true);
    expect(update).not.toHaveBeenCalled();
  });

  it("keeps an outside-assignee confirmation pending until structural writes recover", async () => {
    const { props, update } = fixture();
    const assignedIssue = {
      ...issue,
      assignee_user_id: 42,
      assignee_name: "Outside person",
    };
    const assign = vi
      .mocked(props.port.issues.assign)
      .mockResolvedValue({ ...assignedIssue, version: 2 });
    const render = async (ready: boolean) =>
      act(async () =>
        root.render(
          <SharedIssueDetailEditor
            {...props}
            item={assignedIssue}
            allItems={[assignedIssue]}
            structuralWritesEnabled={ready}
          />,
        ),
      );
    await render(true);
    await act(async () =>
      control<HTMLButtonElement>("cloud-todo-detail-assignee").click(),
    );
    await act(async () =>
      control<HTMLButtonElement>(
        "cloud-todo-detail-assignee-option-user:42",
      ).click(),
    );
    expect(control("issue-outside-assignee-dialog")).toBeTruthy();
    expect(assign).not.toHaveBeenCalled();

    await render(false);
    const confirm = control<HTMLButtonElement>(
      "issue-outside-assignee-confirm",
    );
    expect(confirm.disabled).toBe(true);
    await act(async () => confirm.click());
    expect(control("issue-outside-assignee-dialog")).toBeTruthy();
    expect(assign).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();

    await render(true);
    expect(control("issue-outside-assignee-dialog")).toBeTruthy();
    expect(
      control<HTMLButtonElement>("issue-outside-assignee-confirm").disabled,
    ).toBe(false);
    await act(async () =>
      control<HTMLButtonElement>("issue-outside-assignee-confirm").click(),
    );
    expect(assign).toHaveBeenCalledExactlyOnceWith(project.id, issue.id, {
      version: 1,
      assigneeType: "user",
      assigneeId: "42",
      notifyAssignee: true,
    });
    expect(
      document.querySelector('[data-testid="issue-outside-assignee-dialog"]'),
    ).toBeNull();
  });

  it("rechecks readiness when an approved assignee continuation resumes", async () => {
    const { props, update } = fixture();
    const assignedIssue = {
      ...issue,
      assignee_user_id: 42,
      assignee_name: "Outside person",
    };
    const assign = vi
      .mocked(props.port.issues.assign)
      .mockResolvedValue({ ...assignedIssue, version: 2 });
    const editor = (ready: boolean) => (
      <SharedIssueDetailEditor
        {...props}
        item={assignedIssue}
        allItems={[assignedIssue]}
        structuralWritesEnabled={ready}
      />
    );
    await act(async () => root.render(editor(true)));
    await act(async () =>
      control<HTMLButtonElement>("cloud-todo-detail-assignee").click(),
    );
    await act(async () =>
      control<HTMLButtonElement>(
        "cloud-todo-detail-assignee-option-user:42",
      ).click(),
    );
    await act(async () => {
      control<HTMLButtonElement>("issue-outside-assignee-confirm").click();
      flushSync(() => root.render(editor(false)));
    });
    expect(assign).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
    expect(props.onUpdated).not.toHaveBeenCalled();
  });

  it("keeps a create draft editable while submission waits for a current snapshot", async () => {
    const { props, create } = fixture();
    const render = async (ready: boolean) =>
      act(async () =>
        root.render(
          <SharedIssueDetailEditor
            port={props.port}
            mode="create"
            project={project}
            initialParent={null}
            initialStatus="inbox"
            initialTitle="Draft"
            allItems={[]}
            onClose={vi.fn()}
            onCreated={vi.fn()}
            structuralWritesEnabled={ready}
          />,
        ),
      );
    await render(false);
    expect(
      control<HTMLButtonElement>("cloud-todo-create-confirm").disabled,
    ).toBe(true);
    expect(control<HTMLTextAreaElement>("cloud-todo-title").readOnly).toBe(
      false,
    );
    expect(create).not.toHaveBeenCalled();
    await render(true);
    expect(
      control<HTMLButtonElement>("cloud-todo-create-confirm").disabled,
    ).toBe(false);
  });
});
