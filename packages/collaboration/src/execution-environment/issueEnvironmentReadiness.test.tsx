// @vitest-environment jsdom

// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { SharedWorkspaceApi } from "../ports/SharedWorkspaceApi";
import type {
  CollaborationExecutionEnvironment,
  CollaborationProject,
} from "../types";
import {
  resolveProjectExecutionEnvironmentReadiness,
  useProjectExecutionEnvironmentReadiness,
} from "./issueEnvironmentReadiness";

const baseProject: CollaborationProject = {
  id: "project-1",
  workspace_id: "workspace-1",
  public_id: "project-public-1",
  project_key: "PRJ",
  name: "Project",
  description: "",
  project_store: "backend",
  task_provider: "local",
  provider_config: {},
  created_by_user_id: 1,
  access_role: "Owner",
  status: "active",
  tags: [],
  version: 1,
  created_at: "2026-09-21T00:00:00Z",
  updated_at: "2026-09-21T00:00:00Z",
};

function environment(
  status: CollaborationExecutionEnvironment["status"] = "online",
): CollaborationExecutionEnvironment {
  return {
    id: "environment-1",
    device_id: 21,
    device_key: "device-21",
    name: "Device",
    kind: "local_device",
    coding_tools: ["codex"],
    owner_type: "user",
    owner_id: "1",
    owner_name: "Owner",
    status,
    updated_at: "2026-09-21T00:00:00Z",
  };
}

function projectWithDevice(
  status: "preparing" | "ready" | "error" | undefined,
  workspacePath?: string,
): CollaborationProject {
  return {
    ...baseProject,
    execution_environment: {
      repositories: [],
      setup_steps: [],
      fingerprint: "environment-v1",
      devices: {
        "device-21": {
          status,
          workspace_path: workspacePath,
          error: status === "error" ? "clone failed" : undefined,
        },
      },
    },
  };
}

describe("resolveProjectExecutionEnvironmentReadiness", () => {
  it.each([
    ["unassigned", baseProject, []],
    [
      "offline",
      projectWithDevice("ready", "/workspace"),
      [environment("offline")],
    ],
    ["uninitialized", baseProject, [environment("online")]],
    ["preparing", projectWithDevice("preparing"), [environment("online")]],
    ["error", projectWithDevice("error"), [environment("online")]],
  ] as const)("resolves %s", (expected, project, environments) => {
    expect(
      resolveProjectExecutionEnvironmentReadiness(project, environments).kind,
    ).toBe(expected);
  });

  it("requires an online device, ready state, and non-empty workspace path", () => {
    expect(
      resolveProjectExecutionEnvironmentReadiness(
        projectWithDevice("ready", "/workspace"),
        [environment("online")],
      ).kind,
    ).toBe("ready");
    expect(
      resolveProjectExecutionEnvironmentReadiness(
        projectWithDevice("ready", "  "),
        [environment("online")],
      ).kind,
    ).toBe("uninitialized");
  });

  it("requires a prepared execution environment for a local project", () => {
    expect(
      resolveProjectExecutionEnvironmentReadiness(
        { ...baseProject, project_store: "local" },
        [],
      ).kind,
    ).toBe("unassigned");
  });
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((next, fail) => {
    resolve = next;
    reject = fail;
  });
  return { promise, reject, resolve };
}

function Probe({
  api,
  onRefresh,
  project,
}: {
  api: SharedWorkspaceApi;
  onRefresh?(readiness: string): void;
  project: CollaborationProject;
}) {
  const readiness = useProjectExecutionEnvironmentReadiness({
    api,
    project,
    refreshIntervalMs: 0,
  });
  return (
    <>
      <output data-testid="readiness">{readiness.kind}</output>
      {onRefresh ? (
        <button
          data-testid="refresh"
          onClick={() => {
            void readiness
              .refresh()
              .then((nextReadiness) => onRefresh(nextReadiness.kind));
          }}
          type="button"
        >
          Refresh
        </button>
      ) : null}
    </>
  );
}

let root: Root | null = null;
let container: HTMLDivElement | null = null;

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
});

