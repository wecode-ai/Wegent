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
import type { ProjectAgentConfigurationHost } from "./types";

const project: CollaborationProject = {
  id: "8869148083931743937",
  workspace_id: "workspace-1",
  workspace_access_role: "Owner",
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
    wegent_team_id: 12,
    status: "active",
    version: 1,
    can_edit: true,
    ...values,
  };
}

function createApi(options?: {
  agents?: WorkspaceProjectAgent[];
  resourceAgents?: CollaborationOwnedAgent[];
  workspaceAgents?: CollaborationOwnedAgent[];
}) {
  const rows = [...(options?.agents ?? [projectAgent()])];
  const list = vi.fn(async () => rows);
  const create = vi.fn(async (_projectId, input: Record<string, unknown>) =>
    projectAgent({
      id: input.runtime === "wegent" ? "created-wegent" : "created-codex",
      name: String(input.name),
      ...input,
    }),
  );
  const update = vi.fn(
    async (_projectId, agentId, input: Record<string, unknown>) => {
      const index = rows.findIndex((row) => row.id === agentId);
      const next = projectAgent({ ...rows[index], ...input, version: 2 });
      if (index >= 0) rows[index] = next;
      return next;
    },
  );
  const api = {
    projects: {},
    resources: {
      list: vi.fn(async () => ({
        agents: options?.resourceAgents ?? [],
        execution_environments: [],
      })),
    },
    agents: {
      list,
      create,
      update,
    },
    automationExecutionCatalog: {
      load: vi.fn(async () => ({
        environments: [],
        models: [
          {
            name: "desktop-e2e-responses-model",
            label: "Desktop E2E Responses",
            type: "runtime",
            options: { providerProfileId: "desktop-e2e-responses" },
          },
        ],
        plugins: [],
      })),
      loadPlugins: vi.fn(async () => []),
    },
    workspaces: {
      listAgents: vi.fn(
        async () => options?.workspaceAgents ?? [workspaceAgent],
      ),
    },
  } as unknown as SharedWorkspaceApi;
  return { api, create, list, update };
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

const hostedCreationHost: ProjectAgentConfigurationHost = {
  supportsExistingAgentSelection: false,
  renderAgentCreator({ namespace, onCreated, workspaceName }) {
    return (
      <button
        data-testid="hosted-agent-create"
        data-namespace={namespace}
        data-workspace-name={workspaceName}
        onClick={() => void onCreated({ name: "空间新智能体", teamId: 91 })}
        type="button"
      >
        创建
      </button>
    );
  },
  renderLocalAgentCreator({ onCreated, projectId }) {
    return (
      <button
        data-project-id={projectId}
        data-testid="hosted-local-agent-create"
        onClick={() => void onCreated()}
        type="button"
      >
        创建本地智能体
      </button>
    );
  },
  renderLocalAgentEditor({ onClose, onSaved, projectId, resourceId }) {
    return (
      <div
        data-project-id={projectId}
        data-resource-id={resourceId}
        data-testid="hosted-local-agent-editor"
      >
        <button
          data-testid="hosted-local-agent-save"
          onClick={() => void onSaved()}
          type="button"
        >
          保存
        </button>
        <button onClick={onClose} type="button">
          关闭
        </button>
      </div>
    );
  },
  renderAgentEditor({ agent, namespace, onClose, onSaved, workspaceName }) {
    return (
      <div data-testid="hosted-agent-editor">
        <button
          data-testid="hosted-agent-save"
          data-namespace={namespace}
          data-team-id={agent.teamId}
          data-workspace-name={workspaceName}
          onClick={() =>
            void onSaved({ name: "重命名智能体", teamId: agent.teamId })
          }
          type="button"
        >
          保存
        </button>
        <button
          data-testid="hosted-agent-editor-close"
          onClick={onClose}
          type="button"
        >
          关闭
        </button>
      </div>
    );
  },
  renderDialog({ children, testIds }) {
    return <div data-testid={testIds.dialog}>{children}</div>;
  },
};

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

  it("shows a retryable list failure without claiming the catalog is empty", async () => {
    const { api, list } = createApi();
    list.mockRejectedValueOnce(new Error("Agent service unavailable"));
    await render(api);
    expect(container.textContent).toContain("Agent service unavailable");
    expect(
      container.querySelector('[data-testid="project-agent-list"]'),
    ).toBeNull();
    expect(
      container.querySelector('[data-testid="project-agent-config-empty"]'),
    ).toBeNull();
    await click("project-agent-config-retry");
    expect(
      container.querySelector('[data-testid="project-agent-list"]'),
    ).not.toBeNull();
    expect(
      container.querySelector('[data-testid="project-agent-config-error"]'),
    ).toBeNull();
    expect(api.resources!.list).not.toHaveBeenCalled();
  });

  async function renderHosted(
    api: SharedWorkspaceApi,
    options: {
      onAgentsChange?(): void;
      scope?: "project" | "workspace";
      target?: CollaborationProject;
    } = {},
  ) {
    await act(async () => {
      root.render(
        <ProjectAgentConfiguration
          api={api}
          host={hostedCreationHost}
          project={options.target ?? project}
          resourceContext={{
            name: "研发空间",
            namespace: "engineering",
          }}
          onAgentsChange={options.onAgentsChange}
          onError={vi.fn()}
          scope={options.scope}
          translate={(_key, fallback) => fallback}
        />,
      );
    });
  }

  it("keeps the project list visible when the deferred candidate catalog fails", async () => {
    const { api } = createApi();
    api.resources!.list = vi
      .fn()
      .mockRejectedValue(new Error("Catalog unavailable"));
    await render(api);
    expect(element("project-agent-row-project-agent-1")).toBeTruthy();
    expect(api.resources!.list).not.toHaveBeenCalled();
    await click("project-agent-add");
    expect(element("project-agent-candidates-error").textContent).toContain(
      "Catalog unavailable",
    );
    expect(element("project-agent-row-project-agent-1")).toBeTruthy();
    api.resources!.list = vi
      .fn()
      .mockResolvedValue({ agents: [], execution_environments: [] });
    await click("project-agent-candidates-retry");
    expect(
      document.querySelector('[data-testid="project-agent-candidates-error"]'),
    ).toBeNull();
  });

  it("separates a shared Agent source from its executor type", async () => {
    const { api } = createApi();
    await render(api);

    const text = element("project-agent-row-project-agent-1").textContent ?? "";
    expect(text).toContain("执行器由智能体定义");
    expect(text).toContain("共享智能体");
    expect(text).not.toContain("Wegent");
  });

  it("shows project bindings to a guest without loading Space source catalogs", async () => {
    const { api, list } = createApi();
    await render(api, { ...project, workspace_access_role: null });

    expect(list).toHaveBeenCalledWith(project.id, { includeArchived: true });
    expect(element("project-agent-row-project-agent-1").textContent).toContain(
      "已有智能体",
    );
    expect(api.workspaces!.listAgents).not.toHaveBeenCalled();
    expect(api.resources!.list).not.toHaveBeenCalled();
    expect(
      document.querySelector('[data-testid="project-agent-add"]'),
    ).toBeNull();
  });

  it("checks actual space membership when v1 project responses omit permission sources", async () => {
    const { api } = createApi();
    api.workspaces!.list = vi.fn(
      async () =>
        [{ id: project.workspace_id, access_role: "Maintainer" }] as never,
    );
    await render(api, { ...project, workspace_access_role: undefined });
    expect(api.workspaces!.list).toHaveBeenCalledOnce();
    expect(api.workspaces!.listAgents).not.toHaveBeenCalled();
    expect(api.resources!.list).not.toHaveBeenCalled();
    await click("project-agent-add");
    expect(api.workspaces!.listAgents).toHaveBeenCalledWith(
      project.workspace_id,
    );
    expect(element("project-agent-add")).toBeTruthy();
  });

  it("keeps a v1 project guest out of the space catalog", async () => {
    const { api } = createApi();
    api.workspaces!.list = vi.fn(async () => []);
    await render(api, { ...project, workspace_access_role: undefined });
    expect(api.workspaces!.listAgents).not.toHaveBeenCalled();
    expect(api.resources!.list).not.toHaveBeenCalled();
    expect(element("project-agent-row-project-agent-1")).toBeTruthy();
  });

  it("adds an existing Agent without exposing a duplicate inline creator", async () => {
    const { api, create } = createApi({ agents: [] });
    await render(api);

    await click("project-agent-add");
    await click("project-agent-option-12");
    await click("project-agent-wegent-create");
    expect(create).toHaveBeenNthCalledWith(1, project.id, {
      name: "研发团队",
      runtime: "wegent",
      wegentTeamId: 12,
      shareWithWorkspace: true,
    });
    expect(element("project-agent-row-created-wegent")).toBeTruthy();

    await click("project-agent-add");
    expect(
      document.querySelector('[data-testid="project-agent-mode-create"]'),
    ).toBeNull();
    expect(
      document.querySelector(
        '[data-testid="project-agent-standard-create-form"]',
      ),
    ).toBeNull();
    expect(create).toHaveBeenCalledTimes(1);
  });

  it("opens and consumes a host-requested add action once", async () => {
    const { api } = createApi();
    const onConsumed = vi.fn();

    await act(async () => {
      root.render(
        <ProjectAgentConfiguration
          api={api}
          openComposerRequestId={17}
          onOpenComposerRequestConsumed={onConsumed}
          project={project}
          onError={vi.fn()}
          translate={(_key, fallback) => fallback}
        />,
      );
    });

    expect(onConsumed).toHaveBeenCalledWith(17);
    expect(element("project-agent-dialog")).toBeTruthy();
  });

  it.each(["allowed", "denied", "failed"] as const)(
    "waits for legacy source access before consuming a host add action: %s",
    async (result) => {
      const { api } = createApi();
      let resolveAccess!: (workspaces: never[]) => void;
      let rejectAccess!: (cause: Error) => void;
      api.workspaces!.list = vi.fn(
        () =>
          new Promise<never[]>((resolve, reject) => {
            resolveAccess = resolve;
            rejectAccess = reject;
          }),
      );
      const onConsumed = vi.fn();
      const onError = vi.fn();
      await act(async () => {
        root.render(
          <ProjectAgentConfiguration
            api={api}
            openComposerRequestId={18}
            onOpenComposerRequestConsumed={onConsumed}
            project={{ ...project, workspace_access_role: undefined }}
            onError={onError}
            translate={(_key, fallback) => fallback}
          />,
        );
      });
      expect(onConsumed).not.toHaveBeenCalled();
      expect(api.resources!.list).not.toHaveBeenCalled();
      expect(api.workspaces!.listAgents).not.toHaveBeenCalled();
      await act(async () => {
        if (result === "failed") rejectAccess(new Error("Space access failed"));
        else
          resolveAccess(
            result === "allowed" ? [{ id: project.workspace_id } as never] : [],
          );
      });
      expect(onConsumed).toHaveBeenCalledExactlyOnceWith(18);
      if (result === "allowed") {
        expect(element("project-agent-dialog")).toBeTruthy();
      } else {
        expect(
          container.querySelector('[data-testid="project-agent-dialog"]'),
        ).toBeNull();
        expect(api.resources!.list).not.toHaveBeenCalled();
        expect(api.workspaces!.listAgents).not.toHaveBeenCalled();
        expect(onError).toHaveBeenCalledTimes(result === "failed" ? 1 : 0);
      }
    },
  );

  it("excludes cloud Agent resources from local projects", async () => {
    const cloudAgent = { ...workspaceAgent, location: "cloud" as const };
    const { api } = createApi({
      resourceAgents: [cloudAgent],
      workspaceAgents: [],
    });
    const localProject = { ...project, project_store: "local" as const };
    const host = {
      ...hostedCreationHost,
      supportsExistingAgentSelection: true,
    };
    await act(async () => {
      root.render(
        <ProjectAgentConfiguration
          api={api}
          host={host}
          project={localProject}
          onError={vi.fn()}
          translate={(_key, fallback) => fallback}
        />,
      );
    });

    await click("project-agent-add");
    expect(
      container.querySelector('[data-testid="project-agent-wegent-team"]'),
    ).toBeNull();
  });

  it("reuses the current-device Agent without inventing a Team binding", async () => {
    const binding = {
      name: "current-device-agent",
      displayName: "当前设备智能体",
      runtime: "codex",
      executionPolicy: { mode: "project_pool" },
      modelPolicy: { mode: "user_select" },
      capabilityMode: "follow_device",
      model: null,
    };
    const { api, create } = createApi({
      resourceAgents: [
        {
          ...workspaceAgent,
          id: "current-device-resource",
          name: "当前设备智能体",
          location: "local",
          team_id: undefined,
          project_binding_input: binding,
        },
      ],
      workspaceAgents: [],
    });
    await act(async () => {
      root.render(
        <ProjectAgentConfiguration
          api={api}
          host={{ ...hostedCreationHost, supportsExistingAgentSelection: true }}
          project={{ ...project, project_store: "local" }}
          onError={vi.fn()}
          translate={(_key, fallback) => fallback}
        />,
      );
    });

    await click("project-agent-add");
    await click("project-agent-option-current-device-resource");
    await click("project-agent-wegent-create");

    expect(create).toHaveBeenCalledWith(project.id, binding);
    expect(create.mock.calls[0][1]).not.toHaveProperty("wegentTeamId");
    expect(element("project-agent-row-created-codex").textContent).toContain(
      "当前设备智能体",
    );
  });

  it("creates a project Agent through the resource-library host and binds it to the project", async () => {
    const { api, create } = createApi({ workspaceAgents: [] });
    await renderHosted(api);

    await click("project-agent-add");
    // Hosted creation replaces existing-Agent selection entirely.
    for (const testId of [
      "project-agent-dialog",
      "project-agent-mode-existing",
      "project-agent-mode-create",
      "project-agent-wegent-team",
      "project-agent-wegent-create",
    ]) {
      expect(document.querySelector(`[data-testid="${testId}"]`)).toBeNull();
    }
    expect(element("hosted-agent-create").dataset.namespace).toBe(
      "engineering",
    );
    expect(element("hosted-agent-create").dataset.workspaceName).toBe(
      "研发空间",
    );
    await click("hosted-agent-create");

    expect(create).toHaveBeenCalledWith(project.id, {
      name: "空间新智能体",
      runtime: "wegent",
      wegentTeamId: 91,
      shareWithWorkspace: true,
    });
    expect(element("project-agent-row-created-wegent")).toBeTruthy();
  });

  it("reuses the root local-Agent creator in local workspace settings", async () => {
    const onAgentsChange = vi.fn();
    const { api, create, list } = createApi({ agents: [] });
    await renderHosted(api, {
      onAgentsChange,
      scope: "workspace",
      target: {
        ...project,
        id: "local-workspace",
        project_store: "local",
      },
    });

    await click("project-agent-add");

    expect(element("hosted-local-agent-create")).toBeTruthy();
    expect(
      element("hosted-local-agent-create").dataset.projectId,
    ).toBeUndefined();
    expect(
      document.querySelector('[data-testid="hosted-agent-create"]'),
    ).toBeNull();

    await click("hosted-local-agent-create");

    expect(create).not.toHaveBeenCalled();
    expect(list).toHaveBeenCalledTimes(2);
    expect(onAgentsChange).toHaveBeenCalledOnce();
    expect(
      document.querySelector('[data-testid="hosted-local-agent-create"]'),
    ).toBeNull();
  });

  it("creates a local project Agent in the current project", async () => {
    const onAgentsChange = vi.fn();
    const { api, create, list } = createApi({ agents: [] });
    await renderHosted(api, {
      onAgentsChange,
      target: {
        ...project,
        project_store: "local",
      },
    });

    await click("project-agent-add");

    expect(element("hosted-local-agent-create").dataset.projectId).toBe(
      project.id,
    );
    expect(
      document.querySelector('[data-testid="hosted-agent-create"]'),
    ).toBeNull();

    await click("hosted-local-agent-create");

    expect(create).not.toHaveBeenCalled();
    expect(list).toHaveBeenCalledTimes(2);
    expect(onAgentsChange).toHaveBeenCalledOnce();
  });

  it("edits the Agent resource behind a configured project Agent", async () => {
    const onAgentsChange = vi.fn();
    const { api, update } = createApi({
      agents: [projectAgent({ wegent_team_id: 12 })],
      workspaceAgents: [],
    });
    await renderHosted(api, { onAgentsChange });

    await click("project-agent-edit-project-agent-1");
    expect(element("hosted-agent-save").dataset.teamId).toBe("12");
    expect(element("hosted-agent-save").dataset.namespace).toBe("engineering");

    await click("hosted-agent-save");

    expect(update).toHaveBeenCalledWith(project.id, "project-agent-1", {
      version: 1,
      name: "重命名智能体",
    });
    expect(element("project-agent-row-project-agent-1").textContent).toContain(
      "重命名智能体",
    );
    expect(
      document.querySelector('[data-testid="hosted-agent-editor"]'),
    ).toBeNull();
    expect(onAgentsChange).toHaveBeenCalled();
  });

  it("reloads workspace Agents after an edit instead of updating the binding", async () => {
    const { api, list, update } = createApi({
      agents: [projectAgent({ wegent_team_id: 12 })],
      workspaceAgents: [],
    });
    await renderHosted(api, { scope: "workspace" });

    await click("project-agent-edit-project-agent-1");
    await click("hosted-agent-save");

    // The workspace binding update removes the Agent, so it must stay unused.
    expect(update).not.toHaveBeenCalled();
    expect(list).toHaveBeenCalledTimes(2);
    expect(
      document.querySelector('[data-testid="hosted-agent-editor"]'),
    ).toBeNull();
  });

  it("routes project Agent editing through the local Agent editor", async () => {
    const { api } = createApi({
      agents: [projectAgent({ runtime: "claude_code", wegent_team_id: null })],
      workspaceAgents: [],
    });
    await renderHosted(api, {
      target: { ...project, id: "local-project", project_store: "local" },
    });

    await click("project-agent-edit-project-agent-1");
    expect(element("hosted-local-agent-editor").dataset.resourceId).toBe(
      "project-agent-1",
    );
    expect(
      document.querySelector('[data-testid="hosted-agent-editor"]'),
    ).toBeNull();
  });

  it("keeps a shared Agent usable without exposing unauthorized configuration edits", async () => {
    const { api } = createApi({
      agents: [projectAgent({ can_edit: false })],
    });
    await renderHosted(api);

    expect(element("project-agent-row-project-agent-1")).toBeTruthy();
    expect(
      document.querySelector(
        '[data-testid="project-agent-edit-project-agent-1"]',
      ),
    ).toBeNull();
  });

  it("archives an existing project agent with optimistic concurrency", async () => {
    const { api, update } = createApi();
    await render(api);

    vi.mocked(api.agents.list).mockResolvedValue([
      projectAgent({ status: "archived", version: 2 }),
    ]);
    await click("project-agent-archive-project-agent-1");

    expect(update).toHaveBeenCalledWith(project.id, "project-agent-1", {
      version: 1,
      status: "archived",
    });
    expect(
      document.querySelector(
        '[data-testid="project-agent-unavailable-project-agent-1"]',
      ),
    ).not.toBeNull();
  });

  it("does not expose archive for a protected project agent", async () => {
    const { api, update } = createApi({
      agents: [projectAgent({ deletable: false })],
    });
    await render(api);

    expect(
      document.querySelector(
        '[data-testid="project-agent-archive-project-agent-1"]',
      ),
    ).toBeNull();
    expect(update).not.toHaveBeenCalled();
  });

  it("keeps project Agent management available without workspace resources", async () => {
    const { api } = createApi({ workspaceAgents: [] });
    await render(api);
    await click("project-agent-add");
    expect(element("project-agent-wegent-empty").textContent).toContain(
      "智能体",
    );

    expect(
      document.querySelector('[data-testid="project-agent-mode-create"]'),
    ).toBeNull();
    expect(
      document.querySelector(
        '[data-testid="project-agent-standard-create-form"]',
      ),
    ).toBeNull();

    await render(api, { ...project, workspace_id: null });
    expect(element("project-agent-config")).toBeTruthy();
  });

  it("does not offer Agents that cannot execute for the current user", async () => {
    const { api } = createApi({
      workspaceAgents: [{ ...workspaceAgent, status: "unavailable" }],
    });
    await render(api);

    await click("project-agent-add");

    expect(
      document.querySelector('[data-testid="project-agent-wegent-team"]'),
    ).toBeNull();
    expect(element("project-agent-wegent-empty").textContent).toContain(
      "智能体",
    );
  });

  it("offers owned catalog Agents without requiring a global execution preflight", async () => {
    const { api } = createApi({
      agents: [],
      workspaceAgents: [],
      resourceAgents: [
        { ...workspaceAgent, owner_type: "user", status: "unchecked" },
      ],
    });
    await render(api);
    await click("project-agent-add");

    expect(element("project-agent-wegent-team").textContent).toContain(
      workspaceAgent.name,
    );
  });

  it("shows configured Skill and MCP counts for executable Agents", async () => {
    const { api } = createApi({
      agents: [
        projectAgent({
          runtime: "claude_code",
          wegent_team_id: null,
          additionalSkills: [{ name: "review", namespace: "codex" }],
          mcpServers: {
            repository: { command: "node", args: ["server.mjs"] },
          },
        }),
      ],
    });
    await render(api);

    expect(
      element("project-agent-capabilities-project-agent-1").textContent,
    ).toContain("1 Skill · 项目空间 MCP + 1 MCP");
  });

  it("shows an Agent display name without replacing its resource name", async () => {
    const { api } = createApi({
      agents: [
        projectAgent({
          displayName: "本地能力智能体",
          name: "local-capability-agent",
          runtime: "codex",
          wegent_team_id: null,
        }),
      ],
    });
    await render(api);

    expect(element("project-agent-row-project-agent-1").textContent).toContain(
      "本地能力智能体",
    );
    expect(
      element("project-agent-row-project-agent-1").textContent,
    ).not.toContain("local-capability-agent");
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
  it("CP09 exposes revoked bindings and allows administrators to share and re-enable them", async () => {
    const { api, update } = createApi({
      agents: [
        projectAgent({
          status: "archived",
          canUse: false,
          unavailableReason: "resource_sharing_required",
        }),
      ],
    });
    await render(api);
    expect(element("project-agent-unavailable-project-agent-1")).toBeTruthy();
    await click("project-agent-reactivate-project-agent-1");
    expect(update).toHaveBeenCalledWith(project.id, "project-agent-1", {
      version: 1,
      status: "active",
      shareWithWorkspace: true,
    });
  });
});
