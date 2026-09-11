// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { beforeEach, describe, expect, it, vi } from "vitest";

import type { SharedWorkspaceApi } from "../ports/SharedWorkspaceApi";
import type {
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
  ) {
    const dispatch = (action: CollaborationWorkspaceControllerAction) => {
      actions.push(action);
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
    expect(state.selectedIssue).toEqual(issue);
    expect(state.attachments).toEqual([attachment]);
    expect(state.comments).toEqual([comment]);
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

  it("reloads the board and reports a conflict after a reorder version conflict", async () => {
    const api = createApi();
    api.issues.update = vi
      .fn()
      .mockResolvedValue({ ...issue, status: "completed", version: 2 });
    api.issues.reorder = vi.fn().mockRejectedValue({ status: 409 });
    const { commands, notify } = createController(api);
    const optimisticIssue = { ...issue, status: "completed" };

    await commands.reorderIssue({
      issue,
      status: "completed",
      laneIds: [issue.id],
      optimisticItems: [optimisticIssue],
    });

    expect(api.issues.getBoardSnapshot).toHaveBeenCalledWith(project.id);
    expect(state.issues).toEqual([issue]);
    expect(state.error).toBe("conflict");
    expect(notify).toHaveBeenCalledWith("conflict", "error");
    expect(actions.at(-1)).toEqual({
      type: "error",
      value: "conflict",
      source: "conflict",
    });
  });

  it("moves an issue into its target status before reordering that lane", async () => {
    const api = createApi();
    const movedIssue = { ...issue, status: "completed", version: 2 };
    api.issues.update = vi.fn().mockResolvedValue(movedIssue);
    api.issues.reorder = vi.fn().mockResolvedValue([movedIssue]);
    const { commands } = createController(api);

    await commands.reorderIssue({
      issue,
      status: "completed",
      laneIds: [issue.id],
      optimisticItems: [movedIssue],
    });

    expect(api.issues.update).toHaveBeenCalledWith(issue.id, {
      version: issue.version,
      status: "completed",
    });
    expect(api.issues.update.mock.invocationCallOrder[0]).toBeLessThan(
      api.issues.reorder.mock.invocationCallOrder[0],
    );
    expect(api.issues.reorder).toHaveBeenCalledWith(project.id, {
      parentId: null,
      status: "completed",
      issueIds: [issue.id],
    });
    expect(state.issues).toEqual([movedIssue]);
  });

  it("does not let an older reorder snapshot erase fields returned by the mutation", async () => {
    const api = createApi();
    const movedIssue = {
      ...issue,
      status: "completed",
      version: 2,
      workflow: {
        version: 1,
        definition_version: 1,
        stage_mode: "dag" as const,
        advancement_policy: "manual" as const,
        nodes: [],
      },
    };
    api.issues.reorder = vi.fn().mockResolvedValue([
      {
        ...issue,
        status: "completed",
        version: 1,
      },
    ]);
    const { commands } = createController(api);

    await commands.reorderIssue({
      issue: movedIssue,
      status: "completed",
      laneIds: [issue.id],
      optimisticItems: [movedIssue],
    });

    expect(state.issues).toEqual([movedIssue]);
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
});
