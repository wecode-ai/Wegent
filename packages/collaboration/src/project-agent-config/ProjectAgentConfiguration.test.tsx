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
  renderModePicker({ onChange, options }) {
    return (
      <div>
        {options.map((option) => (
          <button
            data-testid={option.testId}
            key={option.value}
            onClick={() => onChange(option.value)}
            type="button"
          >
            {option.label}
          </button>
        ))}
      </div>
    );
  },
  renderSelect({ ariaLabel, onChange, options, testId, value }) {
    return (
      <select
        aria-label={ariaLabel}
        data-testid={testId}
        onChange={(event) => onChange(event.target.value)}
        value={value}
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    );
  },
  renderPrimaryAction({ children, disabled, onClick, testId }) {
    return (
      <button
        data-testid={testId}
        disabled={disabled}
        onClick={onClick}
        type="button"
      >
        {children}
      </button>
    );
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

  async function renderHosted(
    api: SharedWorkspaceApi,
    options: { onAgentsChange?(): void; scope?: "project" | "workspace" } = {},
  ) {
    await act(async () => {
      root.render(
        <ProjectAgentConfiguration
          api={api}
          host={hostedCreationHost}
          project={project}
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

  it("adds an existing Agent without exposing a duplicate inline creator", async () => {
    const { api, create } = createApi();
    await render(api);

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
    });
    expect(element("project-agent-row-created-wegent")).toBeTruthy();
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

  it("offers no edit action for project Agents without an editable resource", async () => {
    const { api } = createApi({
      agents: [projectAgent({ runtime: "claude_code" })],
      workspaceAgents: [],
    });
    await renderHosted(api);

    expect(
      document.querySelector(
        '[data-testid="project-agent-edit-project-agent-1"]',
      ),
    ).toBeNull();
    expect(element("project-agent-archive-project-agent-1")).toBeTruthy();
  });

  it("edits a locally owned Agent without a cloud Team binding", async () => {
    const { api, list, create } = createApi({
      agents: [projectAgent({ runtime: "codex" })],
    });
    const onAgentsChange = vi.fn();
    const host: ProjectAgentConfigurationHost = {
      ...hostedCreationHost,
      renderProjectAgentForm({ agentId, onSaved }) {
        return (
          <button
            data-testid="local-agent-save"
            data-agent-id={agentId}
            onClick={() => void onSaved()}
          >
            Save
          </button>
        );
      },
    };
    await act(async () =>
      root.render(
        <ProjectAgentConfiguration
          api={api}
          host={host}
          project={{ ...project, project_store: "local" }}
          onAgentsChange={onAgentsChange}
          onError={vi.fn()}
          translate={(_key, fallback) => fallback}
        />,
      ),
    );
    await click("project-agent-edit-project-agent-1");
    expect(element("local-agent-save").getAttribute("data-agent-id")).toBe(
      "project-agent-1",
    );
    list.mockResolvedValue([
      projectAgent({ name: "Edited locally", runtime: "codex" }),
    ]);
    await click("local-agent-save");
    expect(element("project-agent-row-project-agent-1").textContent).toContain(
      "Edited locally",
    );
    expect(onAgentsChange).toHaveBeenCalledOnce();
    expect(create).not.toHaveBeenCalled();
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

  it("shows configured Skill and MCP counts for executable Agents", async () => {
    const { api } = createApi({
      agents: [
        projectAgent({
          runtime: "claude_code",
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
