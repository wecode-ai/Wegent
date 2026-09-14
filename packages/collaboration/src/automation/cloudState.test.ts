import { beforeEach, describe, expect, it, vi } from "vitest";

import type {
  AutomationBackendRule,
  AutomationBackendRun,
  AutomationProject,
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
  useRef: hookRuntime.useRef,
  useState: hookRuntime.useState,
}));

import { type AutomationCloudApi, useAutomationCloudState } from "./cloudState";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function project(id: string): AutomationProject {
  return {
    id,
    name: `Project ${id}`,
    version: 1,
    tags: [],
    updated_at: "2026-09-11T00:00:00Z",
    current_user_id: 1,
  };
}

function backendRule(
  projectId: string,
  id = `rule-${projectId}`,
): AutomationBackendRule {
  return {
    id,
    projectId,
    name: `Rule ${projectId}`,
    prompt: "",
    triggerType: "event",
    eventType: "task.created",
    eventConfig: {},
    cronExpression: null,
    timezone: "Asia/Shanghai",
    assignmentMode: "manual",
    managerType: null,
    agentId: null,
    wegentTeamId: null,
    model: null,
    agentName: "",
    executionEnvironment: "cloud",
    executionDeviceId: null,
    enabled: true,
    nextRunAt: null,
    lastRunAt: null,
    lastRunStatus: null,
    version: 1,
    createdAt: "2026-09-11T00:00:00Z",
    updatedAt: "2026-09-11T00:00:00Z",
  };
}

function backendRun(projectId: string): AutomationBackendRun {
  return {
    id: `run-${projectId}`,
    automationId: `rule-${projectId}`,
    projectId,
    trigger: "manual",
    status: "succeeded",
    timezone: "Asia/Shanghai",
    scheduledFor: "2026-09-11T00:00:00Z",
    expiresAt: null,
    taskId: null,
    backendTaskId: null,
    deviceId: null,
    error: null,
    createdAt: "2026-09-11T00:00:00Z",
    updatedAt: "2026-09-11T00:00:01Z",
    completedAt: "2026-09-11T00:00:01Z",
  };
}

function createApi() {
  return {
    list: vi.fn(),
    create: vi.fn(),
    migrateWorkflow: vi.fn(),
    update: vi.fn(),
    remove: vi.fn(),
    runNow: vi.fn(),
    listRuns: vi.fn(),
  } as unknown as AutomationCloudApi;
}

function renderState(
  api: AutomationCloudApi,
  currentProject: AutomationProject,
  cacheSource?: object,
) {
  hookRuntime.beginRender();
  const state = useAutomationCloudState({
    api,
    cacheSource,
    projectApi: {
      clearLegacyWorkflow: vi.fn(),
    },
    project: currentProject,
    canManage: true,
    legacyUpgradeRequiredMessage: "upgrade required",
    serviceUnavailableMessage: "unavailable",
    managePermissionMessage: "forbidden",
    runtimeUserRequiredMessage: "user required",
    duplicateName: (name) => `${name} copy`,
  });
  hookRuntime.flushEffects();
  return state;
}

async function flushPromises() {
  await Promise.resolve();
  await Promise.resolve();
}

