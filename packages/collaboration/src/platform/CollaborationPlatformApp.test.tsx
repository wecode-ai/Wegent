// @vitest-environment jsdom

// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { act, useState, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { IssueDetail } from "../IssueDetail";
import { collaborationMessages } from "../i18n";
import type { SharedWorkspaceApi } from "../ports/SharedWorkspaceApi";
import type {
  CollaborationAssignment,
  CollaborationExecutionEnvironment,
  CollaborationIssue,
  CollaborationMember,
  CollaborationOwnedAgent,
  CollaborationProject,
  CollaborationWorkspace,
} from "../types";
import { CollaborationPlatformApp } from "./CollaborationPlatformApp";
import type {
  CollaborationPlatformHostAdapter,
  CollaborationPlatformLocation,
} from "./types";

const workspace: CollaborationWorkspace = {
  id: "workspace-1",
  name: "研发协作空间",
  description: "产品与研发共同交付",
  access_role: "Owner",
  member_count: 2,
  agent_count: 1,
  execution_environment_count: 1,
  project_count: 1,
  created_by_user_id: 1,
  version: 1,
  created_at: "2026-09-11T00:00:00Z",
  updated_at: "2026-09-12T00:00:00Z",
};

const member: CollaborationMember = {
  id: 1,
  user_id: 7,
  user_name: "李明",
  email: "liming@example.com",
  role: "Maintainer",
};

const agent: CollaborationOwnedAgent = {
  id: "agent-1",
  team_id: 11,
  name: "Codex 产品工程师",
  owner_type: "workspace",
  owner_id: workspace.id,
  owner_name: workspace.name,
  status: "available",
  execution_environment_ids: ["environment-1"],
  workspace_ids: [workspace.id],
};

const environment: CollaborationExecutionEnvironment = {
  id: "environment-1",
  device_id: 21,
  name: "李明的 MacBook Pro",
  kind: "local_device",
  owner_type: "user",
  owner_id: "7",
  owner_name: "李明",
  status: "online",
  workspace_ids: [workspace.id],
  updated_at: "2026-09-12T00:00:00Z",
};

const availableAgent: CollaborationOwnedAgent = {
  ...agent,
  id: "agent-2",
  team_id: 12,
  name: "架构设计智能体",
  workspace_ids: [],
};

const availableEnvironment: CollaborationExecutionEnvironment = {
  ...environment,
  id: "environment-2",
  device_id: 22,
  name: "Wegent 云主机",
  kind: "cloud_host",
  workspace_ids: [],
};

const project: CollaborationProject = {
  id: "project-1",
  workspace_id: workspace.id,
  public_id: "project-public-1",
  project_key: "RD",
  name: "新产品研发",
  description: "交付新产品",
  project_store: "backend",
  task_provider: "local",
  provider_config: {},
  board_config: {
    group_by: "status",
    processing_start_status_id: "in_progress",
    statuses: [
      { id: "inbox", name: "收集箱", color: "gray" },
      { id: "in_progress", name: "进行中", color: "orange" },
      { id: "completed", name: "已完成", color: "green" },
    ],
  },
  created_by_user_id: 1,
  current_user_id: 7,
  current_user_name: "李明",
  access_role: "Maintainer",
  visibility: "private",
  status: "active",
  tags: [],
  version: 1,
  created_at: "2026-09-11T00:00:00Z",
  updated_at: "2026-09-12T00:00:00Z",
};

const issue: CollaborationIssue = {
  id: "issue-1",
  cloud_project_id: project.id,
  sequence_number: 1,
  parent_id: null,
  created_by_user_id: 1,
  created_by_user_name: "项目经理",
  assignee_user_id: null,
  title: "完成智能研发主流程",
  description: "完成分配与执行闭环",
  status: "inbox",
  priority: "high",
  due_at: null,
  tags: ["核心流程"],
  sort_order: 0,
  version: 1,
  created_at: "2026-09-11T00:00:00Z",
  updated_at: "2026-09-12T00:00:00Z",
  completed_at: null,
  can_view_detail: true,
  can_edit: false,
};

const initialLocation: CollaborationPlatformLocation = {
  platformView: "spaces",
  workspaceId: null,
  workspaceView: "home",
  projectId: null,
  projectView: "board",
  issueId: null,
};

