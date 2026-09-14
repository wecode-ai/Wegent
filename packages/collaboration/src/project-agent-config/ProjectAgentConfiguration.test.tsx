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
import { RuntimeProfilePickerContext } from '../runtime-profile/context'
import { createCollaborationTranslator } from '../i18n'

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

const environment: CollaborationExecutionEnvironment = {
  id: "environment-1",
  device_id: 22,
  device_key: "device-macbook",
  name: "MacBook Pro",
  kind: "local_device",
  coding_tools: ["claude_code", "codex"],
  owner_type: "user",
  owner_id: "7",
  owner_name: "李明",
  status: "online",
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
    automationExecutionCatalog: {
      load: vi.fn(async () => ({ environments: [], runtimeProfiles: [], plugins: [], models: [{ name: 'deepseek', label: 'DeepSeek', type: 'public', options: { weworkCloudModelNamespace: 'default', weworkCloudModelResourceUserId: '0' } }] })),
    },
    projects: {
      listExecutionEnvironments: vi.fn(
        async () => options?.environments ?? [environment],
      ),
    },
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

  it('exposes missing model configuration and saves the selected agent defaults', async () => {
    const { api, update } = createApi({ agents: [projectAgent({ runtime: 'codex' })] })
    const picker = vi.fn()
    await act(async () => root.render(
      <RuntimeProfilePickerContext.Provider value={picker}>
        <ProjectAgentConfiguration api={api} project={project} onError={vi.fn()} translate={createCollaborationTranslator('zh-CN')} />
      </RuntimeProfilePickerContext.Provider>,
    ))
    expect(container.textContent).toContain('缺少模型配置')
    await click('project-agent-configure-project-agent-1')
    const target = picker.mock.calls[0]![0]
    const modelOptions = { weworkCloudModelNamespace: 'default', weworkCloudModelResourceUserId: '0' }
    await act(async () => target.apply({ id: 'profile', executionDeviceId: 'cloud-device', executionEnvironment: 'cloud', model: 'model', modelType: 'public', modelOptions }))
    expect(update).toHaveBeenCalledWith(project.id, 'project-agent-1', {
      version: 1, defaultRuntimeProfileId: 'profile', executionDeviceId: 'cloud-device', executionEnvironment: 'cloud', model: 'model', modelType: 'public', modelOptions,
    })
  })

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

  it('shows model loading failure in the dialog and supports retry', async () => {
    const { api } = createApi()
    vi.mocked(api.automationExecutionCatalog!.load).mockRejectedValueOnce(new Error('Model catalog unavailable'))
    await render(api)
    await click('project-agent-add')
    await click('project-agent-mode-codex')
    expect(element('project-agent-dialog').textContent).toContain('Model catalog unavailable')
    await click('project-agent-model-retry')
    await change('project-agent-codex-name', 'Codex')
    await change('project-agent-codex-environment', environment.id)
    await change('project-agent-codex-model', '0')
    expect((element('project-agent-codex-create') as HTMLButtonElement).disabled).toBe(false)
    await change('project-agent-codex-environment', '')
    expect((element('project-agent-codex-model') as HTMLSelectElement).value).toBe('')
    expect((element('project-agent-codex-create') as HTMLButtonElement).disabled).toBe(true)
  })

  it('blocks cloud execution from using a device runtime model', async () => {
    const { api } = createApi({ environments: [{ ...environment, kind: 'cloud_host' }] })
    vi.mocked(api.automationExecutionCatalog!.load).mockResolvedValue({ environments: [], plugins: [], runtimeProfiles: [], models: [{ name: 'runtime-model', label: 'Runtime only', type: 'runtime', options: {} }] })
    await render(api)
    await click('project-agent-add')
    await click('project-agent-mode-codex')
    await change('project-agent-codex-name', 'Codex')
    await change('project-agent-codex-environment', environment.id)
    expect(element('project-agent-codex-model').textContent).not.toContain('Runtime only')
    expect(element('project-agent-dialog').textContent).toContain('没有可用模型')
    expect((element('project-agent-codex-create') as HTMLButtonElement).disabled).toBe(true)
  })

  it.each(['local_device', 'cloud_host'] as const)(
    'creates managed Wegent and %s Codex agents through the shared API',
    async kind => {
      const { api, create } = createApi({ environments: [{ ...environment, kind }] });
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
      await click("project-agent-mode-codex");
      await change("project-agent-codex-name", "Codex 产品工程师");
      await change("project-agent-codex-capability", "实现产品需求");
      await change("project-agent-codex-prompt", "遵循项目规范");
      await change("project-agent-codex-environment", environment.id);
      expect((element('project-agent-codex-create') as HTMLButtonElement).disabled).toBe(true)
      await change('project-agent-codex-model', '0')
      await click("project-agent-codex-create");

      expect(create).toHaveBeenNthCalledWith(2, project.id, {
        name: "Codex 产品工程师",
        runtime: "codex",
        capabilityDescription: "实现产品需求",
        systemPrompt: "遵循项目规范",
        executionDeviceId: "device-macbook",
        executionEnvironment: kind === 'cloud_host' ? 'cloud' : 'local',
        model: 'deepseek',
        modelType: 'public',
        modelOptions: { weworkCloudModelNamespace: 'default', weworkCloudModelResourceUserId: '0' },
        workspaceBinding: {
          type: 'standalone',
        },
      });
      expect(element("project-agent-row-created-codex")).toBeTruthy();
    }
  )

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
    const { api } = createApi({ workspaceAgents: [], environments: [] });
    await render(api);
    await click("project-agent-add");
    expect(element("project-agent-wegent-empty").textContent).toContain(
      "智能体",
    );

    await click("project-agent-mode-codex");
    expect(
      element("project-agent-codex-environment-empty").textContent,
    ).toContain("执行环境");

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

    await click("project-agent-add");
    await click("project-agent-mode-codex");
    expect(element("project-agent-codex-environment").textContent).toContain(
      "MacBook Pro · LOCALIZED LOCAL · LOCALIZED ONLINE",
    );
  });
});
