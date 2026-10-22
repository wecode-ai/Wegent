// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { beforeEach, describe, expect, it, vi } from "vitest";

import type { SharedWorkspaceApi } from "../ports/SharedWorkspaceApi";
import type {
  CollaborationAssignment,
  CollaborationAttachment,
  CollaborationComment,
  CollaborationIssue,
  CollaborationProject,
} from "../types";
import {
  collaborationWorkspaceControllerReducer,
  createCollaborationWorkspaceControllerCommands,
  initialCollaborationWorkspaceControllerState,
  type CollaborationWorkspaceControllerAction,
  type CollaborationWorkspaceControllerState,
} from "./useCollaborationWorkspaceController";

const project: CollaborationProject = {
  id: "project-1",
  public_id: "public-1",
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
  created_at: "2026-09-10T00:00:00Z",
  updated_at: "2026-09-10T00:00:00Z",
};

const issue: CollaborationIssue = {
  id: "issue-1",
  cloud_project_id: project.id,
  sequence_number: 1,
  parent_id: null,
  created_by_user_id: 1,
  assignee_user_id: null,
  title: "Issue",
  description: "",
  status: "pending",
  priority: "none",
  due_at: null,
  tags: [],
  sort_order: 0,
  version: 1,
  created_at: "2026-09-10T00:00:00Z",
  updated_at: "2026-09-10T00:00:00Z",
  completed_at: null,
};

const attachment: CollaborationAttachment = {
  id: "attachment-1",
  loop_item_id: issue.id,
  display_name: "proof.txt",
  content_type: "text/plain",
  size_bytes: 5,
  created_by_user_id: 1,
  created_at: "2026-09-10T00:00:00Z",
  markdown_url: "/attachments/attachment-1",
};

