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
import { createWegentProjectAgentInput } from "../project-agent-config";
import type {
  CollaborationAssignment,
  CollaborationExecutionEnvironment,
  CollaborationIssue,
  CollaborationMember,
  CollaborationOwnedAgent,
  CollaborationProject,
  CollaborationWorkspace,
} from "../types";
import {
  CollaborationPlatformApp,
  type CollaborationProjectRendererContext,
} from "./CollaborationPlatformApp";
import type {
  CollaborationPlatformHostAdapter,
  CollaborationPlatformLocation,
} from "./types";

const workspace: CollaborationWorkspace = {
  id: "workspace-1",
  location: "cloud",
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
};

const environment: CollaborationExecutionEnvironment = {
  id: "environment-1",
  device_id: 21,
  device_key: "device-21",
  name: "李明的 MacBook Pro",
  kind: "local_device",
  coding_tools: ["claude_code", "codex"],
  owner_type: "user",
  owner_id: "7",
  owner_name: "李明",
  status: "online",
  updated_at: "2026-09-12T00:00:00Z",
};

const availableAgent: CollaborationOwnedAgent = {
  ...agent,
  id: "agent-2",
  team_id: 12,
  name: "架构设计智能体",
};

const availableEnvironment: CollaborationExecutionEnvironment = {
  ...environment,
  id: "environment-2",
  device_id: 22,
  name: "Wegent 云主机",
  kind: "cloud_host",
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
  permissions: {
    edit_content: true,
    comment: true,
    claim: true,
    handoff: true,
    assign: true,
    execute: true,
    submit_review: true,
    complete: true,
    reopen: true,
  },
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
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((next, fail) => {
    resolve = next;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function createApi({
  initialWorkspaces = [workspace],
  initialProjects = [project],
  initialIssues = [issue],
}: {
  initialWorkspaces?: CollaborationWorkspace[];
  initialProjects?: CollaborationProject[];
  initialIssues?: CollaborationIssue[];
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
  const issues = [...initialIssues];
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
        async (_workspaceId: string, input: { teamId: number }) => {
          const source =
            personalResources.agents.find(
              (candidate) => candidate.team_id === input.teamId,
            ) ?? availableAgent;
          const added = { ...source };
          workspaceAgents.push(added);
          return added;
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
        async (_workspaceId: string, input: { deviceId: number }) => {
          const source =
            personalResources.execution_environments.find(
              (candidate) => candidate.device_id === input.deviceId,
            ) ?? availableEnvironment;
          const added = { ...source };
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
      listExecutionEnvironments: emptyAsync([environment]),
      addExecutionEnvironment: emptyAsync(environment),
      removeExecutionEnvironment: emptyAsync(undefined),
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
            body: input.commentBody ?? "",
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

function checkboxWithLabel(text: string): HTMLInputElement {
  const label = [...container.querySelectorAll("label")].find((candidate) =>
    candidate.textContent?.includes(text),
  );
  const checkbox = label?.querySelector<HTMLInputElement>(
    'input[type="checkbox"]',
  );
  expect(checkbox, `Missing checkbox labelled ${text}`).not.toBeNull();
  return checkbox!;
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
  notify,
  manageResource,
  renderProject,
  capabilities = { automation: false, dingtalkAitable: false },
}: {
  api: SharedWorkspaceApi;
  start?: CollaborationPlatformLocation;
  onReady?(): void;
  notify?: CollaborationPlatformHostAdapter["notify"];
  manageResource?: CollaborationPlatformHostAdapter["manageResource"];
  renderProject?(context: CollaborationProjectRendererContext): ReactNode;
  capabilities?: CollaborationPlatformHostAdapter["capabilities"];
}) {
  const [location, setLocation] = useState(start);
  const host: CollaborationPlatformHostAdapter = {
    location,
    capabilities,
    navigate: setLocation,
    manageResource,
    notify,
  };
  return (
    <>
      <output data-testid="test-location">{JSON.stringify(location)}</output>
      <CollaborationPlatformApp
        api={api}
        host={host}
        onReady={onReady}
        renderProject={renderProject}
      />
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

  it("lists projects directly under their workspace on the spaces page", async () => {
    const { api } = createApi();
    await render(<PlatformHarness api={api} />);

    expect(api.projects.list).toHaveBeenCalledWith();
    expect(byTestId(`collaboration-workspace-${workspace.id}`)).toBeTruthy();
    expect(byTestId(`collaboration-project-card-${project.id}`)).toBeTruthy();
    expect(
      byTestId(`collaboration-workspace-tree-${workspace.id}`),
    ).toBeTruthy();
    expect(
      byTestId(`collaboration-workspace-project-${project.id}`),
    ).toBeTruthy();
    expect(container.querySelector(".collaboration-workspace-card")).toBeNull();

    const navigationTree = byTestId(
      "collaboration-platform-sidebar",
    ).querySelector(".collaboration-workspace-tree");
    await click(byTestId(`collaboration-workspace-project-${project.id}`));
    expect(
      byTestId("collaboration-platform-sidebar").querySelector(
        ".collaboration-workspace-tree",
      ),
    ).toBe(navigationTree);
    expect(byTestId("test-location").textContent).toContain(
      `"workspaceId":"${workspace.id}"`,
    );
    expect(byTestId("test-location").textContent).toContain(
      `"projectId":"${project.id}"`,
    );
  });

  it("shows explicit local and cloud storage boundaries for the Wework host", async () => {
    const localWorkspace: CollaborationWorkspace = {
      ...workspace,
      id: "wework-local-workspace",
      location: "local",
      name: "本地空间",
    };
    const { api } = createApi({
      initialWorkspaces: [localWorkspace, workspace],
    });

    await render(
      <PlatformHarness
        api={api}
        capabilities={{
          automation: false,
          dingtalkAitable: false,
          workspaceLocations: ["local", "cloud"],
          sidebarPresentation: "full",
        }}
      />,
    );

    expect(container.textContent).toContain("当前设备");
    expect(container.textContent).toContain("云端空间");
    expect(
      byTestId("collaboration-workspace-wework-local-workspace").getAttribute(
        "data-location",
      ),
    ).toBe("local");
    expect(
      byTestId("collaboration-workspace-workspace-1").getAttribute(
        "data-location",
      ),
    ).toBe("cloud");
    expect(container.textContent).toContain("本地 · 仅当前设备");
    expect(container.textContent).toContain("云端 · 可跨设备协作");

    await click(byTestId("collaboration-workspace-create"));
    expect(container.textContent).toContain("保存在 Wegent 云端");
  });

  it("uses context navigation and exposes cloud storage only for the Web host", async () => {
    const { api } = createApi();
    await render(
      <PlatformHarness
        api={api}
        capabilities={{
          automation: false,
          dingtalkAitable: false,
          workspaceLocations: ["cloud"],
          sidebarPresentation: "context",
        }}
      />,
    );

    expect(container.querySelector(".collaboration-platform-brand")).toBeNull();
    expect(container.textContent).not.toContain("当前设备");
    expect(
      byTestId("collaboration-workspace-workspace-1").getAttribute(
        "data-location",
      ),
    ).toBe("cloud");
  });

  it("creates the first workspace and exposes platform and workspace navigation", async () => {
    const { api } = createApi({ initialWorkspaces: [], initialProjects: [] });
    await render(<PlatformHarness api={api} />);

    expect(container.textContent).toContain("还没有协作空间");
    expect(
      container.querySelector('[data-testid="collaboration-nav-resources"]'),
    ).toBeNull();
    expect(
      container.querySelector('[data-testid="collaboration-nav-all-spaces"]'),
    ).toBeNull();
    await click(byTestId("collaboration-workspace-sidebar-create"));
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

    expect(
      container.querySelector('[data-testid="collaboration-workspace-back"]'),
    ).toBeNull();
    expect(byTestId("collaboration-workspace-nav-projects")).toBeTruthy();
    const sidebar = byTestId("collaboration-platform-sidebar");
    const workspaceTree = sidebar.querySelector(
      ".collaboration-workspace-tree",
    );
    const workspaceGroup = workspaceTree?.children[0];
    expect(workspaceGroup?.classList).toContain(
      "collaboration-workspace-group",
    );
    expect(workspaceGroup?.children[0]?.classList).toContain(
      "collaboration-workspace-row",
    );
    expect(workspaceGroup?.children[1]?.classList).toContain(
      "collaboration-workspace-project-list",
    );
    expect(sidebar.querySelector(".collaboration-workspace-home")).toBeNull();
    expect(
      sidebar.querySelector(".collaboration-platform-project-mark"),
    ).toBeNull();
    expect(sidebar.textContent).not.toContain("云端 · 可跨设备协作");
    expect(sidebar.textContent).not.toContain("全部项目");
    expect(
      container.querySelector(
        '[data-testid="collaboration-workspace-nav-members"]',
      ),
    ).toBeNull();

    await click(byTestId("collaboration-workspace-starter-invite-members"));
    expect(container.textContent).toContain(member.user_name);
    await click(byTestId("collaboration-workspace-nav-agents"));
    expect(container.textContent).toContain(agent.name);
    await click(byTestId("collaboration-workspace-nav-execution-environments"));
    expect(container.textContent).toContain(environment.name);
    await click(byTestId("collaboration-workspace-actions"));
    await click(byTestId("collaboration-workspace-nav-settings"));
    expect(byTestId("collaboration-workspace-settings-save")).toBeTruthy();
  });

  it("keeps workspace creation and collaboration resources as separate header actions", async () => {
    const { api } = createApi();
    const manageResource = vi.fn();
    await render(<PlatformHarness api={api} manageResource={manageResource} />);

    expect(byTestId("collaboration-workspace-sidebar-create")).toBeTruthy();
    await click(byTestId("collaboration-workspace-section-actions"));
    await click(byTestId("collaboration-manage-agents"));
    await click(byTestId("collaboration-workspace-section-actions"));
    await click(byTestId("collaboration-manage-environments"));

    expect(manageResource).toHaveBeenNthCalledWith(1, "agents");
    expect(manageResource).toHaveBeenNthCalledWith(2, "environments");
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

  it("passes the minimal parent context to a custom restricted project renderer", async () => {
    const restrictedProject = {
      ...project,
      access_role: "RestrictedAnalyst" as const,
    };
    const { api } = createApi({
      initialWorkspaces: [],
      initialProjects: [restrictedProject],
    });
    api.workspaces!.getNavigationContext = vi.fn(async () => ({
      id: workspace.id,
      public_id: "workspace-public",
      location: "cloud",
      name: workspace.name,
    }));
    api.workspaces!.listMembers = vi.fn(async () => {
      throw new Error("Workspace not found");
    });
    api.workspaces!.listAgents = vi.fn(async () => {
      throw new Error("Workspace not found");
    });
    api.workspaces!.listExecutionEnvironments = vi.fn(async () => {
      throw new Error("Workspace not found");
    });
    const renderProject = vi.fn(
      ({ project: renderedProject, workspace: workspaceContext }) => (
        <div data-testid="restricted-custom-project">
          {renderedProject.name}:{workspaceContext.name}
        </div>
      ),
    );

    await render(
      <PlatformHarness
        api={api}
        renderProject={renderProject}
        start={{
          ...initialLocation,
          workspaceId: workspace.id,
          workspaceView: "projects",
          projectId: restrictedProject.id,
          projectView: "board",
        }}
      />,
    );

    expect(byTestId("restricted-custom-project").textContent).toBe(
      `${restrictedProject.name}:${workspace.name}`,
    );
    expect(renderProject).toHaveBeenCalledOnce();
    expect(renderProject).toHaveBeenCalledWith({
      project: restrictedProject,
      workspace: {
        id: workspace.id,
        public_id: "workspace-public",
        location: "cloud",
        name: workspace.name,
      },
    });
    expect(
      container.querySelector('[data-testid="collaboration-board"]'),
    ).toBeNull();
    expect(
      byTestId(`collaboration-workspace-project-${project.id}`),
    ).toBeTruthy();
    expect(api.workspaces!.get).not.toHaveBeenCalled();
    expect(api.workspaces!.getNavigationContext).toHaveBeenCalledWith(
      workspace.id,
    );
    expect(api.workspaces!.listMembers).not.toHaveBeenCalled();
    expect(api.workspaces!.listAgents).not.toHaveBeenCalled();
    expect(api.workspaces!.listExecutionEnvironments).not.toHaveBeenCalled();
    expect(api.resources!.list).not.toHaveBeenCalled();

    const parentContext = byTestId(
      "collaboration-project-parent-workspace-context",
    );
    expect(parentContext.tagName).toBe("DIV");
    const locationBeforeClick = byTestId("test-location").textContent;
    await click(parentContext);
    expect(byTestId("test-location").textContent).toBe(locationBeforeClick);
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(api.workspaces!.listMembers).not.toHaveBeenCalled();
  });

  it("keeps the default restricted project renderer and management tabs hidden", async () => {
    const restrictedProject = {
      ...project,
      access_role: "RestrictedAnalyst" as const,
    };
    const otherProject = {
      ...project,
      id: "project-2",
      public_id: "project-public-2",
      project_key: "OTHER",
      name: "其他已授权项目",
    };
    const { api } = createApi({
      initialWorkspaces: [],
      initialProjects: [restrictedProject, otherProject],
      initialIssues: [],
    });
    api.workspaces!.getNavigationContext = vi.fn(async () => ({
      id: workspace.id,
      public_id: "workspace-public",
      location: "cloud",
      name: workspace.name,
    }));
    api.projects.list = vi.fn(async (workspaceId?: string) => {
      if (workspaceId) throw new Error("Workspace not found");
      return [restrictedProject, otherProject];
    });

    await render(
      <PlatformHarness
        api={api}
        start={{
          ...initialLocation,
          workspaceId: workspace.id,
          workspaceView: "projects",
          projectId: restrictedProject.id,
          projectView: "board",
        }}
      />,
    );

    expect(byTestId("collaboration-board")).toBeTruthy();
    expect(byTestId("collaboration-empty-project")).toBeTruthy();
    expect(
      container.querySelector('[data-testid="collaboration-tab-files"]'),
    ).toBeNull();
    expect(
      container.querySelector('[data-testid="collaboration-tab-automation"]'),
    ).toBeNull();
    expect(
      container.querySelector('[data-testid="collaboration-tab-manage"]'),
    ).toBeNull();
    expect(
      byTestId("collaboration-project-parent-workspace-context").tagName,
    ).toBe("DIV");
    expect(api.projects.list).not.toHaveBeenCalledWith(workspace.id);
    expect(api.projects.list).toHaveBeenCalledTimes(2);
    expect(api.projects.list).toHaveBeenNthCalledWith(1);
    expect(api.projects.list).toHaveBeenNthCalledWith(2);
    expect(api.projects.get).not.toHaveBeenCalledWith(otherProject.id);
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });

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

    expect(
      byTestId("collaboration-workspace-nav-projects").textContent,
    ).toContain(newWorkspace.name);
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
    await click(byTestId("collaboration-workspace-nav-projects"));
    expect(
      container.querySelector(
        `[data-testid="collaboration-project-card-${project.id}"]`,
      ),
    ).toBeNull();
    await click(byTestId(`collaboration-workspace-project-${project.id}`));
    expect(byTestId("collaboration-tab-board")).toBeTruthy();

    await click(byTestId("collaboration-tab-table"));
    expect(byTestId("collaboration-issue-table")).toBeTruthy();
    await click(
      byTestId(`collaboration-issue-table-row-${issue.id}`).querySelector(
        "button",
      )!,
    );
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

    await click(byTestId("collaboration-issue-mention-trigger"));
    await click(
      byTestId(`collaboration-issue-mention-member-${member.user_id}`),
    );
    await change(comment, `@${member.user_name} 请处理交互设计`);
    await click(byTestId("collaboration-issue-comment-submit"));
    expect(api.assignments?.create).toHaveBeenLastCalledWith(issue.id, {
      targetType: "human",
      targetId: String(member.user_id),
      workflowStep: null,
      commentBody: `@${member.user_name} 请处理交互设计`,
      notifyTarget: true,
    });

    await click(byTestId("collaboration-issue-mention-trigger"));
    await click(byTestId(`collaboration-issue-mention-agent-${agent.id}`));
    await change(comment, `@${agent.name} 请开始实现`);
    await click(byTestId("collaboration-issue-comment-submit"));
    expect(api.assignments?.create).toHaveBeenLastCalledWith(issue.id, {
      targetType: "agent",
      targetId: agent.id,
      workflowStep: null,
      commentBody: `@${agent.name} 请开始实现`,
      notifyTarget: false,
    });
  });

  it("configures project members and environments before creating selected agents", async () => {
    const { api } = createApi({ initialProjects: [] });
    const environmentConfigured = deferred<CollaborationExecutionEnvironment>();
    api.members.list = emptyAsync([]);
    api.projects.addExecutionEnvironment = vi.fn(
      () => environmentConfigured.promise,
    );
    api.agents.create = vi.fn(async () => agent);
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
    await click(checkboxWithLabel(member.user_name));
    await click(checkboxWithLabel(agent.name));
    await click(checkboxWithLabel(environment.name));
    await click(byTestId("collaboration-project-create-confirm"));

    expect(api.members.add).toHaveBeenCalledWith(
      project.id,
      member.user_id,
      "Developer",
    );
    expect(api.projects.addExecutionEnvironment).toHaveBeenCalledWith(
      project.id,
      environment.device_id,
    );
    expect(api.agents.create).not.toHaveBeenCalled();

    environmentConfigured.resolve(environment);
    await flush();

    expect(api.agents.create).toHaveBeenCalledWith(
      project.id,
      createWegentProjectAgentInput(agent),
    );
  });

  it("does not create project agents when member or environment setup fails", async () => {
    const { api } = createApi({ initialProjects: [] });
    api.projects.addExecutionEnvironment = vi.fn(async () => {
      throw new Error("environment setup failed");
    });
    api.agents.create = vi.fn(async () => agent);
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
    await click(checkboxWithLabel(agent.name));
    await click(checkboxWithLabel(environment.name));
    await click(byTestId("collaboration-project-create-confirm"));

    expect(api.projects.addExecutionEnvironment).toHaveBeenCalledWith(
      project.id,
      environment.device_id,
    );
    expect(api.agents.create).not.toHaveBeenCalled();
    expect(container.querySelector('[role="alert"]')).not.toBeNull();
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
        issue={{
          ...issue,
          can_edit: false,
          can_view_detail: true,
          permissions: {
            ...issue.permissions!,
            edit_content: false,
            assign: false,
          },
        }}
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
      container.querySelector(
        '[data-testid="collaboration-assignment-target"]',
      ),
    ).toBeNull();
    await click(byTestId("cloud-todo-create-task"));
    expect(onCreateTask).toHaveBeenCalledOnce();
  });
});