async function renderProbe(
  api: SharedWorkspaceApi,
  project: CollaborationProject,
) {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root!.render(<Probe api={api} project={project} />));
}

describe("useProjectExecutionEnvironmentReadiness", () => {
  it("loads execution environment readiness for a local project", async () => {
    const api = {
      projects: {
        listExecutionEnvironments: vi.fn(async () => [environment("online")]),
      },
    } as unknown as SharedWorkspaceApi;

    await renderProbe(api, {
      ...projectWithDevice("ready", "/workspace"),
      project_store: "local",
    });

    expect(container?.textContent).toBe("ready");
    expect(api.projects.listExecutionEnvironments).toHaveBeenCalledWith(
      "project-1",
    );
  });

  it("reports a status check failure as unknown without treating it as unassigned", async () => {
    const api = {
      projects: {
        listExecutionEnvironments: vi.fn(async () => {
          throw new Error("network unavailable");
        }),
      },
    } as unknown as SharedWorkspaceApi;

    await renderProbe(api, baseProject);

    expect(container?.textContent).toBe("unknown");
  });

  it("ignores a stale response after switching projects", async () => {
    const first = deferred<CollaborationExecutionEnvironment[]>();
    const second = deferred<CollaborationExecutionEnvironment[]>();
    const api = {
      projects: {
        listExecutionEnvironments: vi
          .fn()
          .mockReturnValueOnce(first.promise)
          .mockReturnValueOnce(second.promise),
      },
    } as unknown as SharedWorkspaceApi;
    const nextProject = {
      ...projectWithDevice("ready", "/workspace"),
      id: "project-2",
      public_id: "project-public-2",
    };

    await renderProbe(api, baseProject);
    await act(async () =>
      root!.render(<Probe api={api} project={nextProject} />),
    );
    await act(async () => second.resolve([environment("online")]));
    expect(container?.textContent).toBe("ready");

    await act(async () => first.resolve([]));
    expect(container?.textContent).toBe("ready");
  });

  it("keeps assigned devices usable while an initialized project version refreshes", async () => {
    const refreshed = deferred<CollaborationExecutionEnvironment[]>();
    const api = {
      projects: {
        listExecutionEnvironments: vi
          .fn()
          .mockResolvedValueOnce([environment("online")])
          .mockReturnValueOnce(refreshed.promise),
      },
    } as unknown as SharedWorkspaceApi;

    await renderProbe(api, baseProject);
    expect(container?.textContent).toBe("uninitialized");

    await act(async () =>
      root!.render(
        <Probe
          api={api}
          project={{
            ...projectWithDevice("ready", "/workspace"),
            version: 2,
          }}
        />,
      ),
    );

    expect(container?.textContent).toBe("ready");
    await act(async () => refreshed.resolve([environment("online")]));
    expect(container?.textContent).toBe("ready");
  });

  it("returns the authoritative readiness to an action while the hook is still loading", async () => {
    const initialLoad = deferred<CollaborationExecutionEnvironment[]>();
    const api = {
      projects: {
        listExecutionEnvironments: vi
          .fn()
          .mockReturnValueOnce(initialLoad.promise)
          .mockResolvedValueOnce([environment("online")]),
      },
    } as unknown as SharedWorkspaceApi;
    const onRefresh = vi.fn();

    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () =>
      root!.render(
        <Probe
          api={api}
          onRefresh={onRefresh}
          project={projectWithDevice("ready", "/workspace")}
        />,
      ),
    );
    expect(container.textContent).toContain("loading");

    await act(async () => {
      container
        ?.querySelector<HTMLButtonElement>('[data-testid="refresh"]')
        ?.click();
    });

    expect(onRefresh).toHaveBeenCalledWith("ready");
    expect(container.textContent).toContain("ready");
    await act(async () => initialLoad.resolve([]));
    expect(container.textContent).toContain("ready");
  });
});