function emptyAsync<T>(value: T) {
  return vi.fn(async () => value);
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

function createApi({
  initialWorkspaces = [workspace],
  initialProjects = [project],
}: {
  initialWorkspaces?: CollaborationWorkspace[];
  initialProjects?: CollaborationProject[];
} = {}) {
  const workspaces = [...initialWorkspaces];
  const projects = [...initialProjects];
  const workspaceMembers = [member];
  const workspaceAgents = [agent];
  const workspaceEnvironments = [environment];
  const personalResources = {
    agents: [agent, availableAgent],
    execution_environments: [environment, availableEnvironment],
  };
  const issues = [issue];
  const assignments: CollaborationAssignment[] = [];
  let assignmentSequence = 0;
  const api = {
    workspaces: {
      list: vi.fn(async () => [...workspaces]),
      get: vi.fn(async () => workspaces[0] ?? workspace),
      create: vi.fn(async (input: { name: string; description?: string }) => {
        const created = {
          ...workspace,
          name: input.name,
          description: input.description ?? "",
          project_count: 0,
        };
        workspaces.unshift(created);
        return created;
      }),
      update: vi.fn(
        async (
          _workspaceId: string,
          input: { version: number; name?: string; description?: string },
        ) => ({
          ...(workspaces[0] ?? workspace),
          name: input.name ?? workspace.name,
          description: input.description ?? workspace.description,
          version: input.version + 1,
        }),
      ),
      archive: emptyAsync(undefined),
      listMembers: vi.fn(async () => [...workspaceMembers]),
      addMember: vi.fn(
        async (
          _workspaceId: string,
          input: {
            userId: number;
            role?: "Maintainer" | "Developer" | "Reporter";
          },
        ) => {
          const added: CollaborationMember = {
            id: input.userId,
            user_id: input.userId,
            user_name: input.userId === 8 ? "王芳" : `用户 ${input.userId}`,
            email: input.userId === 8 ? "wangfang@example.com" : null,
            role: input.role ?? "Developer",
          };
          workspaceMembers.push(added);
          return added;
        },
      ),
      updateMember: vi.fn(
        async (
          _workspaceId: string,
          userId: number,
          input: { role: "Maintainer" | "Developer" | "Reporter" },
        ) => {
          const current =
            workspaceMembers.find(
              (candidate) => candidate.user_id === userId,
            ) ?? member;
          const updated = { ...current, role: input.role };
          const index = workspaceMembers.findIndex(
            (candidate) => candidate.user_id === userId,
          );
          workspaceMembers[index] = updated;
          return updated;
        },
      ),
      removeMember: vi.fn(async (_workspaceId: string, userId: number) => {
        const index = workspaceMembers.findIndex(
          (candidate) => candidate.user_id === userId,
        );
        if (index >= 0) workspaceMembers.splice(index, 1);
      }),
      listAgents: vi.fn(async () => [...workspaceAgents]),
      addAgent: vi.fn(
        async (
          _workspaceId: string,
          input: { teamId: number; ownerType?: "user" | "workspace" },
        ) => {
          const source =
            personalResources.agents.find(
              (candidate) => candidate.team_id === input.teamId,
            ) ?? availableAgent;
          const added = {
            ...source,
            owner_type: input.ownerType ?? ("user" as const),
            workspace_ids: [workspace.id],
          };
          workspaceAgents.push(added);
          return added;
        },
      ),
      updateAgent: vi.fn(
        async (
          _workspaceId: string,
          teamId: number,
          input: { ownerType: "user" | "workspace" },
        ) => {
          const index = workspaceAgents.findIndex(
            (candidate) => candidate.team_id === teamId,
          );
          const updated = {
            ...(workspaceAgents[index] ?? agent),
            owner_type: input.ownerType,
          };
          workspaceAgents[index] = updated;
          return updated;
        },
      ),
      removeAgent: vi.fn(async (_workspaceId: string, teamId: number) => {
        const index = workspaceAgents.findIndex(
          (candidate) => candidate.team_id === teamId,
        );
        if (index >= 0) workspaceAgents.splice(index, 1);
      }),
      listExecutionEnvironments: vi.fn(async () => [...workspaceEnvironments]),
      addExecutionEnvironment: vi.fn(
        async (
          _workspaceId: string,
          input: { deviceId: number; ownerType?: "user" | "workspace" },
        ) => {
          const source =
            personalResources.execution_environments.find(
              (candidate) => candidate.device_id === input.deviceId,
            ) ?? availableEnvironment;
          const added = {
            ...source,
            owner_type: input.ownerType ?? ("user" as const),
            workspace_ids: [workspace.id],
          };
          workspaceEnvironments.push(added);
          return added;
        },
      ),
      removeExecutionEnvironment: vi.fn(
        async (_workspaceId: string, deviceId: number) => {
          const index = workspaceEnvironments.findIndex(
            (candidate) => candidate.device_id === deviceId,
          );
          if (index >= 0) workspaceEnvironments.splice(index, 1);
        },
      ),
    },
    resources: {
      list: vi.fn(async () => personalResources),
    },
    projects: {
      list: vi.fn(async (workspaceId?: string) =>
        projects.filter(
          (candidate) => !workspaceId || candidate.workspace_id === workspaceId,
        ),
      ),
      get: vi.fn(async () => projects[0] ?? project),
      create: vi.fn(async (input: { name: string; workspaceId?: string }) => {
        const created = {
          ...project,
          name: input.name,
          workspace_id: input.workspaceId ?? workspace.id,
        };
        projects.unshift(created);
        return created;
      }),
      update: vi.fn(async () => project),
      archive: emptyAsync(undefined),
      importMessages: vi.fn(),
    },
    issues: {
      list: emptyAsync(issues),
      listPage: emptyAsync({
        items: issues,
        nextCursor: null,
        taskBindings: [],
      }),
      getBoardSnapshot: emptyAsync({
        items: issues,
        members: [member],
        agents: [agent],
        taskBindings: [],
      }),
      get: emptyAsync(issue),
      create: emptyAsync(issue),
      update: emptyAsync(issue),
      assign: emptyAsync(issue),
      approveRun: emptyAsync(issue),
      rejectRun: emptyAsync(issue),
      archive: emptyAsync(undefined),
      reorder: emptyAsync(issues),
      markRead: emptyAsync(issue),
    },
    comments: {
      list: emptyAsync([]),
      create: vi.fn(async (_issueId: string, body: string) => ({
        id: `comment-${body}`,
        body,
        author: "李明",
        web_url: null,
        created_at: "2026-09-12T01:00:00Z",
        updated_at: "2026-09-12T01:00:00Z",
      })),
    },
    assignments: {
      list: vi.fn(async () => [...assignments]),
      create: vi.fn(
        async (
          _issueId: string,
          input: {
            targetType: "human" | "agent";
            targetId: string;
            workflowStep?: string | null;
            commentBody?: string;
            notifyTarget?: boolean;
          },
        ) => {
          const targetName =
            input.targetType === "human" ? member.user_name : agent.name;
          const created: CollaborationAssignment = {
            id: `assignment-${++assignmentSequence}`,
            issue_id: issue.id,
            target_type: input.targetType,
            target_id: input.targetId,
            target_name: targetName,
            workflow_step: input.workflowStep ?? null,
            comment_id: null,
            created_by_user_id: 1,
            created_by_user_name: "项目经理",
            status: "active",
            created_at: "2026-09-12T02:00:00Z",
            updated_at: "2026-09-12T02:00:00Z",
          };
          assignments.push(created);
          return { assignment: created, comment: null, issue };
        },
      ),
    },
    attachments: {
      list: emptyAsync([]),
      listProjectTaskAttachments: emptyAsync([]),
      upload: vi.fn(),
      importContexts: emptyAsync([]),
      access: emptyAsync({
        url: "https://example.test/file",
        expiresInSeconds: 60,
      }),
      read: emptyAsync(new Blob()),
      remove: emptyAsync(undefined),
    },
    collaborators: {
      list: emptyAsync([]),
      add: vi.fn(),
      remove: emptyAsync(undefined),
    },
    taskBindings: { list: emptyAsync([]) },
    workflowPlans: {
      get: emptyAsync(null),
      decideNode: vi.fn(),
      getStageContext: vi.fn(),
    },
    members: {
      list: emptyAsync([member]),
      searchUsers: vi.fn(async () => [
        {
          id: 8,
          user_name: "王芳",
          email: "wangfang@example.com",
        },
      ]),
      add: vi.fn(),
      update: vi.fn(),
      remove: emptyAsync(undefined),
    },
    files: {
      list: emptyAsync([]),
      listDeliveryFiles: emptyAsync([]),
      createFolder: vi.fn(),
      upload: vi.fn(),
      access: vi.fn(),
      read: vi.fn(),
      move: vi.fn(),
      remove: vi.fn(),
      accessDeliveryFile: vi.fn(),
      readDeliveryFile: vi.fn(),
    },
    deliveries: {
      list: emptyAsync([]),
      get: vi.fn(),
      create: vi.fn(),
      addAsset: vi.fn(),
      finalize: vi.fn(),
      discardDraft: vi.fn(),
    },
    executions: {
      list: emptyAsync([]),
      stop: vi.fn(),
    },
    automations: {
      list: emptyAsync([]),
      create: vi.fn(),
      migrateWorkflow: vi.fn(),
      update: vi.fn(),
      remove: vi.fn(),
      runNow: vi.fn(),
      runWorkflowNode: vi.fn(),
      listRuns: emptyAsync([]),
      cancelRun: vi.fn(),
      retryRun: vi.fn(),
    },
    incomingHooks: {
      catalog: emptyAsync([]),
      list: emptyAsync([]),
      create: vi.fn(),
      update: vi.fn(),
      rotate: vi.fn(),
      remove: vi.fn(),
      listEvents: emptyAsync([]),
    },
    runtimeProfiles: {
      list: emptyAsync([]),
      create: vi.fn(),
      update: vi.fn(),
      remove: vi.fn(),
      getProjectDefault: vi.fn(),
      setProjectDefault: vi.fn(),
      selectExecution: vi.fn(),
    },
    agents: {
      list: emptyAsync([agent]),
      create: vi.fn(),
      update: vi.fn(),
    },
  } as unknown as SharedWorkspaceApi;
  return { api, workspaces, projects, assignments };
}

let container: HTMLDivElement;
let root: Root;

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function render(ui: ReactNode) {
  await act(async () => {
    root.render(ui);
  });
  await flush();
}

function byTestId(testId: string): HTMLElement {
  const element = container.querySelector<HTMLElement>(
    `[data-testid="${testId}"]`,
  );
  expect(element, `Missing data-testid=${testId}`).not.toBeNull();
  return element!;
}

function buttonWithText(text: string): HTMLButtonElement {
  const button = [...container.querySelectorAll("button")].find((candidate) =>
    candidate.textContent?.includes(text),
  );
  expect(button, `Missing button containing ${text}`).toBeDefined();
  return button!;
}

async function click(element: Element) {
  await act(async () => {
    element.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  await flush();
}

async function change(
  element: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement,
  value: string,
) {
  const prototype =
    element instanceof HTMLSelectElement
      ? HTMLSelectElement.prototype
      : element instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(prototype, "value")?.set?.call(
    element,
    value,
  );
  await act(async () => {
    element.dispatchEvent(new Event("change", { bubbles: true }));
    element.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function PlatformHarness({
  api,
  start = initialLocation,
  onReady,
}: {
  api: SharedWorkspaceApi;
  start?: CollaborationPlatformLocation;
  onReady?(): void;
}) {
  const [location, setLocation] = useState(start);
  const host: CollaborationPlatformHostAdapter = {
    location,
    capabilities: { automation: false, dingtalkAitable: false },
    navigate: setLocation,
  };
  return (
    <>
      <output data-testid="test-location">{JSON.stringify(location)}</output>
      <CollaborationPlatformApp api={api} host={host} onReady={onReady} />
    </>
  );
}

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  vi.stubGlobal("matchMedia", () => ({
    matches: false,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }));
  HTMLElement.prototype.scrollIntoView = vi.fn();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

describe("CollaborationPlatformApp real component flow", () => {
  it("reports readiness only after the initial platform data is loaded", async () => {
    const { api } = createApi();
    const onReady = vi.fn();
    await render(<PlatformHarness api={api} onReady={onReady} />);

    expect(api.workspaces?.list).toHaveBeenCalledOnce();
    expect(onReady).toHaveBeenCalledOnce();
  });

  it("creates the first workspace and exposes platform and workspace navigation", async () => {
    const { api } = createApi({ initialWorkspaces: [], initialProjects: [] });
    await render(<PlatformHarness api={api} />);

    expect(container.textContent).toContain("还没有协作空间");
    await click(byTestId("collaboration-nav-resources"));
    expect(container.textContent).toContain("我的智能体");
    expect(container.textContent).toContain(agent.name);
    await click(byTestId("collaboration-nav-all-spaces"));

    await click(byTestId("collaboration-workspace-create"));
    await change(
      byTestId("collaboration-workspace-name-input") as HTMLInputElement,
      workspace.name,
    );
    await change(
      byTestId(
        "collaboration-workspace-description-input",
      ) as HTMLTextAreaElement,
      workspace.description,
    );
    await click(byTestId("collaboration-workspace-create-confirm"));

    expect(byTestId("collaboration-workspace-back").textContent).toContain(
      "返回所有空间",
    );
    expect(
      container.querySelector('[data-testid="collaboration-nav-all-spaces"]'),
    ).toBeNull();

    await click(byTestId("collaboration-workspace-nav-members"));
    expect(container.textContent).toContain(member.user_name);
    await click(byTestId("collaboration-workspace-nav-agents"));
    expect(container.textContent).toContain(agent.name);
    await click(byTestId("collaboration-workspace-nav-execution-environments"));
    expect(container.textContent).toContain(environment.name);
    await click(byTestId("collaboration-workspace-nav-settings"));
    expect(byTestId("collaboration-workspace-settings-save")).toBeTruthy();

    await click(byTestId("collaboration-workspace-back"));
    expect(byTestId("collaboration-nav-all-spaces")).toBeTruthy();
    expect(byTestId("collaboration-nav-resources")).toBeTruthy();
  });

  it.each(["Owner", "Maintainer"] as const)(
    "allows %s to view and save workspace settings",
    async (role) => {
      const managedWorkspace = { ...workspace, access_role: role };
      const { api } = createApi({ initialWorkspaces: [managedWorkspace] });
      await render(
        <PlatformHarness
          api={api}
          start={{
            ...initialLocation,
            workspaceId: workspace.id,
            workspaceView: "settings",
          }}
        />,
      );

      expect(byTestId("collaboration-workspace-nav-settings")).toBeTruthy();
      await change(
        container.querySelector(
          ".collaboration-workspace-settings input",
        ) as HTMLInputElement,
        "更新后的空间",
      );
      await click(byTestId("collaboration-workspace-settings-save"));
      expect(api.workspaces?.update).toHaveBeenCalledWith(workspace.id, {
        version: workspace.version,
        name: "更新后的空间",
        description: workspace.description,
      });
    },
  );

  it.each(["Developer", "Reporter", "Member"] as const)(
    "hides workspace settings from %s even for a direct settings location",
    async (role) => {
      const restrictedWorkspace = { ...workspace, access_role: role };
      const { api } = createApi({ initialWorkspaces: [restrictedWorkspace] });
      await render(
        <PlatformHarness
          api={api}
          start={{
            ...initialLocation,
            workspaceId: workspace.id,
            workspaceView: "settings",
          }}
        />,
      );

      expect(
        container.querySelector(
          '[data-testid="collaboration-workspace-nav-settings"]',
        ),
      ).toBeNull();
      expect(
        container.querySelector(
          '[data-testid="collaboration-workspace-settings-save"]',
        ),
      ).toBeNull();
      expect(api.workspaces?.update).not.toHaveBeenCalled();
    },
  );

  it("does not let an older location request overwrite a newer workspace", async () => {
    const oldWorkspace = { ...workspace, id: "workspace-old", name: "旧空间" };
    const newWorkspace = { ...workspace, id: "workspace-new", name: "新空间" };
    const oldList = deferred<CollaborationWorkspace[]>();
    const { api } = createApi({
      initialWorkspaces: [oldWorkspace, newWorkspace],
    });
    api.workspaces!.list = vi
      .fn()
      .mockImplementationOnce(() => oldList.promise)
      .mockResolvedValue([oldWorkspace, newWorkspace]);
    api.workspaces!.get = vi.fn(async (workspaceId) =>
      workspaceId === newWorkspace.id ? newWorkspace : oldWorkspace,
    );

    function RaceHarness() {
      const [location, setLocation] = useState<CollaborationPlatformLocation>({
        ...initialLocation,
        workspaceId: oldWorkspace.id,
      });
      return (
        <>
          <button
            data-testid="switch-workspace"
            onClick={() =>
              setLocation((current) => ({
                ...current,
                workspaceId: newWorkspace.id,
              }))
            }
            type="button"
          >
            Switch
          </button>
          <CollaborationPlatformApp
            api={api}
            host={{
              location,
              capabilities: {
                automation: false,
                dingtalkAitable: false,
              },
              navigate: setLocation,
            }}
          />
        </>
      );
    }

    await render(<RaceHarness />);
    await click(byTestId("switch-workspace"));
    expect(container.textContent).toContain(newWorkspace.name);

    await act(async () => {
      oldList.resolve([oldWorkspace, newWorkspace]);
      await oldList.promise;
    });
    await flush();

    expect(container.textContent).toContain(newWorkspace.name);
    expect(container.textContent).not.toContain(oldWorkspace.name);
  });

  it("configures workspace members, agents, and execution environments through shared UI", async () => {
    vi.useFakeTimers();
    const { api } = createApi();
    await render(
      <PlatformHarness
        api={api}
        start={{
          ...initialLocation,
          workspaceId: workspace.id,
          workspaceView: "members",
        }}
      />,
    );

    await click(byTestId("collaboration-workspace-member-invite"));
    await change(
      byTestId("collaboration-workspace-member-search") as HTMLInputElement,
      "王芳",
    );
    await act(async () => {
      vi.advanceTimersByTime(200);
      await Promise.resolve();
    });
    await flush();
    await click(byTestId("collaboration-workspace-member-result-8"));
    expect(api.workspaces?.addMember).toHaveBeenCalledWith(workspace.id, {
      userId: 8,
      role: "Developer",
    });

    await change(
      byTestId("collaboration-workspace-member-role-8") as HTMLSelectElement,
      "Reporter",
    );
    expect(api.workspaces?.updateMember).toHaveBeenCalledWith(workspace.id, 8, {
      role: "Reporter",
    });
    await click(byTestId("collaboration-workspace-member-remove-8"));
    expect(api.workspaces?.removeMember).toHaveBeenCalledWith(workspace.id, 8);

    await click(byTestId("collaboration-workspace-nav-agents"));
    await change(
      byTestId("collaboration-workspace-agent-candidate") as HTMLSelectElement,
      "12",
    );
    expect(
      container.querySelector(
        '[data-testid="collaboration-workspace-agent-owner-type"]',
      ),
    ).toBeNull();
    await click(byTestId("collaboration-workspace-agent-authorize"));
    expect(api.workspaces?.addAgent).toHaveBeenCalledWith(workspace.id, {
      teamId: 12,
      ownerType: "user",
    });
    await click(byTestId("collaboration-workspace-agent-remove-12"));
    expect(api.workspaces?.removeAgent).toHaveBeenCalledWith(workspace.id, 12);

    await click(byTestId("collaboration-workspace-nav-execution-environments"));
    await change(
      byTestId(
        "collaboration-workspace-environment-candidate",
      ) as HTMLSelectElement,
      "22",
    );
    expect(
      container.querySelector(
        '[data-testid="collaboration-workspace-environment-owner-type"]',
      ),
    ).toBeNull();
    await click(byTestId("collaboration-workspace-environment-authorize"));
    expect(api.workspaces?.addExecutionEnvironment).toHaveBeenCalledWith(
      workspace.id,
      {
        deviceId: 22,
        ownerType: "user",
      },
    );
    await click(byTestId("collaboration-workspace-environment-remove-22"));
    expect(api.workspaces?.removeExecutionEnvironment).toHaveBeenCalledWith(
      workspace.id,
      22,
    );
    vi.useRealTimers();
  });

  it("creates and re-enters a project, then switches between board, table, and issue activity", async () => {
    const { api } = createApi({ initialProjects: [] });
    await render(
      <PlatformHarness
        api={api}
        start={{ ...initialLocation, workspaceId: workspace.id }}
      />,
    );

    await click(byTestId("collaboration-workspace-project-create"));
    await change(
      byTestId("collaboration-project-name-input") as HTMLInputElement,
      project.name,
    );
    await click(byTestId("collaboration-project-create-confirm"));

    expect(byTestId("collaboration-tab-board")).toBeTruthy();
    expect(container.textContent).toContain(issue.title);
    await click(byTestId("collaboration-project-back"));
    await click(byTestId(`collaboration-project-card-${project.id}`));
    expect(byTestId("collaboration-tab-board")).toBeTruthy();

    await click(byTestId("collaboration-tab-table"));
    expect(byTestId("collaboration-issue-table")).toBeTruthy();
    await click(byTestId(`collaboration-issue-table-row-${issue.id}`));
    expect(byTestId("collaboration-issue-activity")).toBeTruthy();

    const comment = byTestId(
      "collaboration-issue-comment",
    ) as HTMLTextAreaElement;
    await change(comment, "请先确认接口契约");
    await click(byTestId("collaboration-issue-comment-submit"));
    expect(api.comments.create).toHaveBeenCalledWith(
      issue.id,
      "请先确认接口契约",
    );

    const target = byTestId(
      "collaboration-assignment-target",
    ) as HTMLSelectElement;
    await change(target, `human:${member.user_id}`);
    await change(
      byTestId("collaboration-assignment-workflow-step") as HTMLInputElement,
      "交互设计",
    );
    await click(byTestId("collaboration-issue-comment-submit"));
    expect(api.assignments?.create).toHaveBeenLastCalledWith(issue.id, {
      targetType: "human",
      targetId: String(member.user_id),
      workflowStep: "交互设计",
      commentBody: undefined,
      notifyTarget: true,
    });

    await change(target, `agent:${agent.id}`);
    await click(byTestId("collaboration-issue-comment-submit"));
    expect(api.assignments?.create).toHaveBeenLastCalledWith(issue.id, {
      targetType: "agent",
      targetId: agent.id,
      workflowStep: null,
      commentBody: undefined,
      notifyTarget: false,
    });
  });

  it("loads table assignments by issue id and renders the real target name", async () => {
    const { api, assignments } = createApi();
    assignments.push({
      id: "assignment-table",
      issue_id: issue.id,
      target_type: "agent",
      target_id: agent.id,
      target_name: "表格真实智能体",
      workflow_step: "实现",
      comment_id: null,
      created_by_user_id: 1,
      created_by_user_name: "项目经理",
      status: "active",
      created_at: "2026-09-12T02:00:00Z",
      updated_at: "2026-09-12T02:00:00Z",
    });

    await render(
      <PlatformHarness
        api={api}
        start={{
          ...initialLocation,
          workspaceId: workspace.id,
          projectId: project.id,
          projectView: "table",
        }}
      />,
    );

    expect(api.assignments?.list).toHaveBeenCalledWith(issue.id);
    expect(
      byTestId(`collaboration-issue-table-row-${issue.id}`).textContent,
    ).toContain("表格真实智能体");
  });
});

describe("Issue permission separation in the real shared editor", () => {
  it("keeps editing, commenting, assigning, and starting work independent", async () => {
    const { api } = createApi();
    const onCreateTask = vi.fn();
    await render(
      <IssueDetail
        api={api}
        project={{ ...project, access_role: "Reporter" }}
        issue={{ ...issue, can_edit: false, can_view_detail: true }}
        allIssues={[issue]}
        comments={[]}
        assignments={[]}
        executions={[]}
        members={[member]}
        agents={[agent]}
        messages={collaborationMessages["zh-CN"]}
        onClose={vi.fn()}
        onChange={vi.fn()}
        onCommentsChange={vi.fn()}
        onAssignmentsChange={vi.fn()}
        onCreateTask={onCreateTask}
        onConflict={async () => undefined}
        onError={vi.fn()}
      />,
    );

    expect(
      (byTestId("cloud-todo-detail-title") as HTMLTextAreaElement).readOnly,
    ).toBe(true);
    expect(
      (byTestId("collaboration-issue-comment") as HTMLTextAreaElement).disabled,
    ).toBe(false);
    expect(
      (byTestId("collaboration-assignment-target") as HTMLSelectElement)
        .disabled,
    ).toBe(true);
    await click(byTestId("cloud-todo-create-task"));
    expect(onCreateTask).toHaveBeenCalledOnce();
  });
});
