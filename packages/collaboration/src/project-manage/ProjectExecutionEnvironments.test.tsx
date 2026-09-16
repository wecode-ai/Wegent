// @vitest-environment jsdom

// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createCollaborationTranslator,
  type CollaborationLocale,
} from "../i18n";
import type { SharedWorkspaceApi } from "../ports/SharedWorkspaceApi";
import type {
  CollaborationExecutionEnvironment,
  CollaborationProject,
} from "../types";
import { ProjectExecutionEnvironments } from "./ProjectExecutionEnvironments";

const repositoryOptions = [
  {
    id: 1,
    name: "wegent",
    fullName: "weibo_rd/common/wecode/wegent",
    cloneUrl:
      "ssh://git@git.example.com:2222/weibo_rd/common/wecode/wegent.git",
    gitDomain: "git.example.com",
    provider: "gitlab",
  },
  {
    id: 2,
    name: "internal-sdk",
    fullName: "weibo_rd/common/internal-sdk",
    cloneUrl: "https://git.example.com/weibo_rd/common/internal-sdk.git",
    gitDomain: "git.example.com",
    provider: "gitlab",
  },
];

function repositoryKey(option: (typeof repositoryOptions)[number]) {
  return `${option.provider}::${option.gitDomain}::${option.fullName}`;
}

const project: CollaborationProject = {
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
  created_at: "2026-09-14T00:00:00Z",
  updated_at: "2026-09-14T00:00:00Z",
};

function environment(
  deviceId: number,
  name: string,
  status: CollaborationExecutionEnvironment["status"],
  deviceKey = `device-${deviceId}`,
): CollaborationExecutionEnvironment {
  return {
    id: `environment-${deviceId}`,
    device_id: deviceId,
    device_key: deviceKey,
    name,
    kind: "local_device",
    coding_tools: ["codex"],
    owner_type: "user",
    owner_id: "1",
    owner_name: "Owner",
    status,
    updated_at: "2026-09-14T00:00:00Z",
  };
}

let root: Root | null = null;
let container: HTMLDivElement | null = null;

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
});

const prefix = "collaboration-project-execution-environment";

function element<T extends HTMLElement>(suffix: string): T {
  const result = container?.querySelector<T>(
    `[data-testid="${prefix}${suffix}"]`,
  );
  if (!result) throw new Error(`Missing element: ${suffix}`);
  return result;
}

async function change(suffix: string, value: string) {
  await act(async () => {
    const control = element<
      HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement
    >(suffix);
    const prototype =
      control instanceof HTMLInputElement
        ? HTMLInputElement.prototype
        : control instanceof HTMLTextAreaElement
          ? HTMLTextAreaElement.prototype
          : HTMLSelectElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, "value")?.set?.call(
      control,
      value,
    );
    control.dispatchEvent(
      new Event(control instanceof HTMLSelectElement ? "change" : "input", {
        bubbles: true,
      }),
    );
  });
}

async function openPicker() {
  await act(async () => element<HTMLButtonElement>("-add").click());
}

function candidateDeviceIds() {
  return [
    ...container!.querySelectorAll<HTMLElement>(
      `[data-testid^="${prefix}-candidate-"]`,
    ),
  ].map((candidate) =>
    candidate.dataset.testid!.slice(`${prefix}-candidate-`.length),
  );
}

