// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { beforeEach, describe, expect, it, vi } from "vitest";

import type { SharedWorkspaceApi } from "../ports/SharedWorkspaceApi";
import type {
  CollaborationIssue,
  CollaborationLocation,
  CollaborationProject,
} from "../types";

type Effect = () => void | (() => void);

const hookRuntime = vi.hoisted(() => {
  let hookIndex = 0;
  let hooks: Array<Record<string, unknown>> = [];
  let pendingEffects: Array<{ effect: Effect; index: number }> = [];

  const dependenciesChanged = (
    previous: unknown[] | undefined,
    next: unknown[],
  ) =>
    !previous ||
    previous.length !== next.length ||
    previous.some((value, index) => !Object.is(value, next[index]));

  return {
    reset() {
      hooks = [];
      pendingEffects = [];
      hookIndex = 0;
    },
    beginRender() {
      hookIndex = 0;
      pendingEffects = [];
    },
    flushEffects() {
      for (const { effect, index } of pendingEffects) {
        const hook = hooks[index];
        const cleanup = hook.cleanup;
        if (typeof cleanup === "function") cleanup();
        hook.cleanup = effect();
      }
      pendingEffects = [];
    },
    useEffect(effect: Effect, dependencies: unknown[]) {
      const index = hookIndex++;
      const hook = hooks[index] ?? {};
      hooks[index] = hook;
      const previous = hook.dependencies as unknown[] | undefined;
      if (dependenciesChanged(previous, dependencies)) {
        hook.dependencies = dependencies;
        pendingEffects.push({ effect, index });
      }
    },
    useMemo<T>(factory: () => T, dependencies: unknown[]) {
      const index = hookIndex++;
      const hook = hooks[index] ?? {};
      hooks[index] = hook;
      const previous = hook.dependencies as unknown[] | undefined;
      if (dependenciesChanged(previous, dependencies)) {
        hook.dependencies = dependencies;
        hook.value = factory();
      }
      return hook.value as T;
    },
    useReducer<State, Action>(
      reducer: (state: State, action: Action) => State,
      initialState: State,
    ): [State, (action: Action) => void] {
      const index = hookIndex++;
      const hook = hooks[index] ?? { state: initialState };
      hooks[index] = hook;
      return [
        hook.state as State,
        (action) => {
          hook.state = reducer(hook.state as State, action);
        },
      ];
    },
    useRef<T>(initialValue: T) {
      const index = hookIndex++;
      const hook = hooks[index] ?? { current: initialValue };
      hooks[index] = hook;
      return hook as { current: T };
    },
  };
});

vi.mock("react", () => ({
  useEffect: hookRuntime.useEffect,
  useMemo: hookRuntime.useMemo,
  useReducer: hookRuntime.useReducer,
  useRef: hookRuntime.useRef,
}));

import {
  type CollaborationWorkspaceController,
  useCollaborationWorkspaceController,
} from "./useCollaborationWorkspaceController";

