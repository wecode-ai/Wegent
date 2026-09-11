// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { beforeEach, describe, expect, it, vi } from "vitest";

import type {
  ProjectManageApi,
  ProjectManageHost,
  ProjectManageItem,
  ProjectManageMember,
  ProjectManageProject,
  ProjectManageUser,
} from "./types";

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
      hookIndex = 0;
      hooks = [];
      pendingEffects = [];
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
    useCallback<T>(callback: T, dependencies: unknown[]) {
      const index = hookIndex++;
      const hook = hooks[index] ?? {};
      hooks[index] = hook;
      const previous = hook.dependencies as unknown[] | undefined;
      if (dependenciesChanged(previous, dependencies)) {
        hook.dependencies = dependencies;
        hook.value = callback;
      }
      return hook.value as T;
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
    useRef<T>(initialValue: T) {
      const index = hookIndex++;
      const hook = hooks[index] ?? { current: initialValue };
      hooks[index] = hook;
      return hook as { current: T };
    },
    useState<T>(initialValue: T | (() => T)) {
      const index = hookIndex++;
      const hook = hooks[index] ?? {
        value:
          typeof initialValue === "function"
            ? (initialValue as () => T)()
            : initialValue,
      };
      hooks[index] = hook;
      const setValue = (next: T | ((current: T) => T)) => {
        hook.value =
          typeof next === "function"
            ? (next as (current: T) => T)(hook.value as T)
            : next;
      };
      return [hook.value as T, setValue] as const;
    },
  };
});

vi.mock("react", () => ({
  useCallback: hookRuntime.useCallback,
  useEffect: hookRuntime.useEffect,
  useMemo: hookRuntime.useMemo,
  useRef: hookRuntime.useRef,
  useState: hookRuntime.useState,
}));

import { ProjectManageView } from "./ProjectManageView";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function project(
  id: string,
  visibility: "private" | "public",
  version = 1,
): ProjectManageProject {
  return {
    id,
    task_provider: "local",
    provider_config: {},
    visibility,
    tags: [],
    version,
  };
}

function createApi() {
  return {
    listMembers: vi.fn().mockResolvedValue([]),
    listItems: vi.fn().mockResolvedValue({ items: [] }),
    searchUsers: vi.fn().mockResolvedValue({ users: [] }),
    addMember: vi.fn(),
    updateMember: vi.fn(),
    removeMember: vi.fn(),
    updateItem: vi.fn(),
    updateProject: vi.fn(),
  } as unknown as ProjectManageApi<
    ProjectManageProject,
    ProjectManageMember,
    ProjectManageItem,
    ProjectManageUser
  >;
}

const Icon = () => null;

function createHost(): ProjectManageHost {
  return {
    icons: {
      Check: Icon,
      GitBranch: Icon,
      LockKeyhole: Icon,
      Pencil: Icon,
      Search: Icon,
      Trash2: Icon,
      X: Icon,
    },
    translate: (_key, fallback) => fallback,
    confirm: () => true,
    trackCompleted: vi.fn(),
    trackFailed: vi.fn(),
    renderTooltip: ({ children }) => children,
    renderActionMenu: () => null,
  };
}

function renderView(
  api: ReturnType<typeof createApi>,
  host: ProjectManageHost,
  currentProject: ProjectManageProject,
  onProjectUpdated: (project: ProjectManageProject) => void,
) {
  hookRuntime.beginRender();
  const tree = ProjectManageView({
    api,
    host,
    project: currentProject,
    onProjectUpdated,
  });
  hookRuntime.flushEffects();
  return tree;
}

function findByTestId(node: unknown, testId: string): any {
  if (Array.isArray(node)) {
    for (const child of node) {
      const match = findByTestId(child, testId);
      if (match) return match;
    }
    return null;
  }
  if (!node || typeof node !== "object") return null;
  const element = node as {
    props?: { children?: unknown; "data-testid"?: string };
  };
  if (element.props?.["data-testid"] === testId) return element;
  const children = element.props?.children;
  for (const child of Array.isArray(children) ? children : [children]) {
    const match = findByTestId(child, testId);
    if (match) return match;
  }
  return null;
}

async function flushPromises() {
  await Promise.resolve();
  await Promise.resolve();
}

describe("ProjectManageView project scope", () => {
  beforeEach(() => {
    hookRuntime.reset();
  });

  it("does not write an old project mutation response into the new project", async () => {
    const api = createApi();
    const host = createHost();
    const updateA = deferred<ProjectManageProject>();
    vi.mocked(api.updateProject).mockReturnValue(updateA.promise);
    const onProjectUpdated = vi.fn();
    const projectA = project("project-a", "private");
    const projectB = project("project-b", "private");

    let tree = renderView(api, host, projectA, onProjectUpdated);
    findByTestId(tree, "cloud-project-members-toggle").props.onClick();
    tree = renderView(api, host, projectA, onProjectUpdated);
    findByTestId(
      tree,
      "cloud-project-manage-visibility-public",
    ).props.onClick();
    await flushPromises();

    renderView(api, host, projectB, onProjectUpdated);
    tree = renderView(api, host, projectB, onProjectUpdated);
    findByTestId(tree, "cloud-project-members-toggle").props.onClick();
    tree = renderView(api, host, projectB, onProjectUpdated);
    expect(
      findByTestId(tree, "cloud-project-manage-visibility-private").props
        .className,
    ).toContain("bg-background");

    updateA.resolve(project("project-a", "public", 2));
    await flushPromises();
    tree = renderView(api, host, projectB, onProjectUpdated);

    expect(api.updateProject).toHaveBeenCalledWith("project-a", {
      version: 1,
      visibility: "public",
    });
    expect(onProjectUpdated).not.toHaveBeenCalled();
    expect(
      findByTestId(tree, "cloud-project-manage-visibility-private").props
        .className,
    ).toContain("bg-background");
    expect(
      findByTestId(tree, "cloud-project-manage-visibility-public").props
        .className,
    ).not.toContain("bg-background");
  });
});