async function render({
  assigned = [],
  role = "Owner",
  locale = "zh-CN",
  gitRepositories,
  executionEnvironment,
}: {
  assigned?: CollaborationExecutionEnvironment[];
  role?: CollaborationProject["access_role"];
  locale?: CollaborationLocale;
  gitRepositories?: SharedWorkspaceApi["gitRepositories"];
  executionEnvironment?: CollaborationProject["execution_environment"];
} = {}) {
  const online = environment(21, "Personal online", "online");
  const offline = environment(22, "Personal offline", "offline");
  const shared = environment(23, "Shared online", "online");
  const failed = environment(24, "Shared error", "error");
  const preparing = environment(25, "Shared preparing", "provisioning");
  const available = [online, offline, shared, failed, preparing];
  const api = {
    projects: {
      update: vi.fn(async () => ({
        ...project,
        version: 2,
        execution_environment: {
          repositories: [
            {
              name: "Wegent",
              url: "https://github.com/wecode-ai/Wegent.git",
              ref: "main",
              path: "wegent",
              primary: true,
            },
          ],
          setup_steps: [
            { command: "pnpm install", working_directory: "wegent" },
          ],
          fingerprint: "environment-v1",
          devices: {},
        },
      })),
      initializeExecutionEnvironment: vi.fn(
        async (_projectId: string, input: { deviceId: number }) => {
          // The backend records the entry under the identity of the exact
          // device record that prepared the environment.
          const deviceKey = [...assigned, ...available].find(
            (candidate) => candidate.device_id === input.deviceId,
          )!.device_key!;
          return {
            ...project,
            version: 3,
            execution_environment: {
              repositories: [
                {
                  name: "Wegent",
                  url: "https://github.com/wecode-ai/Wegent.git",
                  ref: "main",
                  path: "wegent",
                  primary: true,
                },
              ],
              setup_steps: [
                { command: "pnpm install", working_directory: "wegent" },
              ],
              fingerprint: "environment-v1",
              devices: {
                [deviceKey]: {
                  status: "ready" as const,
                  workspace_path: "/workspace/project-1",
                  prepared_at: "2026-09-16T00:00:00Z",
                  error: "",
                },
              },
            },
          };
        },
      ),
      listExecutionEnvironments: vi.fn(async () => assigned),
      addExecutionEnvironment: vi.fn(
        async (_projectId: string, deviceId: number) =>
          available.find((environment) => environment.device_id === deviceId)!,
      ),
    },
    resources: {
      list: vi.fn(async () => ({
        agents: [],
        execution_environments: [online, offline, shared],
      })),
    },
    workspaces: {
      listExecutionEnvironments: vi.fn(async () => [shared, failed, preparing]),
    },
    ...(gitRepositories ? { gitRepositories } : {}),
  } as unknown as SharedWorkspaceApi;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(
      <ProjectExecutionEnvironments
        api={api}
        project={{
          ...project,
          access_role: role,
          ...(executionEnvironment
            ? { execution_environment: executionEnvironment }
            : {}),
        }}
        translate={createCollaborationTranslator(locale)}
      />,
    );
  });
  return api;
}

// Re-renders the mounted component with a refreshed project, mirroring the
// workspace controller's 15-second poll delivering new props.
async function rerender(
  api: SharedWorkspaceApi,
  {
    executionEnvironment,
    version = 2,
  }: {
    executionEnvironment?: CollaborationProject["execution_environment"];
    version?: number;
  },
) {
  await act(async () => {
    root?.render(
      <ProjectExecutionEnvironments
        api={api}
        project={{
          ...project,
          version,
          ...(executionEnvironment
            ? { execution_environment: executionEnvironment }
            : {}),
        }}
        translate={createCollaborationTranslator("zh-CN")}
      />,
    );
  });
}

const workspacePrefix = "collaboration-workspace-execution-environment";

async function renderWorkspaceScope({
  location,
  gitRepositories,
}: {
  location: "local" | "cloud";
  gitRepositories?: SharedWorkspaceApi["gitRepositories"];
}) {
  const api = {
    workspaces: {
      listExecutionEnvironments: vi.fn(async () => []),
    },
    resources: {
      list: vi.fn(async () => ({ agents: [], execution_environments: [] })),
    },
    ...(gitRepositories ? { gitRepositories } : {}),
  } as unknown as SharedWorkspaceApi;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(
      <ProjectExecutionEnvironments
        api={api}
        workspace={{
          id: "workspace-1",
          access_role: "Owner",
          version: 1,
          location,
        }}
        translate={createCollaborationTranslator("zh-CN")}
      />,
    );
  });
  return api;
}

function workspaceElement<T extends HTMLElement>(suffix: string): T {
  const result = container?.querySelector<T>(
    `[data-testid="${workspacePrefix}${suffix}"]`,
  );
  if (!result) throw new Error(`Missing element: ${suffix}`);
  return result;
}