const projectA: CollaborationProject = {
  id: "project-a",
  public_id: "public-a",
  project_key: "A",
  name: "Project A",
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

const projectB: CollaborationProject = {
  ...projectA,
  id: "project-b",
  public_id: "public-b",
  project_key: "B",
  name: "Project B",
};

function createIssue(
  id: string,
  project: CollaborationProject,
): CollaborationIssue {
  return {
    id,
    cloud_project_id: project.id,
    sequence_number: 1,
    parent_id: null,
    created_by_user_id: 1,
    assignee_user_id: null,
    title: id,
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
}

const issueA = createIssue("issue-a", projectA);
const issueB = createIssue("issue-b", projectB);

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function createApi(): SharedWorkspaceApi {
  return {
    projects: {
      list: vi.fn().mockResolvedValue([projectA, projectB]),
      get: vi.fn(async (projectId: string) =>
        projectId === projectA.id ? projectA : projectB,
      ),
      create: vi.fn(),
      update: vi.fn(),
      archive: vi.fn(),
    },
    issues: {
      getBoardSnapshot: vi.fn(async (projectId: string) => ({
        items: [projectId === projectA.id ? issueA : issueB],
        members: [],
        agents: [],
        taskBindings: [],
      })),
      get: vi.fn(async (issueId: string) =>
        issueId === issueA.id ? issueA : issueB,
      ),
      create: vi.fn(),
      update: vi.fn(),
      archive: vi.fn(),
      reorder: vi.fn(),
    },
    attachments: {
      list: vi.fn().mockResolvedValue([]),
    },
    comments: {
      list: vi.fn().mockResolvedValue([]),
    },
  } as unknown as SharedWorkspaceApi;
}

const messages = {
  loadFailed: "load failed",
  saveFailed: "save failed",
  conflict: "conflict",
};

function renderController(
  api: SharedWorkspaceApi,
  location: CollaborationLocation,
  myWorkEnabled?: boolean,
): CollaborationWorkspaceController {
  hookRuntime.beginRender();
  const controller = useCollaborationWorkspaceController({
    api,
    location,
    messages,
    ...(myWorkEnabled === undefined ? {} : { myWorkEnabled }),
    pollIntervalMs: 0,
  });
  hookRuntime.flushEffects();
  return controller;
}

describe("useCollaborationWorkspaceController location effects", () => {
  beforeEach(() => {
    hookRuntime.reset();
  });

  it("defaults My Work closed and falls an old root location back to home", async () => {
    const api = createApi();

    renderController(api, {
      projectId: null,
      issueId: null,
      view: "board",
      rootView: "my-work",
    });

    await vi.waitFor(() => {
      expect(api.projects.list).toHaveBeenCalledOnce();
    });
    expect(api.myWork).toBeUndefined();
  });

  it("does not return to project A when its catalog resolves after navigation to B", async () => {
    const catalogA = deferred<CollaborationProject[]>();
    const catalogB = deferred<CollaborationProject[]>();
    const api = createApi();
    vi.mocked(api.projects.list)
      .mockImplementationOnce(() => catalogA.promise)
      .mockImplementationOnce(() => catalogB.promise);

    renderController(api, {
      projectId: projectA.id,
      issueId: null,
      view: "board",
    });
    renderController(api, {
      projectId: projectB.id,
      issueId: null,
      view: "board",
    });

    catalogB.resolve([projectA, projectB]);
    await vi.waitFor(() => {
      expect(api.issues.getBoardSnapshot).toHaveBeenCalledWith(projectB.id);
    });

    catalogA.resolve([projectA, projectB]);
    await Promise.resolve();
    await Promise.resolve();

    const controller = renderController(api, {
      projectId: projectB.id,
      issueId: null,
      view: "board",
    });
    expect(api.issues.getBoardSnapshot).not.toHaveBeenCalledWith(projectA.id);
    expect(controller.state.project).toEqual(projectB);
    expect(controller.state.issues).toEqual([issueB]);
  });

  it("clears the old issue immediately and rejects its response after switching issue IDs", async () => {
    const issueBResponse = deferred<CollaborationIssue>();
    const api = createApi();
    vi.mocked(api.issues.get).mockImplementation((issueId: string) =>
      issueId === issueB.id ? issueBResponse.promise : Promise.resolve(issueA),
    );

    renderController(api, {
      projectId: null,
      issueId: issueA.id,
      view: "board",
    });
    await vi.waitFor(() => {
      const controller = renderController(api, {
        projectId: null,
        issueId: issueA.id,
        view: "board",
      });
      expect(controller.state.selectedIssue).toEqual(issueA);
    });
    let controller = renderController(api, {
      projectId: null,
      issueId: issueA.id,
      view: "board",
    });
    expect(controller.state.selectedIssue).toEqual(issueA);

    controller = renderController(api, {
      projectId: null,
      issueId: issueB.id,
      view: "board",
    });
    expect(controller.state.selectedIssue).toBeNull();
    expect(controller.state.attachments).toEqual([]);
    expect(controller.state.comments).toEqual([]);

    renderController(api, {
      projectId: null,
      issueId: issueA.id,
      view: "board",
    });
    issueBResponse.resolve(issueB);
    await vi.waitFor(() => {
      controller = renderController(api, {
        projectId: null,
        issueId: issueA.id,
        view: "board",
      });
      expect(controller.state.selectedIssue).toEqual(issueA);
    });
  });
});