describe("useAutomationCloudState async scope", () => {
  beforeEach(() => {
    hookRuntime.reset();
  });

  it("resets scoped state and rejects old rules, runs, error and loading writes", async () => {
    const rulesA = deferred<AutomationBackendRule[]>();
    const rulesB = deferred<AutomationBackendRule[]>();
    const rulesC = deferred<AutomationBackendRule[]>();
    const runsB = deferred<AutomationBackendRun[]>();
    const api = createApi();
    vi.mocked(api.list).mockImplementation((projectId) => {
      if (projectId === "a") return rulesA.promise;
      if (projectId === "b") return rulesB.promise;
      return rulesC.promise;
    });
    vi.mocked(api.listRuns).mockReturnValue(runsB.promise);

    let state = renderState(api, project("a"));
    await flushPromises();
    expect(state.loading).toBe(true);

    state = renderState(api, project("b"));
    expect(state.rules).toEqual([]);
    expect(state.runs).toEqual([]);
    expect(state.error).toBe("");
    expect(state.loading).toBe(true);
    await flushPromises();

    rulesA.resolve([backendRule("a")]);
    await flushPromises();
    state = renderState(api, project("b"));
    expect(state.rules).toEqual([]);
    expect(state.error).toBe("");
    expect(state.loading).toBe(true);

    rulesB.resolve([backendRule("b")]);
    await vi.waitFor(() => {
      state = renderState(api, project("b"));
      expect(state.rules.map((rule) => rule.id)).toEqual(["rule-b"]);
    });
    expect(state.rules.map((rule) => rule.id)).toEqual(["rule-b"]);
    expect(state.error).toBe("");
    expect(state.loading).toBe(false);

    const refresh = state.refreshRuns();
    await flushPromises();
    state = renderState(api, project("c"));
    expect(state.rules).toEqual([]);
    expect(state.runs).toEqual([]);
    expect(state.error).toBe("");
    expect(state.loading).toBe(true);

    runsB.resolve([backendRun("b")]);
    await refresh;
    state = renderState(api, project("c"));
    expect(state.rules).toEqual([]);
    expect(state.runs).toEqual([]);
    expect(state.error).toBe("");
    expect(state.loading).toBe(true);
  });

  it("does not let an old scope rejection set error or finish loading", async () => {
    const rulesOld = deferred<AutomationBackendRule[]>();
    const rulesCurrent = deferred<AutomationBackendRule[]>();
    const api = createApi();
    vi.mocked(api.list).mockImplementation((projectId) =>
      projectId === "old" ? rulesOld.promise : rulesCurrent.promise,
    );

    renderState(api, project("old"));
    await flushPromises();
    let state = renderState(api, project("current"));
    await flushPromises();
    expect(state.loading).toBe(true);

    rulesOld.reject(new Error("old project failed"));
    await flushPromises();
    state = renderState(api, project("current"));

    expect(state.rules).toEqual([]);
    expect(state.runs).toEqual([]);
    expect(state.error).toBe("");
    expect(state.loading).toBe(true);
  });

  it("rejects an old API response when the API changes within the same cache scope", async () => {
    const oldRules = deferred<AutomationBackendRule[]>();
    const currentRules = deferred<AutomationBackendRule[]>();
    const oldApi = createApi();
    const currentApi = createApi();
    const cacheSource = {};
    vi.mocked(oldApi.list).mockReturnValue(oldRules.promise);
    vi.mocked(currentApi.list).mockReturnValue(currentRules.promise);

    renderState(oldApi, project("api-scope"), cacheSource);
    await flushPromises();
    let state = renderState(currentApi, project("api-scope"), cacheSource);
    await flushPromises();

    oldRules.resolve([backendRule("old-api")]);
    await flushPromises();
    state = renderState(currentApi, project("api-scope"), cacheSource);

    expect(state.rules).toEqual([]);
    expect(state.loading).toBe(true);

    currentRules.resolve([backendRule("current-api")]);
    await vi.waitFor(() => {
      state = renderState(currentApi, project("api-scope"), cacheSource);
      expect(state.rules.map((rule) => rule.id)).toEqual(["rule-current-api"]);
    });
  });

  it("rejects an old cache source response within the same project and API", async () => {
    const oldRules = deferred<AutomationBackendRule[]>();
    const currentRules = deferred<AutomationBackendRule[]>();
    const api = createApi();
    const oldCacheSource = {};
    const currentCacheSource = {};
    vi.mocked(api.list)
      .mockReturnValueOnce(oldRules.promise)
      .mockReturnValueOnce(currentRules.promise);

    renderState(api, project("source-scope"), oldCacheSource);
    await flushPromises();
    let state = renderState(api, project("source-scope"), currentCacheSource);
    await flushPromises();

    oldRules.resolve([backendRule("old-source")]);
    await flushPromises();
    state = renderState(api, project("source-scope"), currentCacheSource);

    expect(state.rules).toEqual([]);
    expect(state.loading).toBe(true);

    currentRules.resolve([backendRule("current-source")]);
    await vi.waitFor(() => {
      state = renderState(api, project("source-scope"), currentCacheSource);
      expect(state.rules.map((rule) => rule.id)).toEqual([
        "rule-current-source",
      ]);
    });
  });
});
