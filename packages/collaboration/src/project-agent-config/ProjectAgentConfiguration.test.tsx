// @vitest-environment jsdom

// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type {
  SharedWorkspaceApi,
  WorkspaceProjectAgent,
} from "../ports/SharedWorkspaceApi";
import type {
  CollaborationExecutionEnvironment,
  CollaborationOwnedAgent,
  CollaborationProject,
} from "../types";
import { ProjectAgentConfiguration } from "./ProjectAgentConfiguration";

const project: CollaborationProject = {
  id: "8869148083931743937",
  workspace_id: "workspace-1",
  public_id: "project-public-1",
  project_key: "RD",
  name: "研发项目",
  description: "",
  project_store: "backend",
  task_provider: "local",
  provider_config: {},
  created_by_user_id: 1,
  status: "active",
  tags: [],
  version: 1,
  created_at: "2026-09-12T00:00:00Z",
  updated_at: "2026-09-12T00:00:00Z",
};

const workspaceAgent: CollaborationOwnedAgent = {
  id: "workspace-agent-1",
  name: "研发团队",
  team_id: 12,
  owner_type: "workspace",
  owner_id: "workspace-1",
  owner_name: "研发空间",
  status: "available",
  execution_environment_ids: [],
  workspace_ids: ["workspace-1"],
};

const environment: CollaborationExecutionEnvironment = {
  id: "environment-1",
  device_id: 22,
  device_key: "device-macbook",
  name: "MacBook Pro",
  kind: "local_device",
  owner_type: "user",
  owner_id: "7",
  owner_name: "李明",
  status: "online",
  workspace_ids: ["workspace-1"],
  updated_at: "2026-09-12T00:00:00Z",
};

function projectAgent(
  values: Partial<WorkspaceProjectAgent> = {},
): WorkspaceProjectAgent {
  return {
    id: "project-agent-1",
    name: "已有智能体",
    runtime: "wegent",
    status: "active",
    version: 1,
    ...values,
  };
}

function createApi(options?: {
  agents?: WorkspaceProjectAgent[];
  workspaceAgents?: CollaborationOwnedAgent[];
  environments?: CollaborationExecutionEnvironment[];
}) {
  const create = vi.fn(async (_projectId, input: Record<string, unknown>) =>
    projectAgent({
      id: input.runtime === "wegent" ? "created-wegent" : "created-codex",
      name: String(input.name),
      ...input,
    }),
  );
  const update = vi.fn(async (_projectId, agentId) =>
    projectAgent({ id: agentId, status: "archived", version: 2 }),
  );
  const api = {
    agents: {
      list: vi.fn(async () => options?.agents ?? [projectAgent()]),
      create,
      update,
    },
    workspaces: {
      listAgents: vi.fn(
        async () => options?.workspaceAgents ?? [workspaceAgent],
      ),
      listExecutionEnvironments: vi.fn(
        async () => options?.environments ?? [environment],
      ),
    },
  } as unknown as SharedWorkspaceApi;
  return { api, create, update };
}

function element(testId: string): HTMLElement {
  const found = document.querySelector(`[data-testid="${testId}"]`);
  if (!(found instanceof HTMLElement)) {
    throw new Error(`Missing ${testId}`);
  }
  return found;
}

async function click(testId: string) {
  await act(async () => {
    element(testId).click();
  });
}

async function change(testId: string, value: string) {
  const target = element(testId) as HTMLInputElement | HTMLSelectElement;
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(
      Object.getPrototypeOf(target),
      "value",
    )?.set;
    setter?.call(target, value);
    target.dispatchEvent(new Event("change", { bubbles: true }));
    target.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

describe("ProjectAgentConfiguration", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  async function render(api: SharedWorkspaceApi, target = project) {
    await act(async () => {
      root.render(
        <ProjectAgentConfiguration
          api={api}
          project={target}
          onError={vi.fn()}
          translate={(_key, fallback) => fallback}
        />,
      );
    });
  }

  it("creates managed Wegent and custom Codex agents through the shared API", async () => {
    const { api, create } = createApi();
    await render(api);

    await change("project-agent-wegent-team", "12");
    await click("project-agent-wegent-create");
    expect(create).toHaveBeenNthCalledWith(1, project.id, {
      name: "研发团队",
      runtime: "wegent",
      wegentTeamId: 12,
    });
    expect(element("project-agent-row-created-wegent")).toBeTruthy();

    await click("project-agent-mode-codex");
    await change("project-agent-codex-name", "Codex 产品工程师");
    await change("project-agent-codex-capability", "实现产品需求");
    await change("project-agent-codex-prompt", "遵循项目规范");
    await change("project-agent-codex-environment", environment.id);
    await click("project-agent-codex-create");

    expect(create).toHaveBeenNthCalledWith(2, project.id, {
      name: "Codex 产品工程师",
      runtime: "codex",
      capabilityDescription: "实现产品需求",
      systemPrompt: "遵循项目规范",
      executionDeviceId: "device-macbook",
      executionEnvironment: "local",
      workspaceBinding: {
        type: "backend_project",
        projectId: project.id,
      },
    });
    expect(element("project-agent-row-created-codex")).toBeTruthy();
  });

  it("archives an existing project agent with optimistic concurrency", async () => {
    const { api, update } = createApi();
    await render(api);

    await click("project-agent-archive-project-agent-1");

    expect(update).toHaveBeenCalledWith(project.id, "project-agent-1", {
      version: 1,
      status: "archived",
    });
    expect(
      document.querySelector(
        '[data-testid="project-agent-row-project-agent-1"]',
      ),
    ).toBeNull();
  });

  it("shows actionable empty states for missing workspace resources", async () => {
    const { api } = createApi({ workspaceAgents: [], environments: [] });
    await render(api);
    expect(element("project-agent-wegent-empty").textContent).toContain(
      "Workspace",
    );

    await click("project-agent-mode-codex");
    expect(
      element("project-agent-codex-environment-empty").textContent,
    ).toContain("执行环境");

    await render(api, { ...project, workspace_id: null });
    expect(
      element("project-agent-config-missing-workspace").textContent,
    ).toContain("Workspace");
  });

  it("translates execution environment kind and status labels", async () => {
    const { api } = createApi();
    await act(async () => {
      root.render(
        <ProjectAgentConfiguration
          api={api}
          project={project}
          onError={vi.fn()}
          translate={(key, fallback) => {
            const translated: Record<string, string> = {
              "todo.local_execution_environment": "LOCALIZED LOCAL",
              "todo.execution_environment_online": "LOCALIZED ONLINE",
            };
            return translated[key] ?? fallback;
          }}
        />,
      );
    });

    await click("project-agent-mode-codex");
    expect(element("project-agent-codex-environment").textContent).toContain(
      "MacBook Pro · LOCALIZED LOCAL · LOCALIZED ONLINE",
    );
  });
});
