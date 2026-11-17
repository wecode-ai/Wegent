// @vitest-environment jsdom
// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

import { Activity, act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CollaborationApp } from "./CollaborationApp";
import { collaborationMessages } from "./i18n";
import type { SharedWorkspaceApi } from "./ports/SharedWorkspaceApi";
import type { CollaborationLocation, CollaborationProject } from "./types";
import {
  RetainedProjectSettingsPages,
  type ProjectSettingsPagesProps,
} from "./project-manage/ProjectSettingsPages";

function RetainedSettingsPages(props: ProjectSettingsPagesProps) {
  return <RetainedProjectSettingsPages {...props} boundary={Activity} />;
}

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
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
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
      listPage: vi.fn(async () => ({
        items: [],
        taskBindings: [],
        nextCursor: null,
      })),
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
        host={{
          location,
          navigate,
          capabilities: {},
          settingsPages: RetainedSettingsPages,
        }}
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
  it.each(["Owner", null] as const)(
    "retains a provider draft across settings sections and gates writes until its current role is %s",
    async (role) => {
      const api = createApi();
      const selected: CollaborationProject = {
        ...project,
        project_store: "backend",
        task_provider: "github",
        provider_config: { repository: "original/repo" },
      };
      vi.mocked(api.projects.get).mockResolvedValue(selected);
      container = document.createElement("div");
      document.body.append(container);
      root = createRoot(container);
      function Host() {
        const [location, navigate] = useState<CollaborationLocation>({
          projectId: project.id,
          issueId: null,
          view: "manage",
          projectSettingsSection: "project",
        });
        return (
          <CollaborationApp
            api={api}
            initialProject={selected}
            host={{
              location,
              navigate,
              capabilities: {},
              settingsPages: RetainedSettingsPages,
            }}
            pollIntervalMs={0}
          />
        );
      }
      await act(async () => root!.render(<Host />));
      const input = query(
        "cloud-project-provider-manage-repository",
      ) as HTMLInputElement;
      await act(async () => {
        Object.getOwnPropertyDescriptor(
          HTMLInputElement.prototype,
          "value",
        )!.set!.call(input, "https://github.com/unsaved/draft");
        input.dispatchEvent(new Event("input", { bubbles: true }));
      });
      await act(async () =>
        query("collaboration-project-settings-environments")!.click(),
      );
      const pending = deferred<CollaborationProject>();
      vi.mocked(api.projects.get).mockReturnValueOnce(pending.promise);
      await act(async () =>
        query("collaboration-project-settings-project")!.click(),
      );
      const save = query(
        "cloud-project-provider-manage-save",
      ) as HTMLButtonElement;
      expect(query("cloud-project-provider-manage-repository")).toBe(input);
      expect(save.matches(":disabled")).toBe(true);
      await act(async () => save.click());
      expect(api.projects.update).not.toHaveBeenCalled();
      await act(async () => pending.reject(new Error("Current read failed")));
      expect(
        query("collaboration-project-settings-read")?.getAttribute("role"),
      ).toBe("alert");
      expect(query("cloud-project-provider-manage-repository")).toBe(input);
      expect(save.matches(":disabled")).toBe(true);
      await act(async () => save.click());
      expect(api.projects.update).not.toHaveBeenCalled();
      const retry = deferred<CollaborationProject>();
      vi.mocked(api.projects.get).mockReturnValueOnce(retry.promise);
      await act(async () =>
        query("collaboration-project-settings-read-retry")!.click(),
      );
      expect(save.matches(":disabled")).toBe(true);
      await act(async () => retry.resolve({ ...selected, access_role: role }));

      if (role === null) {
        expect(query("cloud-project-provider-manage-repository")).toBeNull();
        expect(query("cloud-project-provider-manage-save")).toBeNull();
        expect(api.projects.update).not.toHaveBeenCalled();
        return;
      }
      expect(
        (query("cloud-project-provider-manage-repository") as HTMLInputElement)
          .value,
      ).toBe("https://github.com/unsaved/draft");
      expect(query("cloud-project-provider-manage-repository")).toBe(input);
      expect(api.projects.get).toHaveBeenCalledTimes(4);
      expect(save.matches(":disabled")).toBe(false);
      await act(async () => save.click());
      expect(api.projects.update).toHaveBeenCalledTimes(1);
    },
  );

  it("keeps the same-project provider draft mounted when the application language changes", async () => {
    const api = createApi();
    const providerProject: CollaborationProject = {
      ...project,
      project_store: "backend",
      task_provider: "github",
      provider_config: { repository: "original/repo" },
    };
    vi.mocked(api.projects.get).mockResolvedValue(providerProject);
    const host = {
      location: {
        projectId: project.id,
        issueId: null,
        view: "manage" as const,
        projectSettingsSection: "project" as const,
      },
      navigate: vi.fn(),
      capabilities: {},
    };
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    const page = (locale: "zh-CN" | "en") => (
      <CollaborationApp
        api={api}
        initialProject={providerProject}
        host={host}
        locale={locale}
        pollIntervalMs={0}
      />
    );
    await act(async () => root!.render(page("zh-CN")));
    const input = query(
      "cloud-project-provider-manage-repository",
    ) as HTMLInputElement;
    await act(async () => {
      Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value",
      )!.set!.call(input, "https://github.com/unsaved/draft");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(input.value).toBe("https://github.com/unsaved/draft");
    const unexpectedRead = deferred<CollaborationProject>();
    vi.mocked(api.projects.get).mockReturnValueOnce(unexpectedRead.promise);

    await act(async () => root!.render(page("en")));
    await act(async () => unexpectedRead.resolve(providerProject));

    expect(query("cloud-project-provider-manage-repository")).toBe(input);
    expect(input.value).toBe("https://github.com/unsaved/draft");
    expect(api.projects.get).toHaveBeenCalledTimes(1);
  });

  it("reports a pending project read failure in the latest application language without restarting it", async () => {
    const api = createApi();
    const current = deferred<CollaborationProject>();
    vi.mocked(api.projects.get).mockReturnValueOnce(current.promise);
    const host = {
      location: {
        projectId: project.id,
        issueId: null,
        view: "manage" as const,
        projectSettingsSection: "environments" as const,
      },
      navigate: vi.fn(),
      capabilities: {},
    };
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    const page = (locale: "zh-CN" | "en") => (
      <CollaborationApp
        api={api}
        initialProject={project}
        host={host}
        locale={locale}
        pollIntervalMs={0}
      />
    );
    await act(async () => root!.render(page("zh-CN")));
    await act(async () => root!.render(page("en")));
    await act(async () => current.reject(new Error("Read failed")));

    expect(api.projects.get).toHaveBeenCalledTimes(1);
    expect(query("collaboration-error")?.textContent).toBe(
      collaborationMessages.en.loadFailed,
    );
    expect(environment("-configuration-read")?.getAttribute("role")).toBe(
      "alert",
    );
  });

  it("keeps navigation and cached runners available during a current project read", async () => {
    const api = createApi();
    await render(api);
    const policy = environment("-workspace-policy") as HTMLSelectElement;
    await act(async () => {
      Object.getOwnPropertyDescriptor(
        HTMLSelectElement.prototype,
        "value",
      )!.set!.call(policy, "project");
      policy.dispatchEvent(new Event("change", { bubbles: true }));
    });
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
    expect(environment("-workspace-policy")).toBe(policy);
    expect(policy.value).toBe("project");
    expect(policy.matches(":disabled")).toBe(true);
    const save = environment("-save-configuration") as HTMLButtonElement;
    await act(async () => save.click());
    expect(api.projects.update).not.toHaveBeenCalled();
    expect((environment("-add") as HTMLButtonElement).disabled).toBe(false);
    await act(async () => environment("-add")!.click());
    expect(environment("-candidate-2")).not.toBeNull();
    expect(environment("-picker-loading")).toBeNull();
    expect((environment("-initialize-1") as HTMLButtonElement).disabled).toBe(
      true,
    );
    await act(async () => environment("-initialize-1")!.click());
    expect(api.projects.initializeExecutionEnvironment).not.toHaveBeenCalled();
    await act(async () =>
      current.reject(new Error("Current metadata unavailable")),
    );
    expect(environment("-configuration-read")?.getAttribute("role")).toBe(
      "alert",
    );
    expect(environment("-workspace-policy")).toBe(policy);
    expect(policy.matches(":disabled")).toBe(true);
    await act(async () => save.click());
    expect(api.projects.update).not.toHaveBeenCalled();
    await act(async () => environment("-initialize-1")!.click());
    expect(api.projects.initializeExecutionEnvironment).not.toHaveBeenCalled();
    const recovered = deferred<CollaborationProject>();
    vi.mocked(api.projects.get).mockReturnValueOnce(recovered.promise);
    await act(async () => environment("-configuration-read-retry")!.click());
    expect((environment("-initialize-1") as HTMLButtonElement).disabled).toBe(
      true,
    );
    await act(async () => recovered.resolve({ ...project, version: 3 }));
    expect(environment("-workspace-policy")).toBe(policy);
    expect(policy.value).toBe("project");
    expect(policy.matches(":disabled")).toBe(false);
    expect((environment("-initialize-1") as HTMLButtonElement).disabled).toBe(
      true,
    );
    expect(save.matches(":disabled")).toBe(false);
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