describe("ProjectExecutionEnvironments", () => {
  it("saves multiple repositories and ordered setup steps", async () => {
    const api = await render({
      assigned: [environment(21, "Assigned online", "online")],
    });

    await change("-repository-name-0", "Wegent");
    await change(
      "-repository-url-0",
      "https://github.com/wecode-ai/Wegent.git",
    );
    await change("-repository-ref-0", "main");
    await change("-repository-path-0", "wegent");
    await act(async () =>
      element<HTMLButtonElement>("-add-repository").click(),
    );
    await change("-repository-name-1", "SDK");
    await change("-repository-url-1", "https://github.com/example/sdk.git");
    await change("-repository-ref-1", "v2");
    await change("-repository-path-1", "deps/sdk");
    await act(async () =>
      element<HTMLButtonElement>("-add-setup-step").click(),
    );
    await change("-setup-command-0", "pnpm install");
    await change("-setup-directory-0", "wegent");
    await act(async () => element<HTMLButtonElement>("-initialize-21").click());

    expect(api.projects.update).toHaveBeenCalledExactlyOnceWith("project-1", {
      version: 1,
      executionEnvironment: {
        repositories: [
          {
            name: "Wegent",
            url: "https://github.com/wecode-ai/Wegent.git",
            ref: "main",
            path: "wegent",
            primary: true,
          },
          {
            name: "SDK",
            url: "https://github.com/example/sdk.git",
            ref: "v2",
            path: "deps/sdk",
            primary: false,
          },
        ],
        setupSteps: [
          {
            command: "pnpm install",
            workingDirectory: "wegent",
          },
        ],
      },
    });
    expect(
      api.projects.initializeExecutionEnvironment,
    ).toHaveBeenCalledExactlyOnceWith("project-1", {
      deviceId: 21,
      version: 2,
    });
    expect(container?.textContent).toContain("环境已创建");
    expect(element("-21").textContent).toContain("环境已就绪");
    expect(
      container?.querySelector(`[data-testid="${prefix}-config-status"]`),
    ).toBeNull();
  });

  it("blocks environment creation until the primary repository is selected", async () => {
    const api = await render({
      assigned: [environment(21, "Assigned online", "online")],
    });

    // Name and path are filled, but no Git repository is selected — the row
    // is dropped from the payload, so creating must stop with a clear message
    // instead of failing on the device.
    await change("-repository-name-0", "Wegent");
    await change("-repository-path-0", "wegent");
    await act(async () => element<HTMLButtonElement>("-initialize-21").click());

    expect(api.projects.update).not.toHaveBeenCalled();
    expect(api.projects.initializeExecutionEnvironment).not.toHaveBeenCalled();
    expect(
      container?.querySelector(`[data-testid="${prefix}-environment-error"]`)
        ?.textContent,
    ).toContain("请先为主仓库选择 Git 仓库");
  });

  it("summarizes a device-side clone failure and shows it once", async () => {
    const rawError =
      "Failed to prepare execution repositories: git clone failed for " +
      "/home/wegent/.wecode/wegent-executor/workspace/projects/environment-project-1-x/environment/wegent: " +
      "Cloning into '/home/wegent/.wecode/.../wegent'... fatal: could not read " +
      "Username for 'https://git.example.com': terminal prompts disabled";
    const api = await render({
      assigned: [environment(21, "Assigned online", "online")],
    });
    api.projects.initializeExecutionEnvironment.mockImplementationOnce(
      async () => ({
        version: 3,
        execution_environment: {
          repositories: [],
          setup_steps: [],
          fingerprint: "environment-v1",
          devices: {
            "device-21": {
              status: "error" as const,
              workspace_path: "",
              prepared_at: null,
              error: rawError,
            },
          },
        },
      }),
    );
    await change("-repository-name-0", "Wegent");
    await change(
      "-repository-url-0",
      "https://github.com/wecode-ai/Wegent.git",
    );
    await change("-repository-path-0", "wegent");
    await act(async () => element<HTMLButtonElement>("-initialize-21").click());

    const shown = container?.querySelector(
      `[data-testid="${prefix}-environment-error"]`,
    );
    expect(api.projects.initializeExecutionEnvironment).toHaveBeenCalledOnce();
    expect(element("-21").textContent).toContain("环境创建失败");
    expect(shown?.textContent).toBe(
      "Failed to prepare execution repositories: fatal: could not read " +
        "Username for 'https://git.example.com': terminal prompts disabled",
    );
    expect(shown?.getAttribute("title")).toBe(rawError);
    expect(
      container?.querySelector(`[data-testid="${prefix}s-error"]`),
    ).toBeNull();
  });

  it("shows environment configuration before runtime devices", async () => {
    await render({
      assigned: [environment(21, "Assigned online", "online")],
    });

    const repository = element("-repository-url-0");
    const configuredEnvironment = element("-21");
    const addButton = element<HTMLButtonElement>("-add");

    expect(
      repository.compareDocumentPosition(addButton) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(addButton.textContent).toContain("＋ 添加设备");
    expect(
      addButton.compareDocumentPosition(configuredEnvironment) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(element("-21").textContent).toContain("尚未创建环境");
    expect(element<HTMLButtonElement>("-initialize-21").textContent).toContain(
      "创建环境",
    );
    expect(
      container?.querySelector(`[data-testid="${prefix}-select"]`),
    ).toBeNull();
  });

  it("labels all device statuses and deduplicates personal and shared resources", async () => {
    await render();
    await openPicker();

    expect(candidateDeviceIds()).toEqual(["21", "23"]);
    expect(element("-picker").textContent).toContain(
      "Personal online本地设备 · 在线 · 我的资源",
    );
    expect(element("-picker").textContent).not.toContain("Personal offline");
    expect(element("-picker").textContent).not.toContain("Shared preparing");
  });

  it("keeps online candidates available while filtering the configured pool", async () => {
    await render({
      assigned: [
        environment(22, "Assigned offline", "offline"),
        environment(24, "Assigned error", "error"),
      ],
    });
    await openPicker();

    await change("-status-filter", "offline");

    expect(element("-22").textContent).toContain("Assigned offline");
    expect(container?.querySelector(`[data-testid="${prefix}-24"]`)).toBeNull();
    expect(candidateDeviceIds()).toEqual(["21", "23"]);

    await change("-status-filter", "error");
    expect(element("-24").textContent).toContain("Assigned error");
    expect(candidateDeviceIds()).toEqual(["21", "23"]);
  });

  it("adds the selected online device to the project authorization pool", async () => {
    const api = await render();
    await openPicker();
    await act(async () => element<HTMLButtonElement>("-candidate-21").click());

    expect(
      api.projects.addExecutionEnvironment,
    ).toHaveBeenCalledExactlyOnceWith("project-1", 21);
    expect(element("-21").textContent).toContain("Personal online");
    expect(element("-21").textContent).toContain("在线");
    expect(
      container?.querySelector(`[data-testid="${prefix}-picker"]`),
    ).toBeNull();
  });

  it("lets read-only members filter assigned devices without management controls", async () => {
    await render({
      role: "Reporter",
      assigned: [
        environment(21, "Assigned online", "online"),
        environment(22, "Assigned offline", "offline"),
        environment(24, "Assigned error", "error"),
      ],
    });
    expect(element("-24").textContent).toContain("异常");
    expect(
      container?.querySelector(`[data-testid="${prefix}-add"]`),
    ).toBeNull();
    expect(
      container?.querySelector(`[data-testid^="${prefix}-remove-"]`),
    ).toBeNull();
    await change("-status-filter", "online");
    expect(element("-21").textContent).toContain("Assigned online");
    expect(container?.querySelector(`[data-testid="${prefix}-22"]`)).toBeNull();

    await change("-status-filter", "all");
    expect(element("-22").textContent).toContain("Assigned offline");
  });

  it("marks only the Wework installation that prepared the environment", async () => {
    // Every Wework desktop registers under the logical id "local-device", so
    // the ready badge must follow the per-record identity instead.
    const api = await render({
      assigned: [
        environment(1748, "Wework laptop", "online", "app-record-1748"),
        environment(1824, "Wework desktop", "online", "app-record-1824"),
      ],
    });

    await change("-repository-name-0", "Wegent");
    await change(
      "-repository-url-0",
      "https://github.com/wecode-ai/Wegent.git",
    );
    await change("-repository-path-0", "wegent");
    await act(async () =>
      element<HTMLButtonElement>("-initialize-1824").click(),
    );

    expect(
      api.projects.initializeExecutionEnvironment,
    ).toHaveBeenCalledExactlyOnceWith("project-1", {
      deviceId: 1824,
      version: 2,
    });
    expect(element("-1824").textContent).toContain("环境已就绪");
    expect(element("-1748").textContent).toContain("尚未创建环境");
  });

  it("keeps the prepared device ready while another device initializes", async () => {
    const pending = new Promise<never>(() => {});
    const api = await render({
      assigned: [
        environment(1748, "Wework laptop", "online", "app-record-1748"),
        environment(1824, "Wework desktop", "online", "app-record-1824"),
      ],
      executionEnvironment: {
        repositories: [],
        setup_steps: [],
        fingerprint: "environment-v1",
        devices: {
          "app-record-1748": {
            status: "ready",
            workspace_path: "/workspace/project-1",
            prepared_at: "2026-09-16T00:00:00Z",
            error: "",
          },
        },
      },
    });
    api.projects.initializeExecutionEnvironment.mockImplementationOnce(
      () => pending,
    );
    await change("-repository-name-0", "Wegent");
    await change(
      "-repository-url-0",
      "https://github.com/wecode-ai/Wegent.git",
    );
    await change("-repository-path-0", "wegent");
    await act(async () =>
      element<HTMLButtonElement>("-initialize-1824").click(),
    );

    expect(element("-1824").textContent).toContain("正在创建环境");
    expect(element("-1748").textContent).toContain("环境已就绪");
    expect(element("-1748").textContent).not.toContain("正在创建环境");
  });

  it("renders each device's own persisted state independently", async () => {
    await render({
      assigned: [
        environment(1748, "Wework laptop", "online", "app-record-1748"),
        environment(1824, "Wework desktop", "online", "app-record-1824"),
        environment(21, "Assigned online", "online"),
      ],
      executionEnvironment: {
        repositories: [],
        setup_steps: [],
        fingerprint: "environment-v1",
        devices: {
          "app-record-1748": {
            status: "ready",
            workspace_path: "/workspace/project-1",
            prepared_at: "2026-09-16T00:00:00Z",
            error: "",
          },
          "app-record-1824": {
            status: "error",
            workspace_path: "",
            prepared_at: null,
            error: "clone failed",
          },
        },
      },
    });

    expect(element("-1748").textContent).toContain("环境已就绪");
    expect(element<HTMLButtonElement>("-initialize-1748").textContent).toContain(
      "重新创建",
    );
    expect(element("-1824").textContent).toContain("环境创建失败");
    expect(element<HTMLButtonElement>("-initialize-1824").textContent).toContain(
      "重新创建",
    );
    expect(element("-21").textContent).toContain("尚未创建环境");
    expect(element<HTMLButtonElement>("-initialize-21").textContent).toContain(
      "创建环境",
    );
  });

  it("refreshes every device row when the project prop poll delivers new state", async () => {
    const api = await render({
      assigned: [
        environment(1748, "Wework laptop", "online", "app-record-1748"),
        environment(1824, "Wework desktop", "online", "app-record-1824"),
      ],
      executionEnvironment: {
        repositories: [],
        setup_steps: [],
        fingerprint: "environment-v1",
        devices: {
          "app-record-1748": {
            status: "ready",
            workspace_path: "/workspace/project-1",
            prepared_at: "2026-09-16T00:00:00Z",
            error: "",
          },
        },
      },
    });

    expect(element("-1748").textContent).toContain("环境已就绪");
    expect(element("-1824").textContent).toContain("尚未创建环境");

    await rerender(api, {
      version: 3,
      executionEnvironment: {
        repositories: [],
        setup_steps: [],
        fingerprint: "environment-v1",
        devices: {
          "app-record-1748": {
            status: "ready",
            workspace_path: "/workspace/project-1",
            prepared_at: "2026-09-16T00:00:00Z",
            error: "",
          },
          "app-record-1824": {
            status: "ready",
            workspace_path: "/workspace/project-1-b",
            prepared_at: "2026-09-16T01:00:00Z",
            error: "",
          },
        },
      },
    });

    expect(element("-1748").textContent).toContain("环境已就绪");
    expect(element("-1824").textContent).toContain("环境已就绪");
  });

  it("issues a single initialization for rapid clicks in the same tick", async () => {
    // React state guards are async: two clicks before a re-render both see
    // `saving === false`, so the component must reject the second attempt
    // synchronously — including a click on another device's button, because
    // the project-level config save cannot run concurrently either.
    const pending = new Promise<never>(() => {});
    const api = await render({
      assigned: [
        environment(1748, "Wework laptop", "online", "app-record-1748"),
        environment(1824, "Wework desktop", "online", "app-record-1824"),
      ],
    });
    api.projects.update.mockImplementationOnce(() => pending);
    await change("-repository-name-0", "Wegent");
    await change(
      "-repository-url-0",
      "https://github.com/wecode-ai/Wegent.git",
    );
    await change("-repository-path-0", "wegent");
    await act(async () => {
      element<HTMLButtonElement>("-initialize-1748").click();
      element<HTMLButtonElement>("-initialize-1748").click();
      element<HTMLButtonElement>("-initialize-1824").click();
    });

    expect(api.projects.update).toHaveBeenCalledOnce();
    expect(api.projects.initializeExecutionEnvironment).not.toHaveBeenCalled();
    expect(element("-1748").textContent).toContain("正在创建环境");
  });

  it("localizes status labels and filters in English", async () => {
    await render({
      locale: "en",
      assigned: [
        environment(22, "Assigned offline", "offline"),
        environment(24, "Assigned error", "error"),
      ],
    });
    await openPicker();
    expect(element("-picker").textContent).toContain(
      "Personal onlineLocal device · Online · My resources",
    );
    expect(element("-picker").textContent).not.toContain("Personal offline");
    expect(
      [...element<HTMLSelectElement>("-status-filter").options].map(
        (option) => option.textContent,
      ),
    ).toEqual(["All", "Online", "Offline", "Preparing", "Error"]);
  });

  it("derives name and directory from the selected repository and submits the chosen branch", async () => {
    const listBranches = vi.fn(async () => [
      { name: "develop", default: false },
      { name: "main", default: true },
    ]);
    const api = await render({
      assigned: [environment(21, "Assigned online", "online")],
      gitRepositories: {
        list: vi.fn(async () => repositoryOptions),
        listBranches,
      },
    });

    await change("-repository-url-0", repositoryKey(repositoryOptions[0]));

    expect(element<HTMLInputElement>("-repository-name-0").value).toBe(
      "wegent",
    );
    expect(element<HTMLInputElement>("-repository-path-0").value).toBe(
      "wegent",
    );
    expect(listBranches).toHaveBeenCalledWith(repositoryOptions[0]);
    // The provider's default branch is preselected.
    expect(element<HTMLSelectElement>("-repository-ref-0").value).toBe("main");

    // A customized name survives switching repositories while the derived
    // directory follows the new repository.
    await change("-repository-name-0", "Custom name");
    await change("-repository-url-0", repositoryKey(repositoryOptions[1]));
    expect(element<HTMLInputElement>("-repository-name-0").value).toBe(
      "Custom name",
    );
    expect(element<HTMLInputElement>("-repository-path-0").value).toBe(
      "internal-sdk",
    );

    await change("-repository-ref-0", "develop");
    await act(async () => element<HTMLButtonElement>("-initialize-21").click());

    expect(api.projects.update).toHaveBeenCalledExactlyOnceWith("project-1", {
      version: 1,
      executionEnvironment: {
        repositories: [
          {
            name: "Custom name",
            url: "https://git.example.com/weibo_rd/common/internal-sdk.git",
            ref: "develop",
            path: "internal-sdk",
            primary: true,
          },
        ],
        setupSteps: [],
      },
    });
  });

  it("keeps free-text entry and offers a retry when the repository catalog fails to load", async () => {
    const list = vi.fn(async () => {
      throw new Error("catalog unavailable");
    });
    await render({
      gitRepositories: { list, listBranches: vi.fn() },
    });

    expect(container?.textContent).toContain("仓库列表加载失败");
    expect(element("-repository-url-0")).toBeInstanceOf(HTMLInputElement);
    expect(element("-repository-ref-0")).toBeInstanceOf(HTMLInputElement);

    list.mockImplementation(async () => repositoryOptions);
    await act(async () =>
      element<HTMLButtonElement>("-repositories-retry").click(),
    );

    expect(container?.textContent).not.toContain("仓库列表加载失败");
    expect(element("-repository-url-0")).toBeInstanceOf(HTMLSelectElement);
  });

  it("keeps a saved repository that is outside the catalog editable", async () => {
    await render({
      gitRepositories: {
        list: vi.fn(async () => repositoryOptions),
        listBranches: vi.fn(async () => [{ name: "main", default: true }]),
      },
      executionEnvironment: {
        repositories: [
          {
            name: "Wegent",
            url: "https://other.example.com/custom/wegent.git",
            ref: "release",
            path: "wegent",
            primary: true,
          },
        ],
        setup_steps: [],
      },
    });

    const urlControl = element<HTMLSelectElement>("-repository-url-0");
    expect(urlControl).toBeInstanceOf(HTMLSelectElement);
    expect(urlControl.value).toBe("__custom_repository__");
    expect(urlControl.selectedOptions[0]?.textContent).toBe(
      "https://other.example.com/custom/wegent.git",
    );
    // Without a catalog match the ref stays a free-text field.
    expect(element<HTMLInputElement>("-repository-ref-0").value).toBe(
      "release",
    );
  });

  it("renders repository dropdowns for a cloud workspace", async () => {
    const list = vi.fn(async () => repositoryOptions);
    await renderWorkspaceScope({
      location: "cloud",
      gitRepositories: { list, listBranches: vi.fn(async () => []) },
    });

    expect(list).toHaveBeenCalledOnce();
    expect(workspaceElement("-repository-url-0")).toBeInstanceOf(
      HTMLSelectElement,
    );
  });

  it("keeps free-text inputs for a local workspace without fetching the catalog", async () => {
    const list = vi.fn(async () => repositoryOptions);
    await renderWorkspaceScope({
      location: "local",
      gitRepositories: { list, listBranches: vi.fn() },
    });

    expect(list).not.toHaveBeenCalled();
    expect(workspaceElement("-repository-url-0")).toBeInstanceOf(
      HTMLInputElement,
    );
    expect(workspaceElement("-repository-ref-0")).toBeInstanceOf(
      HTMLInputElement,
    );
  });

  it("follows the refreshed project prop when the environment becomes ready", async () => {
    const api = await render({
      assigned: [environment(21, "Assigned online", "online")],
    });

    expect(element("-21").textContent).toContain("尚未创建环境");

    await rerender(api, {
      executionEnvironment: {
        repositories: [],
        setup_steps: [],
        fingerprint: "environment-v1",
        devices: {
          "device-21": {
            status: "ready",
            workspace_path: "/workspace/project-1",
            prepared_at: "2026-09-16T00:00:00Z",
            error: "",
          },
        },
      },
    });

    expect(element("-21").textContent).toContain("环境已就绪");
    expect(element<HTMLButtonElement>("-initialize-21").textContent).toContain(
      "重新创建",
    );
  });

  it("does not clobber in-progress form edits when the project prop refreshes", async () => {
    const api = await render({
      assigned: [environment(21, "Assigned online", "online")],
    });

    await change("-repository-name-0", "Draft name");

    await rerender(api, {
      executionEnvironment: {
        repositories: [
          {
            name: "Server name",
            url: "https://github.com/wecode-ai/Wegent.git",
            ref: "main",
            path: "wegent",
            primary: true,
          },
        ],
        setup_steps: [{ command: "pnpm install", working_directory: "wegent" }],
        fingerprint: "environment-v2",
        devices: {
          "device-21": {
            status: "ready",
            workspace_path: "/workspace/project-1",
            prepared_at: "2026-09-16T00:00:00Z",
            error: "",
          },
        },
      },
    });

    // Server-owned fields follow the prop, but the typed draft survives.
    expect(element("-21").textContent).toContain("环境已就绪");
    expect(element<HTMLInputElement>("-repository-name-0").value).toBe(
      "Draft name",
    );
    expect(element<HTMLInputElement>("-repository-url-0").value).toBe("");
    expect(
      container?.querySelector(`[data-testid="${prefix}-setup-command-0"]`),
    ).toBeNull();
  });

  it("ignores prop refreshes while an initialization is in flight", async () => {
    const pending = new Promise<never>(() => {});
    const api = await render({
      assigned: [
        environment(1748, "Wework laptop", "online", "app-record-1748"),
        environment(1824, "Wework desktop", "online", "app-record-1824"),
      ],
    });
    api.projects.initializeExecutionEnvironment.mockImplementationOnce(
      () => pending,
    );
    await change("-repository-name-0", "Wegent");
    await change(
      "-repository-url-0",
      "https://github.com/wecode-ai/Wegent.git",
    );
    await change("-repository-path-0", "wegent");
    await act(async () =>
      element<HTMLButtonElement>("-initialize-1824").click(),
    );
    expect(element("-1824").textContent).toContain("正在创建环境");

    // A racing poll arrives while the create owns the status fields; it must
    // not flip the other device to ready or replace the in-flight state.
    await rerender(api, {
      version: 4,
      executionEnvironment: {
        repositories: [],
        setup_steps: [],
        fingerprint: "environment-v1",
        devices: {
          "app-record-1748": {
            status: "ready",
            workspace_path: "/workspace/project-1",
            prepared_at: "2026-09-16T00:00:00Z",
            error: "",
          },
        },
      },
    });

    expect(element("-1824").textContent).toContain("正在创建环境");
    expect(element("-1748").textContent).toContain("尚未创建环境");
  });
});
