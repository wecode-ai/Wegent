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
): CollaborationExecutionEnvironment {
  return {
    id: `environment-${deviceId}`,
    device_id: deviceId,
    device_key: `device-${deviceId}`,
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
}: {
  assigned?: CollaborationExecutionEnvironment[];
  role?: CollaborationProject["access_role"];
  locale?: CollaborationLocale;
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
          status: "preparing",
        },
      })),
      initializeExecutionEnvironment: vi.fn(async () => ({
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
          status: "ready",
          fingerprint: "environment-v1",
          prepared_device_id: "device-21",
          prepared_workspace_path: "/workspace/project-1",
        },
      })),
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
  } as unknown as SharedWorkspaceApi;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(
      <ProjectExecutionEnvironments
        api={api}
        project={{ ...project, access_role: role }}
        translate={createCollaborationTranslator(locale)}
      />,
    );
  });
  return api;
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
});
