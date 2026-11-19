// @vitest-environment jsdom
import { act, Component } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it } from "vitest";
import {
  IssueDetailDraftProvider,
  useIssueDetailDraft,
  type IssueDetailDraftSource,
} from "./IssueDetailDraft";

type Workflow = { step: string };
const original: IssueDetailDraftSource<Workflow> = {
  id: "issue",
  cloud_project_id: "project-a",
  version: 1,
  title: "Original title",
  description: "Original description",
  status: "inbox",
  priority: "none",
  parent_id: null,
  start_at: null,
  due_at: null,
  tags: ["old"],
  assignee_user_id: 7,
  workflow: { step: "old" },
};
const initial = {
  title: "",
  description: "",
  status: "inbox",
  priority: "none" as const,
};
let root: Root;
let container: HTMLDivElement;
let current: ReturnType<typeof useIssueDetailDraft<Workflow>>;
let commits: Array<{ source: string | null; title: string }>;
function Harness({
  source,
  pendingFields,
}: {
  source: typeof original | null;
  pendingFields?: ReadonlySet<string>;
}) {
  const value = useIssueDetailDraft({ source, initial, pendingFields });
  return <CommittedDraftSnapshot source={source?.id ?? null} value={value} />;
}
class CommittedDraftSnapshot extends Component<{
  source: string | null;
  value: typeof current;
}> {
  componentDidMount() {
    this.record();
  }
  componentDidUpdate() {
    this.record();
  }
  record() {
    current = this.props.value;
    commits.push({ source: this.props.source, title: current.draft.title });
  }
  render() {
    return null;
  }
}

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  commits = [];
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

it("commits the new issue draft immediately without publishing the previous issue under its identity", () => {
  act(() => root.render(<Harness source={original} />));
  commits = [];
  act(() =>
    root.render(
      <Harness source={{ ...original, id: "next", title: "Next title" }} />,
    ),
  );
  expect(commits).toEqual([{ source: "next", title: "Next title" }]);
  expect(current.dirty).toBe(false);
});

it("does not retain dirty fields when another project uses the same issue ID", () => {
  act(() => root.render(<Harness source={original} />));
  act(() => current.setField("title", "Project A draft"));
  act(() =>
    root.render(
      <Harness
        source={{
          ...original,
          cloud_project_id: "project-b",
          title: "Project B title",
        }}
      />,
    ),
  );
  expect(current.draft.title).toBe("Project B title");
  expect(current.dirty).toBe(false);
});

it("does not reuse a draft after the provider owner changes", () => {
  const render = (scope: string) => (
    <IssueDetailDraftProvider scope={scope}>
      <Harness source={original} />
    </IssueDetailDraftProvider>
  );
  act(() => root.render(render("first-owner")));
  act(() => current.setField("description", "Private draft"));
  act(() => root.render(render("second-owner")));
  expect(current.draft.description).toBe(original.description);
  expect(current.dirty).toBe(false);
});

it("preserves dirty and pending fields while updating clean fields on the same issue", () => {
  act(() => root.render(<Harness source={original} />));
  act(() => current.setField("title", "My title"));
  const next = {
    ...original,
    version: 2,
    title: "Server title",
    description: "Server description",
    status: "in_progress",
    priority: "high" as const,
    parent_id: "parent",
    start_at: "2026-11-18T10:00:00Z",
    due_at: "2026-11-19T10:00:00Z",
    tags: ["new"],
    assignee_user_id: 8,
    workflow: { step: "new" },
  };
  act(() =>
    root.render(
      <Harness source={next} pendingFields={new Set(["status", "tags"])} />,
    ),
  );
  expect(current.draft).toEqual({
    title: "My title",
    description: "Server description",
    status: "inbox",
    priority: "high",
    parentId: "parent",
    startDate: "2026-11-18T10:00",
    dueDate: "2026-11-19T10:00",
    tags: ["old"],
    assigneeTarget: "user:8",
    workflow: next.workflow,
  });
  expect(current.dirty).toBe(true);
});

it("restores cached content and merges clean fields after an editor remount", () => {
  const render = (source: typeof original | null, show: boolean) => (
    <IssueDetailDraftProvider scope="owner">
      {show && <Harness source={source} />}
    </IssueDetailDraftProvider>
  );
  act(() => root.render(render(original, true)));
  act(() => current.setField("description", "Keep my draft"));
  act(() => root.render(render(original, false)));
  const next = { ...original, version: 2, title: "New server title" };
  act(() => root.render(render(next, true)));
  expect(current.draft.description).toBe("Keep my draft");
  expect(current.draft.title).toBe("New server title");
  expect(current.restoredContentDirty).toBe(true);
});

it("keeps drafts isolated while navigating between projects with matching issue IDs", () => {
  const render = (source: typeof original) => (
    <IssueDetailDraftProvider scope="owner">
      <Harness source={source} />
    </IssueDetailDraftProvider>
  );
  act(() => root.render(render(original)));
  act(() => current.setField("title", "Project A draft"));
  const second = {
    ...original,
    cloud_project_id: "project-b",
    title: "Project B title",
  };
  act(() => root.render(render(second)));
  act(() => current.setField("description", "Project B draft"));
  act(() =>
    root.render(
      render({ ...original, version: 2, description: "Updated A description" }),
    ),
  );
  expect(current.draft.title).toBe("Project A draft");
  expect(current.draft.description).toBe("Updated A description");
  expect(current.restoredContentDirty).toBe(true);
  act(() => root.render(render(second)));
  expect(current.draft.title).toBe("Project B title");
  expect(current.draft.description).toBe("Project B draft");
});

it("removes a clean acknowledged draft from the provider cache", () => {
  const render = (source: typeof original, show: boolean) => (
    <IssueDetailDraftProvider scope="owner">
      {show && <Harness source={source} />}
    </IssueDetailDraftProvider>
  );
  act(() => root.render(render(original, true)));
  act(() => current.setField("title", "Saved title"));
  const acknowledged = { ...original, version: 2, title: "Saved title" };
  act(() => root.render(render(acknowledged, true)));
  expect(current.dirty).toBe(false);
  act(() => root.render(render(acknowledged, false)));
  act(() => root.render(render(acknowledged, true)));
  expect(current.restoredContentDirty).toBe(false);
});

it("starts a fresh creation draft after leaving an existing issue", () => {
  act(() => root.render(<Harness source={original} />));
  act(() => current.setField("title", "Old issue draft"));
  act(() => root.render(<Harness source={null} />));
  expect(current.draft.title).toBe(initial.title);
  expect(current.draft.description).toBe(initial.description);
  expect(current.dirty).toBe(false);
});