const comment: CollaborationComment = {
  id: "comment-1",
  body: "done",
  author: "owner",
  web_url: null,
  created_at: "2026-09-10T00:00:00Z",
  updated_at: "2026-09-10T00:00:00Z",
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function createApi() {
  return {
    projects: {
      list: vi.fn().mockResolvedValue([project]),
      get: vi.fn().mockResolvedValue(project),
      create: vi.fn().mockResolvedValue(project),
      update: vi
        .fn()
        .mockResolvedValue({ ...project, name: "Updated", version: 2 }),
      archive: vi.fn().mockResolvedValue(undefined),
    },
    myWork: {
      list: vi.fn().mockResolvedValue([]),
    },
    issues: {
      listPage: vi.fn().mockResolvedValue({
        items: [],
        nextCursor: null,
        taskBindings: [],
      }),
      getBoardSnapshot: vi.fn().mockResolvedValue({
        items: [issue],
        members: [],
        agents: [],
        taskBindings: [],
      }),
      get: vi.fn().mockResolvedValue(issue),
      markRead: vi.fn().mockResolvedValue({ ...issue, is_unread: false }),
      create: vi.fn().mockResolvedValue(issue),
      update: vi
        .fn()
        .mockResolvedValue({ ...issue, title: "Updated", version: 2 }),
      archive: vi.fn().mockResolvedValue(undefined),
      reorder: vi
        .fn()
        .mockResolvedValue([{ ...issue, status: "completed", version: 2 }]),
    },
    members: {
      list: vi.fn().mockResolvedValue([]),
    },
    agents: {
      list: vi.fn().mockResolvedValue([]),
    },
    attachments: {
      list: vi.fn().mockResolvedValue([attachment]),
    },
    comments: {
      list: vi.fn().mockResolvedValue([comment]),
    },
    executions: {
      list: vi.fn().mockResolvedValue([]),
      stop: vi.fn(),
    },
  } as unknown as SharedWorkspaceApi;
}

describe("collaboration workspace controller", () => {
  let state: CollaborationWorkspaceControllerState;
  let actions: CollaborationWorkspaceControllerAction[];

  beforeEach(() => {
    state = initialCollaborationWorkspaceControllerState;
    actions = [];
  });

  function createController(
    api = createApi(),
    notify = vi.fn(),
    externalBoard = {
      parentId: null,
      pageSize: 100,
      eager: true,
    },
    myWorkEnabled = false,
    deferDispatch = false,
  ) {
    const dispatch = (action: CollaborationWorkspaceControllerAction) => {
      actions.push(action);
      if (!deferDispatch)
        state = collaborationWorkspaceControllerReducer(state, action);
    };
    return {
      api,
      notify,
      commands: createCollaborationWorkspaceControllerCommands({
        api,
        myWorkEnabled,
        messages: {
          loadFailed: "load failed",
          saveFailed: "save failed",
          conflict: "conflict",
        },
        dispatch,
        getProjects: () => state.projects,
        getProjectSnapshot: (projectId) => {
          const items = state.projectItems[projectId];
          const members = state.projectMembers[projectId];
          const agents = state.projectAgents[projectId];
          const taskBindings = state.projectTaskBindings[projectId];
          return items && members && agents && taskBindings
            ? { items, members, agents, taskBindings }
            : null;
        },
        getSelectedIssue: () => state.selectedIssue,
        getExternalBoardState: () => state,
        getExternalBoardOptions: () => externalBoard,
        notify,
      }),
    };
  }

  it("loads project home snapshots into one shared state", async () => {
    const { api, commands } = createController();

    await commands.loadProjects();

    expect(api.projects.list).toHaveBeenCalledOnce();
    expect(api.issues.getBoardSnapshot).toHaveBeenCalledWith(project.id);
    expect(state.projects).toEqual([project]);
    expect(state.projectItems).toEqual({ [project.id]: [issue] });
    expect(state.projectMembers).toEqual({ [project.id]: [] });
    expect(state.projectAgents).toEqual({ [project.id]: [] });
    expect(state.projectTaskBindings).toEqual({ [project.id]: [] });
    expect(state.loading).toBe(false);
    expect(state.error).toBeNull();
  });

  it("shares an in-flight board load with refresh requests and fetches again after completion", async () => {
    state = { ...state, projects: [project] };
    const { api, commands } = createController();
    const snapshot = {
      items: [issue],
      members: [],
      agents: [],
      taskBindings: [],
    };
    const pending = deferred<typeof snapshot>();
    vi.mocked(api.issues.getBoardSnapshot).mockReturnValueOnce(pending.promise);

    const initialLoad = commands.loadProject(project.id);
    const refresh = commands.loadProjectSnapshot(project.id);
    expect(api.issues.getBoardSnapshot).toHaveBeenCalledOnce();
    pending.resolve(snapshot);
    await Promise.all([initialLoad, refresh]);
    expect(state.issues).toEqual([issue]);
    expect(state.loading).toBe(false);

    await commands.loadProjectSnapshot(project.id);
    expect(api.issues.getBoardSnapshot).toHaveBeenCalledTimes(2);
  });

  it("invalidates in-flight snapshots when reloading only project metadata", async () => {
    const updatedIssue = { ...issue, version: 3, assignee_user_id: 1 };
    state = {
      ...state,
      projects: [project],
      project,
      issues: [updatedIssue],
      projectItems: { [project.id]: [updatedIssue] },
    };
    const { api, commands } = createController();
    const snapshot = {
      items: [issue],
      members: [],
      agents: [],
      taskBindings: [],
    };
    const pending = deferred<typeof snapshot>();
    vi.mocked(api.issues.getBoardSnapshot).mockReturnValueOnce(pending.promise);

    const oldRefresh = commands.loadProjectSnapshot(project.id);
    await commands.loadProject(project.id, false, {
      invalidate: true,
      loadSnapshot: false,
    });

    expect(api.issues.getBoardSnapshot).toHaveBeenCalledOnce();
    expect(actions).toContainEqual({
      type: "project-metadata-loaded",
      project,
    });
    pending.resolve(snapshot);
    expect(await oldRefresh).toBeNull();
    expect(state.issues).toEqual([updatedIssue]);
    expect(state.projectItems[project.id]).toEqual([updatedIssue]);
    expect(
      actions.some((action) => action.type === "project-snapshot-loaded"),
    ).toBe(false);
  });

  it.each(["reassignment", "restore"])(
    "invalidates an in-flight board read after %s",
    async (change) => {
      state = { ...state, projects: [project] };
      const { api, commands } = createController();
      const previous = {
        items: change === "restore" ? [] : [issue],
        members: [],
        agents: [],
        taskBindings: [],
      };
      const reassigned = { ...issue, version: 3, assignee_user_id: 1 };
      const updated = { ...previous, items: [reassigned] };
      const pending = deferred<typeof previous>();
      vi.mocked(api.issues.getBoardSnapshot)
        .mockReturnValueOnce(pending.promise)
        .mockResolvedValueOnce(updated);

      const oldRefresh = commands.loadProjectSnapshot(project.id);
      const changedRefresh = commands.loadProjectSnapshot(project.id, {
        invalidate: true,
      });
      expect(api.issues.getBoardSnapshot).toHaveBeenCalledTimes(2);
      await changedRefresh;
      expect(state.projectItems[project.id]).toEqual([reassigned]);

      pending.resolve(previous);
      await oldRefresh;
      expect(state.projectItems[project.id]).toEqual([reassigned]);
    },
  );

  it("refreshes again when an Issue change arrives during a project load", async () => {
    state = { ...state, projects: [project], project, selectedIssue: issue };
    const { api, commands } = createController();
    const previous = {
      items: [issue],
      members: [],
      agents: [],
      taskBindings: [],
    };
    const reassigned = { ...issue, version: 3, assignee_user_id: 1 };
    const pending = deferred<typeof previous>();
    vi.mocked(api.issues.getBoardSnapshot)
      .mockReturnValueOnce(pending.promise)
      .mockResolvedValueOnce({ ...previous, items: [reassigned] });

    const oldRefresh = commands.loadProject(project.id, false);
    const changedRefresh = commands.loadProject(project.id, false, {
      invalidate: true,
    });
    expect(api.issues.getBoardSnapshot).toHaveBeenCalledTimes(2);
    await changedRefresh;
    expect(state.issues).toEqual([reassigned]);
    expect(state.selectedIssue).toEqual(reassigned);

    pending.resolve(previous);
    await oldRefresh;
    expect(state.issues).toEqual([reassigned]);
    expect(state.selectedIssue).toEqual(reassigned);
  });

  it("keeps a successful project catalog when My Work fails", async () => {
    const api = createApi();
    api.myWork!.list = vi
      .fn()
      .mockRejectedValue(new Error("My Work unavailable"));
    const { commands, notify } = createController(
      api,
      vi.fn(),
      {
        parentId: null,
        pageSize: 100,
        eager: true,
      },
      true,
    );

    await commands.loadProjects();

    expect(state.projects).toEqual([project]);
    expect(state.error).toBe("load failed");
    expect(state.errorSource).toBe("load");
    expect(notify).toHaveBeenCalledWith("load failed", "error");
  });

  it("discards a home preload invalidated by an Issue refresh", async () => {
    state = { ...state, projects: [project], project, selectedIssue: issue };
    const { api, commands } = createController();
    const previous = {
      items: [issue],
      members: [],
      agents: [],
      taskBindings: [],
    };
    const reassigned = { ...issue, version: 3, assignee_user_id: 1 };
    const updated = { ...previous, items: [reassigned] };
    const pending = deferred<typeof previous>();
    vi.mocked(api.issues.getBoardSnapshot)
      .mockReturnValueOnce(pending.promise)
      .mockResolvedValue(updated);

    const oldHome = commands.loadProjects();
    await vi.waitFor(() =>
      expect(api.issues.getBoardSnapshot).toHaveBeenCalledOnce(),
    );
    await commands.loadProject(project.id, false, { invalidate: true });
    pending.resolve(previous);
    await oldHome;

    expect(state.projectItems[project.id]).toEqual([reassigned]);
    expect(state.issues).toEqual([reassigned]);
    expect(state.selectedIssue).toEqual(reassigned);
    await commands.loadProject(project.id, false);
    expect(state.issues).toEqual([reassigned]);
    expect(state.selectedIssue).toEqual(reassigned);
    expect(api.issues.getBoardSnapshot).toHaveBeenCalledTimes(3);
  });

  it("preserves refreshed home data when React batches snapshot dispatches before refs update", async () => {
    state = {
      ...state,
      projects: [project],
      project,
      issues: [issue],
      selectedIssue: issue,
      projectItems: { [project.id]: [issue] },
      projectMembers: { [project.id]: [] },
      projectAgents: { [project.id]: [] },
      projectTaskBindings: { [project.id]: [] },
    };
    const previous = {
      items: [issue],
      members: [],
      agents: [],
      taskBindings: [],
    };
    const reassigned = { ...issue, version: 3, assignee_user_id: 1 };
    const pending = deferred<typeof previous>();
    const api = createApi();
    vi.mocked(api.issues.getBoardSnapshot)
      .mockReturnValueOnce(pending.promise)
      .mockResolvedValueOnce({ ...previous, items: [reassigned] });
    const { commands } = createController(api, vi.fn(), undefined, false, true);

    const oldHome = commands.loadProjects();
    await vi.waitFor(() =>
      expect(api.issues.getBoardSnapshot).toHaveBeenCalledOnce(),
    );
    await commands.loadProject(project.id, false, { invalidate: true });
    pending.resolve(previous);
    await oldHome;
    // React may apply both queued results before the next render updates the refs.
    state = actions.reduce(collaborationWorkspaceControllerReducer, state);

    expect(state.projectItems[project.id]).toEqual([reassigned]);
    expect(state.issues).toEqual([reassigned]);
    expect(state.selectedIssue).toEqual(reassigned);
  });

  it("does not preserve an old snapshot after a non-invalidated home read fails", async () => {
    state = {
      ...state,
      projectItems: { [project.id]: [issue] },
      projectMembers: { [project.id]: [] },
      projectAgents: { [project.id]: [] },
      projectTaskBindings: { [project.id]: [] },
    };
    const { api, commands } = createController();
    vi.mocked(api.issues.getBoardSnapshot).mockRejectedValueOnce(
      new Error("unavailable"),
    );

    await commands.loadProjects();

    expect(state.projectItems).toEqual({});
    expect(state.projectMembers).toEqual({});
    expect(state.projectAgents).toEqual({});
    expect(state.projectTaskBindings).toEqual({});
  });

  it("does not request or retain My Work when the capability is disabled", async () => {
    const api = createApi();
    api.myWork!.list = vi.fn().mockResolvedValue([
      {
        ...issue,
        project,
      },
    ]);
    const { commands } = createController(
      api,
      vi.fn(),
      {
        parentId: null,
        pageSize: 100,
        eager: true,
      },
      false,
    );

    await commands.loadProjects();
    await commands.loadMyWork();

    expect(api.myWork!.list).not.toHaveBeenCalled();
    expect(state.myWork).toEqual([]);
  });

  it("keeps project catalog and My Work when one external Git snapshot fails", async () => {
    const externalProject = {
      ...project,
      id: "project-github",
      public_id: "public-github",
      project_key: "GIT",
      name: "GitHub project",
      task_provider: "github" as const,
    };
    const myWorkItem = {
      ...issue,
      project,
    };
    const api = createApi();
    api.projects.list = vi.fn().mockResolvedValue([project, externalProject]);
    api.myWork!.list = vi.fn().mockResolvedValue([myWorkItem]);
    api.issues.listPage = vi
      .fn()
      .mockRejectedValue(new Error("GitHub token expired"));
    const { commands, notify } = createController(
      api,
      vi.fn(),
      {
        parentId: null,
        pageSize: 100,
        eager: true,
      },
      true,
    );

    await commands.loadProjects();

    expect(state.projects).toEqual([project, externalProject]);
    expect(state.myWork).toEqual([myWorkItem]);
    expect(state.projectItems[project.id]).toEqual([issue]);
    expect(state.projectItems[externalProject.id]).toBeUndefined();
    expect(state.error).toBeNull();
    expect(notify).not.toHaveBeenCalled();
  });

  it("loads the selected issue, attachments and comments as one detail snapshot", async () => {
    const { api, commands } = createController();

    await commands.loadSelectedIssue(issue.id);

    expect(api.issues.get).toHaveBeenCalledWith(issue.id);
    expect(api.attachments.list).toHaveBeenCalledWith(issue.id);
    expect(api.comments.list).toHaveBeenCalledWith(issue.id);
    expect(api.executions.list).toHaveBeenCalledWith(project.id, {
      includeTerminal: true,
    });
    expect(state.selectedIssue).toEqual(issue);
    expect(state.attachments).toEqual([attachment]);
    expect(state.comments).toEqual([comment]);
  });

  it("preserves the read cursor until visible activity advances it", async () => {
    const unread = { ...issue, is_unread: true, content_revision: 2 };
    const read = { ...unread, is_unread: false };
    const { api, commands } = createController();
    vi.mocked(api.issues.getBoardSnapshot).mockResolvedValue({
      items: [unread],
      members: [],
      agents: [],
      taskBindings: [],
    });
    vi.mocked(api.issues.get).mockResolvedValue(unread);
    vi.mocked(api.issues.markRead).mockResolvedValue(read);

    await commands.loadProject(project.id);
    expect(api.issues.markRead).not.toHaveBeenCalled();
    await commands.loadSelectedIssue(issue.id);

    expect(api.issues.markRead).not.toHaveBeenCalled();
    expect(state.selectedIssue).toEqual(unread);
    expect(state.issues).toEqual([unread]);
    expect(state.projectItems[project.id]).toEqual([unread]);
    await commands.markIssueRead(unread);
    expect(api.issues.markRead).toHaveBeenCalledExactlyOnceWith(issue.id);
    expect(state.selectedIssue).toEqual(read);
  });

  it("preserves unread state on failure and allows retry without reopening detail", async () => {
    const unread = { ...issue, is_unread: true };
    const { api, commands, notify } = createController();
    vi.mocked(api.issues.get).mockResolvedValue(unread);
    vi.mocked(api.issues.markRead).mockRejectedValueOnce(new Error("offline"));

    await commands.loadSelectedIssue(issue.id);

    expect(state.selectedIssue?.is_unread).toBe(true);
    expect(state.error).toBeNull();
    await commands.markIssueRead(unread);
    expect(state.error).toBe("save failed");
    expect(notify).toHaveBeenCalledWith("save failed", "error");
    await commands.markIssueRead(unread);
    expect(state.selectedIssue?.is_unread).toBe(false);
  });

  it.each([1, 2])(
    "deduplicates read requests and preserves newer content at version %s",
    async (version) => {
      const unread = { ...issue, is_unread: true, content_revision: 2 };
      const newer = {
        ...unread,
        title: "New update",
        version,
        content_revision: 3,
      };
      const response = deferred<CollaborationIssue>();
      const { api, commands } = createController();
      vi.mocked(api.issues.markRead).mockReturnValue(response.promise);
      state = {
        ...state,
        issues: [unread],
        projectItems: { [project.id]: [unread] },
      };

      const previewRead = commands.markIssueRead(unread);
      const detailRead = commands.markIssueRead(unread);
      commands.replaceIssue(newer);
      response.resolve({ ...unread, is_unread: false });
      await Promise.all([previewRead, detailRead]);

      expect(api.issues.markRead).toHaveBeenCalledExactlyOnceWith(issue.id);
      expect(state.issues).toEqual([newer]);
      expect(state.selectedIssue).toBeNull();
    },
  );

  it.each(
    (["controller", "activity"] as const).flatMap((source) =>
      (["read", "snapshot"] as const).map((first) => ({ source, first })),
    ),
  )(
    "keeps an external content refresh when $source read and $first completes first",
    async ({ source, first }) => {
      const unread = { ...issue, is_unread: true, content_revision: 2 };
      const refreshed = {
        ...unread,
        version: 2,
        status: "in_progress",
        content_revision: 3,
      };
      const readResponse = deferred<CollaborationIssue>();
      const snapshotResponse = deferred<{
        items: CollaborationIssue[];
        members: [];
        agents: [];
        taskBindings: [];
      }>();
      const snapshot = {
        items: [refreshed],
        members: [] as [],
        agents: [] as [],
        taskBindings: [] as [],
      };
      state = {
        ...state,
        projects: [project],
        project,
        selectedIssue: unread,
        issues: [unread],
        projectItems: { [project.id]: [unread] },
      };
      const { api, commands } = createController();
      vi.mocked(api.issues.markRead).mockReturnValue(readResponse.promise);
      vi.mocked(api.issues.getBoardSnapshot).mockReturnValue(
        snapshotResponse.promise,
      );

      const reading =
        source === "controller"
          ? commands.markIssueRead(unread)
          : readResponse.promise.then((updated) =>
              commands.confirmIssueRead(updated),
            );
      const refreshing = commands.loadProjectSnapshot(project.id, {
        invalidate: true,
      });
      const completeRead = async () => {
        readResponse.resolve({ ...unread, is_unread: false });
        await reading;
      };
      const completeSnapshot = async () => {
        snapshotResponse.resolve(snapshot);
        await refreshing;
      };
      if (first === "read") {
        await completeRead();
        await completeSnapshot();
      } else {
        await completeSnapshot();
        await completeRead();
      }

      expect(state.selectedIssue).toMatchObject(refreshed);
      expect(state.issues).toEqual([refreshed]);
      expect(state.projectItems[project.id]).toEqual([refreshed]);
      expect(api.issues.getBoardSnapshot).toHaveBeenCalledOnce();
      expect(await reading).toMatchObject(
        first === "read"
          ? {
              ...unread,
              is_unread: false,
            }
          : refreshed,
      );
    },
  );

  it("preserves a confirmed read across stale board and detail responses while newer content stays unread", async () => {
    const unread = {
      ...issue,
      content_revision: 2,
      is_unread: true,
      activity_read_sequence: 1,
    };
    const read = { ...unread, is_unread: false, activity_read_sequence: 7 };
    const { api, commands } = createController();
    state = {
      ...state,
      projects: [project],
      project,
      issues: [unread],
      selectedIssue: unread,
      projectItems: { [project.id]: [unread] },
    };
    vi.mocked(api.issues.markRead).mockResolvedValue(read);
    await expect(commands.markIssueRead(unread)).resolves.toEqual(read);
    vi.mocked(api.issues.getBoardSnapshot).mockResolvedValue({
      items: [unread],
      members: [],
      agents: [],
      taskBindings: [],
    });
    vi.mocked(api.issues.get).mockResolvedValue(unread);

    await commands.loadProjectSnapshot(project.id);
    await commands.loadSelectedIssue(issue.id);

    expect(state.selectedIssue).toEqual(read);
    expect(state.issues).toEqual([read]);
    expect(state.projectItems[project.id]).toEqual([read]);

    const newer = { ...unread, content_revision: 3, version: 2 };
    vi.mocked(api.issues.getBoardSnapshot).mockResolvedValue({
      items: [newer],
      members: [],
      agents: [],
      taskBindings: [],
    });
    await commands.loadProjectSnapshot(project.id);
    expect(state.selectedIssue).toMatchObject({
      ...newer,
      is_unread: true,
      activity_read_sequence: 7,
    });
  });

  it("does not mark an issue read if navigation closes it before detail loads", async () => {
    const { api, commands } = createController();
    const response = deferred<CollaborationIssue>();
    vi.mocked(api.issues.get).mockReturnValue(response.promise);
    const load = commands.loadSelectedIssue(issue.id);
    commands.clearSelectedIssue();
    response.resolve({ ...issue, is_unread: true });
    await load;
    expect(api.issues.markRead).not.toHaveBeenCalled();
  });

  it("selects a cached board issue before its detail snapshot finishes loading", async () => {
    state = {
      ...state,
      project,
      issues: [issue],
    };
    const issueResponse = deferred<CollaborationIssue>();
    const api = createApi();
    api.issues.get = vi.fn().mockReturnValue(issueResponse.promise);
    const { commands } = createController(api);

    const load = commands.loadSelectedIssue(issue.id);

    expect(state.selectedIssue).toEqual(issue);
    expect(state.attachments).toEqual([]);
    expect(state.comments).toEqual([]);

    issueResponse.resolve(issue);
    await load;
    expect(state.attachments).toEqual([attachment]);
    expect(state.comments).toEqual([comment]);
  });

  it("does not let a stale detail load overwrite a comment changed while it was loading", async () => {
    state = {
      ...state,
      project,
      issues: [issue],
    };
    const assignmentsResponse = deferred<CollaborationAssignment[]>();
    const api = createApi();
    api.comments.list = vi.fn().mockResolvedValue([]);
    api.assignments = {
      list: vi.fn().mockReturnValue(assignmentsResponse.promise),
      create: vi.fn(),
    };
    const { commands } = createController(api);
    const newerComment = {
      ...comment,
      id: "comment-new",
      body: "submitted while loading",
    };
    const loadedAssignment = {
      id: "assignment-new",
      loop_item_id: issue.id,
      target_type: "human",
      target_id: "1",
      target_name: "owner",
      status: "active",
      workflow_step: null,
      created_at: "2026-09-10T00:00:01Z",
      updated_at: "2026-09-10T00:00:01Z",
    } satisfies CollaborationAssignment;

    const load = commands.loadSelectedIssue(issue.id);
    await vi.waitFor(() => {
      expect(api.assignments?.list).toHaveBeenCalledWith(issue.id);
    });

    commands.replaceComments(issue.id, [newerComment]);
    assignmentsResponse.resolve([loadedAssignment]);
    await load;

    expect(state.selectedIssue).toEqual(issue);
    expect(state.attachments).toEqual([attachment]);
    expect(state.comments).toEqual([newerComment]);
    expect(state.assignments).toEqual([loadedAssignment]);
  });

  it("keeps a saved issue when an older detail load finishes afterward", async () => {
    state = { ...state, project, issues: [issue] };
    const assignmentsResponse = deferred<CollaborationAssignment[]>();
    const api = createApi();
    api.assignments = {
      list: vi.fn().mockReturnValue(assignmentsResponse.promise),
      create: vi.fn(),
    };
    const { commands } = createController(api);
    const load = commands.loadSelectedIssue(issue.id);
    await vi.waitFor(() => {
      expect(api.assignments?.list).toHaveBeenCalledWith(issue.id);
    });
    const savedIssue = {
      ...issue,
      title: "Saved while loading",
      version: issue.version + 1,
    };

    commands.replaceIssue(savedIssue);
    assignmentsResponse.resolve([]);

    expect(await load).toEqual(savedIssue);
    expect(state.selectedIssue).toEqual(savedIssue);
    expect(state.attachments).toEqual([attachment]);
    expect(state.comments).toEqual([comment]);
  });

  it("ignores a collection mutation that belongs to another issue", () => {
    const otherIssue = {
      ...issue,
      id: "issue-2",
      sequence_number: 2,
      title: "Other issue",
    };
    state = {
      ...state,
      project,
      issues: [issue, otherIssue],
      selectedIssue: otherIssue,
      comments: [comment],
    };
    const { commands } = createController();
    const staleComment = {
      ...comment,
      id: "comment-stale",
      body: "belongs to issue 1",
    };

    commands.replaceComments(issue.id, [staleComment]);

    expect(state.selectedIssue).toEqual(otherIssue);
    expect(state.comments).toEqual([comment]);
  });

  it("keeps the current detail collections visible while reloading the same issue", async () => {
    state = {
      ...state,
      project,
      issues: [issue],
      selectedIssue: issue,
      attachments: [attachment],
      comments: [comment],
    };
    const issueResponse = deferred<CollaborationIssue>();
    const api = createApi();
    api.issues.get = vi.fn().mockReturnValue(issueResponse.promise);
    const { commands } = createController(api);

    const load = commands.loadSelectedIssue(issue.id);

    expect(state.selectedIssue).toEqual(issue);
    expect(state.attachments).toEqual([attachment]);
    expect(state.comments).toEqual([comment]);

    issueResponse.resolve(issue);
    await load;
  });

  it("treats an empty assignments API response as authoritative", async () => {
    const legacyAssignedIssue = {
      ...issue,
      assignee_user_id: 7,
      assignee_name: "旧负责人",
    };
    const api = createApi();
    api.issues.get = vi.fn().mockResolvedValue(legacyAssignedIssue);
    api.assignments = {
      list: vi.fn().mockResolvedValue([]),
      create: vi.fn(),
    };
    const { commands } = createController(api);

    await commands.loadSelectedIssue(issue.id);

    expect(api.assignments.list).toHaveBeenCalledWith(issue.id);
    expect(state.assignments).toEqual([]);
  });

  it("owns create, update and archive mutations for projects and issues", async () => {
    state = {
      ...state,
      projects: [project],
      project,
      issues: [issue],
      selectedIssue: issue,
    };
    const { api, commands } = createController();

    expect(await commands.createProject({ name: "Project" })).toEqual(project);
    expect(
      await commands.updateProject(project.id, { version: 1, name: "Updated" }),
    ).toMatchObject({
      name: "Updated",
      version: 2,
    });
    expect(await commands.createIssue(project.id, { title: "Issue" })).toEqual(
      issue,
    );
    expect(
      await commands.updateIssue(issue.id, { version: 1, title: "Updated" }),
    ).toMatchObject({
      title: "Updated",
      version: 2,
    });
    expect(await commands.archiveIssue(issue.id)).toBe(true);
    expect(await commands.archiveProject(project.id, 1)).toBe(true);

    expect(api.projects.create).toHaveBeenCalledWith({ name: "Project" });
    expect(api.issues.create).toHaveBeenCalledWith(project.id, {
      title: "Issue",
    });
    expect(state.project).toBeNull();
    expect(state.issues).toEqual([]);
  });

  it("keeps the complete selected board snapshot in shared state", async () => {
    const { commands } = createController();

    await commands.loadProject(project.id);

    expect(state.project).toEqual(project);
    expect(state.issues).toEqual([issue]);
    expect(state.members).toEqual([]);
    expect(state.agents).toEqual([]);
    expect(state.taskBindings).toEqual([]);
    expect(state.projectItems).toEqual({ [project.id]: [issue] });
  });

  it("accepts a host-created issue without reloading a stale board snapshot", () => {
    state = {
      ...state,
      projects: [project],
      project,
      issues: [issue],
      projectItems: { [project.id]: [issue] },
    };
    const { commands } = createController();
    const created = {
      ...issue,
      id: "issue-created",
      title: "Created by host",
    };

    commands.appendIssue(created);

    expect(state.issues).toEqual([issue, created]);
    expect(state.projectItems[project.id]).toEqual([issue, created]);
  });

  it("does not preload DingTalk AITable before board authentication", async () => {
    const aitableProject = {
      ...project,
      task_provider: "dingtalk_aitable",
    };
    const api = createApi();
    api.projects.list = vi.fn().mockResolvedValue([aitableProject]);
    const { commands } = createController(api);

    await commands.loadProjects();

    expect(api.issues.getBoardSnapshot).not.toHaveBeenCalled();
    expect(state.projects).toEqual([aitableProject]);
    expect(state.projectItems).toEqual({});
  });

  it("loads every GitHub board status and follows pagination", async () => {
    const externalProject = {
      ...project,
      task_provider: "github" as const,
    };
    const pendingIssue = { ...issue, id: "pending-1", status: "pending" };
    const nextPendingIssue = {
      ...issue,
      id: "pending-2",
      status: "pending",
    };
    const completedIssue = {
      ...issue,
      id: "completed-1",
      status: "completed",
    };
    state = { ...state, projects: [externalProject] };
    const api = createApi();
    api.projects.list = vi.fn().mockResolvedValue([externalProject]);
    api.projects.get = vi.fn().mockResolvedValue(externalProject);
    api.issues.listPage = vi.fn(
      async (
        _projectId: string,
        input: { status: string; cursor?: string | null },
      ) => {
        if (input.status === "pending" && !input.cursor) {
          return {
            items: [pendingIssue],
            nextCursor: "pending-page-2",
            taskBindings: [],
          };
        }
        if (input.status === "pending" && input.cursor === "pending-page-2") {
          return {
            items: [nextPendingIssue],
            nextCursor: null,
            taskBindings: [],
          };
        }
        if (input.status === "completed") {
          return {
            items: [completedIssue],
            nextCursor: null,
            taskBindings: [],
          };
        }
        return { items: [], nextCursor: null, taskBindings: [] };
      },
    );
    const { commands } = createController(api);

    await commands.loadProject(externalProject.id);

    expect(api.issues.getBoardSnapshot).not.toHaveBeenCalled();
    expect(api.issues.listPage).toHaveBeenCalledTimes(6);
    expect(api.issues.listPage).toHaveBeenCalledWith(externalProject.id, {
      status: "inbox",
      parentId: null,
      cursor: null,
      limit: 100,
    });
    expect(api.issues.listPage).toHaveBeenCalledWith(externalProject.id, {
      status: "pending",
      parentId: null,
      cursor: "pending-page-2",
      limit: 100,
    });
    expect(api.members.list).toHaveBeenCalledWith(externalProject.id);
    expect(api.agents.list).toHaveBeenCalledWith(externalProject.id);
    expect(state.project).toEqual(externalProject);
    expect(state.issues).toEqual([
      pendingIssue,
      nextPendingIssue,
      completedIssue,
    ]);
  });

  it("owns external column cursors and appends one Wework page without duplicates", async () => {
    const externalProject = {
      ...project,
      task_provider: "github" as const,
    };
    const firstIssue = { ...issue, id: "pending-1", status: "pending" };
    const nextIssue = { ...issue, id: "pending-2", status: "pending" };
    const firstBinding = {
      id: 1,
      projectId: externalProject.id,
      issueId: firstIssue.id,
      taskUserId: 1,
      deviceId: "device-1",
      taskId: "task-1",
      taskTitle: "Task 1",
      backendTaskId: null,
      modelSelection: null,
      workflowNodeId: null,
      bindingType: "manual",
      linkedAt: "2026-09-10T00:00:00Z",
    };
    const nextBinding = {
      ...firstBinding,
      id: 2,
      issueId: nextIssue.id,
      taskId: "task-2",
    };
    state = { ...state, projects: [externalProject] };
    const api = createApi();
    api.projects.get = vi.fn().mockResolvedValue(externalProject);
    api.issues.listPage = vi.fn(
      async (
        _projectId: string,
        input: { status: string; cursor?: string | null },
      ) => {
        if (input.status !== "pending") {
          return { items: [], nextCursor: null, taskBindings: [] };
        }
        if (input.cursor === "pending-page-2") {
          return {
            items: [firstIssue, nextIssue],
            nextCursor: null,
            taskBindings: [firstBinding, nextBinding],
          };
        }
        return {
          items: [firstIssue],
          nextCursor: "pending-page-2",
          taskBindings: [firstBinding],
        };
      },
    );
    const { commands } = createController(api, vi.fn(), {
      parentId: null,
      pageSize: 10,
      eager: false,
    });

    await commands.loadProject(externalProject.id);

    expect(api.issues.listPage).toHaveBeenCalledTimes(5);
    expect(state.issues).toEqual([firstIssue]);
    expect(state.externalPageCursors.pending).toBe("pending-page-2");

    await commands.loadMoreExternalColumn("pending");

    expect(api.issues.listPage).toHaveBeenLastCalledWith(externalProject.id, {
      status: "pending",
      parentId: null,
      cursor: "pending-page-2",
      limit: 10,
    });
    expect(state.issues).toEqual([firstIssue, nextIssue]);
    expect(state.taskBindings).toEqual([firstBinding, nextBinding]);
    expect(state.externalPageCursors.pending).toBeNull();
    expect(state.externalPageLoading.pending).toBe(false);
  });

  it("refreshes an external GitLab project through paged issue reads", async () => {
    const externalProject = {
      ...project,
      task_provider: "gitlab" as const,
    };
    state = { ...state, projects: [externalProject] };
    const api = createApi();
    api.projects.get = vi.fn().mockResolvedValue(externalProject);
    api.issues.listPage = vi.fn().mockResolvedValue({
      items: [issue],
      nextCursor: null,
      taskBindings: [],
    });
    const { commands } = createController(api);

    await commands.loadProjectSnapshot(externalProject.id);

    expect(api.issues.getBoardSnapshot).not.toHaveBeenCalled();
    expect(api.issues.listPage).toHaveBeenCalledTimes(5);
    expect(state.projectItems[externalProject.id]).toEqual([
      issue,
      issue,
      issue,
      issue,
      issue,
    ]);
  });

  it("reconciles an open Issue with the latest project snapshot", async () => {
    const completedIssue = {
      ...issue,
      status: "completed" as const,
      version: 2,
      completed_at: "2026-09-13T09:00:00Z",
    };
    state = {
      ...state,
      projects: [project],
      project,
      issues: [issue],
      selectedIssue: issue,
    };
    const api = createApi();
    api.issues.getBoardSnapshot = vi.fn().mockResolvedValue({
      items: [completedIssue],
      members: [],
      agents: [],
      taskBindings: [],
    });
    const { commands } = createController(api);

    await commands.loadProjectSnapshot(project.id);

    expect(state.issues).toEqual([completedIssue]);
    expect(state.selectedIssue).toEqual(completedIssue);
  });

  it("clears an open Issue that is absent from the loaded project snapshot", async () => {
    state = {
      ...state,
      projects: [project],
      project,
      issues: [issue],
      selectedIssue: issue,
    };
    const api = createApi();
    api.issues.getBoardSnapshot = vi.fn().mockResolvedValue({
      items: [],
      members: [],
      agents: [],
      taskBindings: [],
    });
    const { commands } = createController(api);

    await commands.loadProjectSnapshot(project.id);

    expect(state.selectedIssue).toBeNull();
  });

  it("ignores a project response that finishes after a newer project load", async () => {
    const newerProject = {
      ...project,
      id: "project-2",
      project_key: "NEW",
      name: "Newer project",
    };
    const newerIssue = {
      ...issue,
      id: "issue-2",
      cloud_project_id: newerProject.id,
      title: "Newer issue",
    };
    let resolveOlderSnapshot:
      | ((snapshot: {
          items: CollaborationIssue[];
          members: [];
          agents: [];
          taskBindings: [];
        }) => void)
      | undefined;
    const api = createApi();
    api.projects.get = vi.fn(async (projectId: string) =>
      projectId === newerProject.id ? newerProject : project,
    );
    api.issues.getBoardSnapshot = vi.fn((projectId: string) =>
      projectId === newerProject.id
        ? Promise.resolve({
            items: [newerIssue],
            members: [],
            agents: [],
            taskBindings: [],
          })
        : new Promise((resolve) => {
            resolveOlderSnapshot = resolve;
          }),
    );
    const { commands } = createController(api);

    const olderLoad = commands.loadProject(project.id);
    await commands.loadProject(newerProject.id);
    resolveOlderSnapshot?.({
      items: [issue],
      members: [],
      agents: [],
      taskBindings: [],
    });
    await olderLoad;

    expect(state.project).toEqual(newerProject);
    expect(state.issues).toEqual([newerIssue]);
    expect(state.loading).toBe(false);
  });

  it("rejects a project snapshot started before a successful issue mutation", async () => {
    const staleSnapshot = deferred<{
      items: CollaborationIssue[];
      members: [];
      agents: [];
      taskBindings: [];
    }>();
    const updatedIssue = { ...issue, title: "Updated", version: 2 };
    state = {
      ...state,
      projects: [project],
      project,
      issues: [issue],
      projectItems: { [project.id]: [issue] },
    };
    const api = createApi();
    api.issues.getBoardSnapshot = vi
      .fn()
      .mockImplementationOnce(() => staleSnapshot.promise)
      .mockResolvedValue({
        items: [updatedIssue],
        members: [],
        agents: [],
        taskBindings: [],
      });
    api.issues.update = vi.fn().mockResolvedValue(updatedIssue);
    const { commands } = createController(api);

    const staleLoad = commands.loadProject(project.id, false);
    await commands.updateIssue(issue.id, {
      version: issue.version,
      title: updatedIssue.title,
    });
    await commands.loadProject(project.id, false);
    staleSnapshot.resolve({
      items: [issue],
      members: [],
      agents: [],
      taskBindings: [],
    });
    await staleLoad;

    expect(api.issues.getBoardSnapshot).toHaveBeenCalledTimes(2);
    expect(state.issues).toEqual([updatedIssue]);
    expect(state.projectItems[project.id]).toEqual([updatedIssue]);
    expect(
      actions.filter((action) => action.type === "project-loaded"),
    ).toHaveLength(1);
  });

  it("clears completed home snapshot requests so returning home refreshes data", async () => {
    const refreshedIssue = { ...issue, title: "Refreshed", version: 2 };
    const api = createApi();
    api.issues.getBoardSnapshot = vi
      .fn()
      .mockResolvedValueOnce({
        items: [issue],
        members: [],
        agents: [],
        taskBindings: [],
      })
      .mockResolvedValueOnce({
        items: [refreshedIssue],
        members: [],
        agents: [],
        taskBindings: [],
      });
    const { commands } = createController(api);

    await commands.loadProjects();
    expect(state.projectItems[project.id]).toEqual([issue]);

    await commands.loadProjects();

    expect(api.issues.getBoardSnapshot).toHaveBeenCalledTimes(2);
    expect(state.projectItems[project.id]).toEqual([refreshedIssue]);
  });

  it("ignores an issue response after the selected issue is cleared", async () => {
    let resolveIssue: ((value: CollaborationIssue) => void) | undefined;
    const api = createApi();
    api.issues.get = vi.fn(
      () =>
        new Promise((resolve) => {
          resolveIssue = resolve;
        }),
    );
    const { commands } = createController(api);

    const load = commands.loadSelectedIssue(issue.id);
    commands.clearSelectedIssue();
    resolveIssue?.(issue);
    await load;

    expect(state.selectedIssue).toBeNull();
    expect(state.attachments).toEqual([]);
    expect(state.comments).toEqual([]);
  });

  it("ignores an issue response after the current project is cleared", async () => {
    let resolveIssue: ((value: CollaborationIssue) => void) | undefined;
    const api = createApi();
    api.issues.get = vi.fn(
      () =>
        new Promise((resolve) => {
          resolveIssue = resolve;
        }),
    );
    const { commands } = createController(api);

    const load = commands.loadSelectedIssue(issue.id);
    commands.clearProject();
    resolveIssue?.(issue);
    await load;

    expect(state.project).toBeNull();
    expect(state.selectedIssue).toBeNull();
    expect(state.attachments).toEqual([]);
    expect(state.comments).toEqual([]);
  });

  it("reloads the board and reports a conflict after an atomic position conflict", async () => {
    const api = createApi();
    api.issues.update = vi.fn().mockRejectedValue({ code: "version_conflict" });
    const { commands, notify } = createController(api);
    await commands.updateIssue(issue.id, {
      version: issue.version,
      status: "completed",
      position: { beforeItemId: null },
    });
    expect(api.issues.getBoardSnapshot).toHaveBeenCalledWith(project.id);
    expect(state.issues).toEqual([issue]);
    expect(state.error).toBe("conflict");
    expect(notify).toHaveBeenCalledWith("conflict", "error");
    expect(api.issues.reorder).not.toHaveBeenCalled();
  });

  it.each(
    ["update", "assign"].flatMap((kind) =>
      [false, true].map((hidden) => ({ kind, hidden })),
    ),
  )(
    "keeps committed ranks when $kind refresh fails and recovers (hidden=$hidden)",
    async ({ kind, hidden }) => {
      const siblings = [
        issue,
        { ...issue, id: "issue-2", sort_order: hidden ? 2 : 1 },
        { ...issue, id: "issue-3", sort_order: hidden ? 4 : 2 },
      ];
      const saved = {
        ...issue,
        sort_order: hidden ? 3 : 1,
        version: 2,
        updated_at: "2026-10-21T00:00:00Z",
      };
      state = {
        ...state,
        project,
        projects: [project],
        issues: siblings,
        projectItems: { [project.id]: siblings },
      };
      const api = createApi();
      api.issues.update = vi.fn().mockResolvedValue(saved);
      api.issues.assign = vi.fn().mockResolvedValue(saved);
      api.issues.getBoardSnapshot = vi
        .fn()
        .mockRejectedValueOnce(new Error("offline"));
      const { commands } = createController(api);
      if (kind === "update") {
        await commands.updateIssue(issue.id, {
          version: 1,
          position: { beforeItemId: "issue-3" },
        });
      } else {
        await commands.assignIssue(project.id, issue.id, {
          version: 1,
          assigneeType: "user",
          assigneeId: "1",
          notifyAssignee: false,
          position: { beforeItemId: "issue-3" },
        });
      }
      await expect(
        commands.loadProjectSnapshot(project.id, {
          invalidate: true,
          throwOnError: true,
        }),
      ).rejects.toThrow("load failed");
      const ranks = () =>
        state.issues
          .slice()
          .sort((a, b) => a.sort_order - b.sort_order)
          .map((item) => [item.id, item.sort_order]);
      expect(ranks()).toEqual([
        ["issue-2", hidden ? 1 : 0],
        [issue.id, hidden ? 3 : 1],
        ["issue-3", hidden ? 4 : 2],
      ]);
      expect(state.projectItems[project.id]).toEqual(state.issues);
      expect(state.errorSource).toBe("load");
      api.issues.getBoardSnapshot = vi.fn().mockResolvedValue({
        items: state.issues.map((item) => ({ ...item, version: 2 })),
        members: [],
        agents: [],
        taskBindings: [],
      });
      await commands.loadProjectSnapshot(project.id, { invalidate: true });
      expect(ranks()).toEqual([
        ["issue-2", hidden ? 1 : 0],
        [issue.id, hidden ? 3 : 1],
        ["issue-3", hidden ? 4 : 2],
      ]);
      expect(state.error).toBeNull();
    },
  );

  it("passes fields and position through one update and reloads all sibling ranks", async () => {
    const api = createApi();
    const saved = { ...issue, sort_order: 1, status: "completed", version: 7 };
    api.issues.update = vi.fn().mockResolvedValue(saved);
    api.issues.getBoardSnapshot = vi.fn().mockResolvedValue({
      items: [saved],
      members: [],
      agents: [],
      taskBindings: [],
    });
    const { commands } = createController(api);
    const input = {
      version: issue.version,
      status: "completed",
      position: { beforeItemId: null },
    };
    await expect(commands.updateIssue(issue.id, input)).resolves.toEqual(saved);
    await commands.loadProjectSnapshot(project.id, { invalidate: true });
    expect(api.issues.update).toHaveBeenCalledWith(issue.id, input);
    expect(api.issues.reorder).not.toHaveBeenCalled();
    expect(state.projectItems[project.id]).toEqual([saved]);
  });

  it("does not let an older refresh erase fields returned by a position mutation", async () => {
    const api = createApi();
    const saved = { ...issue, title: "Saved", status: "completed", version: 3 };
    state = {
      ...state,
      project,
      issues: [issue],
      projectItems: { [project.id]: [issue] },
    };
    api.issues.update = vi.fn().mockResolvedValue(saved);
    const { commands } = createController(api);
    await commands.updateIssue(issue.id, {
      version: 1,
      position: { beforeItemId: null },
    });
    await commands.loadProjectSnapshot(project.id, { invalidate: true });
    expect(state.projectItems[project.id]).toEqual([saved]);
  });

  it("merges refreshed ranks against concurrently updated issue versions", async () => {
    const secondIssue = {
      ...issue,
      id: "issue-2",
      sequence_number: 2,
      sort_order: 1,
    };
    const acknowledged = {
      ...issue,
      title: "Saved",
      sort_order: 1,
      version: 3,
    };
    const concurrent = {
      ...secondIssue,
      sort_order: 0,
      status: "completed",
      version: 4,
    };
    state = {
      ...state,
      project,
      projects: [project],
      issues: [issue, secondIssue],
      projectItems: { [project.id]: [issue, secondIssue] },
    };
    state = collaborationWorkspaceControllerReducer(state, {
      type: "replace-issue",
      issue: concurrent,
    });
    state = collaborationWorkspaceControllerReducer(state, {
      type: "project-snapshot-loaded",
      projectId: project.id,
      snapshot: {
        items: [acknowledged, secondIssue],
        members: [],
        agents: [],
        taskBindings: [],
      },
    });
    expect(state.projectItems[project.id]).toEqual([acknowledged, concurrent]);
    expect(state.issues).toEqual(state.projectItems[project.id]);
  });

  it("keeps the mutated project in the catalog used by background refreshes", async () => {
    const statusProject = {
      ...project,
      board_config: {
        group_by: "status" as const,
        processing_start_status_id: "processing",
        statuses: [],
      },
    };
    const assigneeProject = {
      ...statusProject,
      board_config: {
        ...statusProject.board_config,
        group_by: "assignee" as const,
      },
      version: 2,
    };
    state = { ...state, projects: [statusProject], project: statusProject };
    const api = createApi();
    api.projects.update = vi.fn().mockResolvedValue(assigneeProject);
    const { commands } = createController(api);

    await commands.changeProjectGroup({
      project: statusProject,
      groupBy: "assignee",
      defaultStatuses: [],
    });
    await commands.loadProject(project.id, false);

    expect(api.projects.get).not.toHaveBeenCalled();
    expect(state.project).toEqual(assigneeProject);
  });

  it("reapplies a group change to the latest project after a version conflict", async () => {
    const statusProject = {
      ...project,
      board_config: {
        group_by: "status" as const,
        processing_start_status_id: "processing",
        statuses: [],
      },
    };
    const latestProject = { ...statusProject, version: 2 };
    const assigneeProject = {
      ...latestProject,
      board_config: {
        ...latestProject.board_config,
        group_by: "assignee" as const,
      },
      version: 3,
    };
    state = { ...state, projects: [statusProject], project: statusProject };
    const api = createApi();
    api.projects.get = vi.fn().mockResolvedValue(latestProject);
    api.projects.update = vi
      .fn()
      .mockRejectedValueOnce({ status: 409 })
      .mockResolvedValueOnce(assigneeProject);
    const { commands, notify } = createController(api);

    await commands.changeProjectGroup({
      project: statusProject,
      groupBy: "assignee",
      defaultStatuses: [],
    });

    expect(api.projects.get).toHaveBeenCalledWith(project.id);
    expect(api.projects.update).toHaveBeenLastCalledWith(project.id, {
      version: 2,
      boardConfig: {
        ...latestProject.board_config,
        group_by: "assignee",
      },
    });
    expect(state.project).toEqual(assigneeProject);
    expect(notify).not.toHaveBeenCalled();
  });

  it("recognizes the local version_conflict error protocol", async () => {
    const statusProject = {
      ...project,
      board_config: {
        group_by: "status" as const,
        processing_start_status_id: "processing",
        statuses: [],
      },
    };
    const latestProject = { ...statusProject, version: 2 };
    const priorityProject = {
      ...latestProject,
      board_config: {
        ...latestProject.board_config,
        group_by: "priority" as const,
      },
      version: 3,
    };
    state = { ...state, projects: [statusProject], project: statusProject };
    const api = createApi();
    api.projects.get = vi.fn().mockResolvedValue(latestProject);
    api.projects.update = vi
      .fn()
      .mockRejectedValueOnce({ code: "version_conflict" })
      .mockResolvedValueOnce(priorityProject);
    const { commands, notify } = createController(api);

    await commands.changeProjectGroup({
      project: statusProject,
      groupBy: "priority",
      defaultStatuses: [],
    });

    expect(api.projects.get).toHaveBeenCalledWith(project.id);
    expect(state.project).toEqual(priorityProject);
    expect(notify).not.toHaveBeenCalled();
  });

  it("does not let an older group change overwrite the latest selection", async () => {
    const statusProject = {
      ...project,
      board_config: {
        group_by: "status" as const,
        processing_start_status_id: "processing",
        statuses: [],
      },
    };
    const tagProject = {
      ...statusProject,
      board_config: {
        ...statusProject.board_config,
        group_by: "tag" as const,
      },
      version: 2,
    };
    let rejectOlder!: (error: unknown) => void;
    const olderUpdate = new Promise<CollaborationProject>(
      (_resolve, reject) => {
        rejectOlder = reject;
      },
    );
    state = { ...state, projects: [statusProject], project: statusProject };
    const api = createApi();
    api.projects.update = vi
      .fn()
      .mockReturnValueOnce(olderUpdate)
      .mockResolvedValueOnce(tagProject);
    const { commands, notify } = createController(api);

    const olderChange = commands.changeProjectGroup({
      project: statusProject,
      groupBy: "priority",
      defaultStatuses: [],
    });
    await commands.changeProjectGroup({
      project: statusProject,
      groupBy: "tag",
      defaultStatuses: [],
    });
    rejectOlder({ status: 409 });
    await olderChange;

    expect(api.projects.get).not.toHaveBeenCalled();
    expect(api.projects.update).toHaveBeenCalledTimes(2);
    expect(state.project).toEqual(tagProject);
    expect(notify).not.toHaveBeenCalled();
  });
});
