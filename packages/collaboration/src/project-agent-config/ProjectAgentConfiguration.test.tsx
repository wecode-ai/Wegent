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
import type { CollaborationOwnedAgent, CollaborationProject } from "../types";
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
    projects: {},
    resources: {
      list: vi.fn(async () => ({
        agents: [],
        execution_environments: [],
      })),
    },
    agents: {
      list: vi.fn(async () => options?.agents ?? [projectAgent()]),
      create,
      update,
    },
    workspaces: {
      listAgents: vi.fn(
        async () => options?.workspaceAgents ?? [workspaceAgent],
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

  it("adds an existing Agent and opens the standard Agent creator", async () => {
    const { api, create } = createApi();
    const onCreateAgent = vi.fn();
    await act(async () => {
      root.render(
        <ProjectAgentConfiguration
          api={api}
          project={project}
          onError={vi.fn()}
          onCreateAgent={onCreateAgent}
          translate={(_key, fallback) => fallback}
        />,
      );
    });

    await click("project-agent-add");
    await change("project-agent-wegent-team", "12");
    await click("project-agent-wegent-create");
    expect(create).toHaveBeenNthCalledWith(1, project.id, {
      name: "研发团队",
      runtime: "wegent",
      wegentTeamId: 12,
    });
    expect(element("project-agent-row-created-wegent")).toBeTruthy();

    await click("project-agent-add");
    await click("project-agent-mode-create");
    expect(
      document.querySelector('[data-testid="project-agent-codex-name"]'),
    ).toBeNull();
    await click("project-agent-open-create");
    expect(onCreateAgent).toHaveBeenCalledOnce();
    expect(create).toHaveBeenCalledTimes(1);
  });

  it("creates a local Agent inside a local project without choosing an environment", async () => {
    const { api, create } = createApi({ workspaceAgents: [] });
    await act(async () => {
      root.render(
        <ProjectAgentConfiguration
          api={api}
          project={{ ...project, project_store: "local" }}
          onError={vi.fn()}
          translate={(_key, fallback) => fallback}
        />,
      );
    });

    await click("project-agent-add");
    await click("project-agent-mode-create");
    await change("project-agent-local-name", "本地代码评审");
    await change("project-agent-local-capability", "评审当前项目代码");
    await change("project-agent-local-system-prompt", "先检查测试，再给出结论");
    await click("project-agent-local-create");

    expect(create).toHaveBeenCalledWith(project.id, {
      name: "本地代码评审",
      runtime: "codex",
      capabilityDescription: "评审当前项目代码",
      systemPrompt: "先检查测试，再给出结论",
    });
    expect(
      document.querySelector('[data-testid="project-agent-dialog"]'),
    ).toBeNull();
    expect(element("project-agent-row-created-codex")).toBeTruthy();
    expect(
      document.querySelector('[data-testid*="execution-environment"]'),
    ).toBeNull();
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

  it("keeps project Agent management available without workspace resources", async () => {
    const { api } = createApi({ workspaceAgents: [] });
    await render(api);
    await click("project-agent-add");
    expect(element("project-agent-wegent-empty").textContent).toContain(
      "智能体",
    );

    await click("project-agent-mode-create");
    expect(element("project-agent-open-create")).toBeTruthy();

    await render(api, { ...project, workspace_id: null });
    expect(element("project-agent-config")).toBeTruthy();
  });

  it("keeps creation separate from the configured Agent list", async () => {
    const { api } = createApi();
    await render(api);

    expect(
      document.querySelector('[data-testid="project-agent-dialog"]'),
    ).toBeNull();
    expect(element("project-agent-list")).toBeTruthy();

    await click("project-agent-add");
    expect(element("project-agent-dialog")).toBeTruthy();

    await click("project-agent-dialog-close");
    expect(
      document.querySelector('[data-testid="project-agent-dialog"]'),
    ).toBeNull();
    expect(element("project-agent-list")).toBeTruthy();
  });
});
