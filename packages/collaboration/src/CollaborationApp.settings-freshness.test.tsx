// @vitest-environment jsdom
// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CollaborationApp } from "./CollaborationApp";
import type { SharedWorkspaceApi } from "./ports/SharedWorkspaceApi";
import type { CollaborationLocation, CollaborationProject } from "./types";

const project = {
  id: "project-a",
  name: "Project A",
  project_key: "A",
  project_store: "local",
  task_provider: "local",
  provider_config: {},
  access_role: "Owner",
  tags: [],
  version: 1,
} as CollaborationProject;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}

function createApi() {
  const device = {
    id: "runner-1",
    device_id: 1,
    name: "Cached runner",
    status: "online",
    kind: "local_device",
    owner_type: "user",
    owner_id: "1",
    coding_tools: [],
  };
  return {
    projects: {
      get: vi.fn(async () => project),
      list: vi.fn(async () => [project]),
      listExecutionEnvironments: vi.fn(async () => [device]),
      update: vi.fn(async () => project),
      initializeExecutionEnvironment: vi.fn(async () => project),
    },
    resources: {
      devices: {
        local: vi.fn(async () => [{ ...device, id: "runner-2", device_id: 2 }]),
      },
    },
    issues: {
      getBoardSnapshot: vi.fn(async () => ({
        items: [],
        members: [],
        agents: [],
        taskBindings: [],
      })),
    },
  } as unknown as SharedWorkspaceApi;
}

let root: Root | undefined;
let container: HTMLDivElement;

beforeEach(() => vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true));

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = undefined;
  vi.unstubAllGlobals();
});

async function render(api: SharedWorkspaceApi) {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  function Host() {
    const [location, navigate] = useState<CollaborationLocation>({
      projectId: project.id,
      issueId: null,
      view: "manage",
      projectSettingsSection: "environments",
    });
    return (
      <CollaborationApp
        api={api}
        initialProject={project}
        pollIntervalMs={0}
        host={{ location, navigate, capabilities: {} }}
      />
    );
  }
  await act(async () => root!.render(<Host />));
}

const query = (testId: string) =>
  container.querySelector<HTMLElement>(`[data-testid="${testId}"]`);
const environment = (suffix: string) =>
  query(`collaboration-project-execution-environment${suffix}`);

describe("project settings metadata freshness", () => {
  it("keeps navigation and cached runners available during a current project read", async () => {
    const api = createApi();
    await render(api);
    expect(environment("-1")).not.toBeNull();
    await act(async () => environment("-add")!.click());
    expect(environment("-candidate-2")).not.toBeNull();
    await act(async () => environment("-add")!.click());
    const shell = query("project-settings-shell");
    await act(async () =>
      query("collaboration-project-settings-project")!.click(),
    );
    const current = deferred<CollaborationProject>();
    vi.mocked(api.projects.get).mockReturnValueOnce(current.promise);
    const candidates = deferred<never[]>();
    vi.mocked(api.resources!.devices.local!).mockReturnValueOnce(
      candidates.promise,
    );

    await act(async () =>
      query("collaboration-project-settings-environments")!.click(),
    );

    expect(api.projects.get).toHaveBeenCalledTimes(3);
    expect(query("project-settings-shell")).toBe(shell);
    expect(query("collaboration-project-settings-agents")).not.toBeNull();
    expect(environment("-1")).not.toBeNull();
    expect(environment("-loading")).toBeNull();
    expect((environment("-add") as HTMLButtonElement).disabled).toBe(false);
    await act(async () => environment("-add")!.click());
    expect(environment("-candidate-2")).not.toBeNull();
    expect(environment("-picker-loading")).toBeNull();
    expect((environment("-initialize-1") as HTMLButtonElement).disabled).toBe(
      true,
    );
    await act(async () => current.resolve({ ...project, version: 3 }));
    expect((environment("-initialize-1") as HTMLButtonElement).disabled).toBe(
      false,
    );
    await act(async () => candidates.resolve([]));
    expect(environment("-candidate-2")).toBeNull();
  });

  it("seeds preparation content and its version only from the completed current read", async () => {
    const api = createApi();
    const current = deferred<CollaborationProject>();
    vi.mocked(api.projects.get).mockReturnValueOnce(current.promise);
    await render(api);
    expect(environment("-1")).not.toBeNull();
    expect(environment("-workspace-policy")).toBeNull();
    expect(environment("-configuration-read")?.getAttribute("role")).toBe(
      "status",
    );
    await act(async () => environment("-initialize-1")!.click());
    expect(api.projects.initializeExecutionEnvironment).not.toHaveBeenCalled();

    const latest = {
      ...project,
      version: 3,
      execution_environment: {
        workspace_policy: "project" as const,
        repositories: [
          {
            name: "Current",
            url: "https://example.test/current.git",
            ref: "main",
            path: "current",
            primary: true,
          },
        ],
        setup_steps: [
          { command: "current-setup", working_directory: "current" },
        ],
      },
    };
    await act(async () => current.resolve(latest));
    expect((environment("-workspace-policy") as HTMLSelectElement).value).toBe(
      "project",
    );
    expect((environment("-repository-name-0") as HTMLInputElement).value).toBe(
      "Current",
    );
    expect((environment("-setup-command-0") as HTMLInputElement).value).toBe(
      "current-setup",
    );
    await act(async () => environment("-initialize-1")!.click());
    expect(
      api.projects.initializeExecutionEnvironment,
    ).toHaveBeenCalledExactlyOnceWith(project.id, {
      deviceId: 1,
      version: 3,
    });
  });

  it("isolates a current-read failure to configuration and recovers through its retry action", async () => {
    const api = createApi();
    vi.mocked(api.projects.get).mockRejectedValueOnce(
      new Error("Current metadata unavailable"),
    );
    await render(api);
    expect(query("collaboration-project-settings-agents")).not.toBeNull();
    expect(environment("-1")).not.toBeNull();
    expect((environment("-add") as HTMLButtonElement).disabled).toBe(false);
    expect(environment("-configuration-read")?.getAttribute("role")).toBe(
      "alert",
    );
    expect((environment("-initialize-1") as HTMLButtonElement).disabled).toBe(
      true,
    );
    expect(environment("-workspace-policy")).toBeNull();
    await act(async () => environment("-configuration-read-retry")!.click());
    expect(api.projects.get).toHaveBeenCalledTimes(2);
    expect(environment("-configuration-read")).toBeNull();
    expect((environment("-initialize-1") as HTMLButtonElement).disabled).toBe(
      false,
    );
  });
});
