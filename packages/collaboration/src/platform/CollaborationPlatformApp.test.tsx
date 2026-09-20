// @vitest-environment jsdom

// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { act, useState, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { IssueDetail } from "../IssueDetail";
import { ResourceDestinationDialog } from "./ResourceDestinationDialog";
import { collaborationMessages, type CollaborationLocale } from "../i18n";
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
import { useCollaborationPlatformController } from "./useCollaborationPlatformController";

const workspace: CollaborationWorkspace = {
  id: "workspace-1",
  location: "cloud",
  name: "研发协作空间",
  description: "产品与研发共同交付",
  namespace: "default",
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

const localWorkspace: CollaborationWorkspace = {
  ...workspace,
  id: "wework-local-workspace",
  location: "local",
  name: "本地空间",
  namespace: "local",
  project_count: 0,
};

const groupWorkspace: CollaborationWorkspace = {
  ...workspace,
  id: "workspace-group",
  name: "平台团队空间",
  namespace: "platform-team",
  project_count: 0,
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
  initialResources,
}: {
  initialWorkspaces?: CollaborationWorkspace[];
  initialProjects?: CollaborationProject[];
  initialIssues?: CollaborationIssue[];
  initialResources?: {
    agents: CollaborationOwnedAgent[];
    execution_environments: CollaborationExecutionEnvironment[];
  };
} = {}) {
  const workspaces = [...initialWorkspaces];
  const projects = [...initialProjects];
  const workspaceMembers = [member];
  const workspaceAgents = [agent];
  const collaborationGroups: import("../types").CollaborationGroup[] = [];
  const workspaceEnvironments = [environment];
  const personalResources = initialResources ?? {
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
      listCollaborationGroups: vi.fn(async () => [...collaborationGroups]),
      createCollaborationGroup: vi.fn(
        async (
          workspaceId: string,
          input: {
            name: string;
            description?: string;
            leader: { kind: "human" | "agent"; id: string };
            members: Array<{ kind: "human" | "agent"; id: string }>;
            coordinationMode: "manager";
            policy: {
              prompt: string;
              triggerType: "manual" | "schedule" | "event";
              eventType: string | null;
              eventConfig: Record<string, unknown>;
              cronExpression: string | null;
              timezone: string;
              issueSelector: Record<string, unknown>;
              outputPolicy: Record<string, unknown>;
              enabled: boolean;
            };
          },
        ) => {
          const group: import("../types").CollaborationGroup = {
            id: `group-${collaborationGroups.length + 1}`,
            workspace_id: workspaceId,
            owner_type: "workspace",
            owner_id: workspaceId,
            name: input.name,
            description: input.description ?? "",
            leader: input.leader,
            members: input.members,
            coordination_mode: input.coordinationMode,
            policy: {
              prompt: input.policy.prompt,
              trigger_type: input.policy.triggerType,
              event_type: input.policy.eventType,
              event_config: input.policy.eventConfig,
              cron_expression: input.policy.cronExpression,
              timezone: input.policy.timezone,
              issue_selector: input.policy.issueSelector,
              output_policy: input.policy.outputPolicy,
              enabled: input.policy.enabled,
            },
            version: 1,
            created_by_user_id: 1,
            created_at: "2026-09-14T00:00:00Z",
            updated_at: "2026-09-14T00:00:00Z",
          };
          collaborationGroups.push(group);
          return group;
        },
      ),
      updateCollaborationGroup: vi.fn(),
      removeCollaborationGroup: vi.fn(
        async (_workspaceId: string, groupId: string) => {
          const index = collaborationGroups.findIndex(
            (group) => group.id === groupId,
          );
          if (index >= 0) collaborationGroups.splice(index, 1);
        },
      ),
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

function portalByTestId(testId: string): HTMLElement {
  const element = document.body.querySelector<HTMLElement>(
    `[data-testid="${testId}"]`,
  );
  expect(element, `Missing portal data-testid=${testId}`).not.toBeNull();
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
  cloudAccess,
  api,
  navigationApis,
  start = initialLocation,
  locale = "zh-CN",
  onReady,
  notify,
  manageResource,
  renderDeviceCreator,
  renderProject,
  workspaceOwnerOptions,
  defaultAssistant,
  capabilities = { automation: false, dingtalkAitable: false },
}: {
  api: SharedWorkspaceApi;
  navigationApis?: SharedWorkspaceApi[];
  cloudAccess?: CollaborationPlatformHostAdapter["cloudAccess"];
  start?: CollaborationPlatformLocation;
  locale?: CollaborationLocale;
  onReady?(): void;
  notify?: CollaborationPlatformHostAdapter["notify"];
  manageResource?: CollaborationPlatformHostAdapter["manageResource"];
  renderDeviceCreator?: CollaborationPlatformHostAdapter["renderDeviceCreator"];
  renderProject?(context: CollaborationProjectRendererContext): ReactNode;
  workspaceOwnerOptions?: CollaborationPlatformHostAdapter["workspaceOwnerOptions"];
  defaultAssistant?: CollaborationPlatformHostAdapter["defaultAssistant"];
  capabilities?: CollaborationPlatformHostAdapter["capabilities"];
}) {
  const [location, setLocation] = useState(start);
  const host: CollaborationPlatformHostAdapter = {
    cloudAccess,
    location,
    capabilities,
    navigate: setLocation,
    manageResource,
    renderDeviceCreator,
    notify,
    workspaceOwnerOptions,
    defaultAssistant,
  };
  return (
    <>
      <output data-testid="test-location">{JSON.stringify(location)}</output>
      <CollaborationPlatformApp
        api={api}
        navigationApis={navigationApis}
        host={host}
        locale={locale}
        onReady={onReady}
        renderProject={renderProject}
      />
    </>
  );
}

function PlatformControllerHarness({
  api,
  navigationApis,
  location = initialLocation,
}: {
  api: SharedWorkspaceApi;
  navigationApis?: SharedWorkspaceApi[];
  location?: CollaborationPlatformLocation;
}) {
  const { state } = useCollaborationPlatformController({
    api,
    navigationApis,
    location,
    loadFailedMessage: "加载协作空间失败",
  });
  return (
    <output data-testid="platform-controller-state">
      {JSON.stringify({
        loading: state.loading,
        error: state.error,
        workspaceIds: state.workspaces.map((candidate) => candidate.id),
        projectIds: state.projects.map((candidate) => candidate.id),
        myWork: state.myWork,
        executions: state.executions,
      })}
    </output>
  );
}

const originalGetAnimations = Element.prototype.getAnimations;
beforeEach(() => {
  Object.defineProperty(Range.prototype, "getClientRects", {
    configurable: true,
    value: () => [],
  });
  Object.defineProperty(Range.prototype, "getBoundingClientRect", {
    configurable: true,
    value: () => new DOMRect(),
  });
  Element.prototype.getAnimations = vi.fn(() => []);
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
  if (originalGetAnimations)
    Element.prototype.getAnimations = originalGetAnimations;
  else Reflect.deleteProperty(Element.prototype, "getAnimations");
});

describe("CollaborationPlatformApp real component flow", () => {
  it.each(["local", "backend"] as const)(
    "returns to the space after archiving the open %s project",
    async (store) => {
      const { api, projects, workspaces } = createApi();
      const space = store === "local" ? localWorkspace : workspace;
      workspaces.splice(0, workspaces.length, space);
      projects[0] = {
        ...project,
        project_store: store,
        workspace_id: space.id,
      };
      const request = deferred<void>();
      api.projects.archive = vi.fn(async () => {
        await request.promise;
        projects.splice(0, 1);
      });
      await render(
        <PlatformHarness
          api={api}
          start={{
            ...initialLocation,
            workspaceId: space.id,
            projectId: project.id,
          }}
          renderProject={() => <div>Project board</div>}
        />,
      );
      await click(byTestId(`collaboration-project-menu-${project.id}`));
      await click(
        portalByTestId(`collaboration-project-archive-${project.id}`),
      );
      await click(byTestId("collaboration-project-archive-confirm"));
      expect(
        byTestId("collaboration-project-archive-confirm").hasAttribute(
          "disabled",
        ),
      ).toBe(true);
      expect(
        byTestId(`collaboration-workspace-project-${project.id}`),
      ).toBeTruthy();
      await act(async () => request.resolve());
      await flush();
      expect(api.projects.archive).toHaveBeenCalledOnce();
      const location = JSON.parse(byTestId("test-location").textContent!);
      expect(location.projectId).toBeNull();
      expect(location.workspaceId).toBe(space.id);
      expect(location.workspaceView).toBe("projects");
      expect(
        container.querySelector(
          `[data-testid="collaboration-workspace-project-${project.id}"]`,
        ),
      ).toBeNull();
    },
  );
  it("confirms archive, keeps failures retryable and removes only the archived project", async () => {
    const { api, projects } = createApi();
    const archive = vi
      .fn()
      .mockRejectedValueOnce(new Error("Version conflict"))
      .mockImplementation(async () => {
        projects.splice(0, 1);
      });
    api.projects.archive = archive;
    await render(<PlatformHarness api={api} />);
    await click(byTestId(`collaboration-project-menu-${project.id}`));
    await click(portalByTestId(`collaboration-project-archive-${project.id}`));
    expect(
      byTestId("collaboration-project-archive-dialog").textContent,
    ).toContain(project.name);
    await click(byTestId("collaboration-project-archive-cancel"));
    expect(archive).not.toHaveBeenCalled();
    await click(byTestId(`collaboration-project-menu-${project.id}`));
    await click(portalByTestId(`collaboration-project-archive-${project.id}`));
    await click(byTestId("collaboration-project-archive-confirm"));
    expect(
      byTestId("collaboration-project-archive-dialog").textContent,
    ).toContain("Version conflict");
    expect(
      byTestId(`collaboration-workspace-project-${project.id}`),
    ).toBeTruthy();
    await click(byTestId("collaboration-project-archive-confirm"));
    expect(archive).toHaveBeenLastCalledWith(project.id, project.version);
    expect(
      container.querySelector(
        '[data-testid="collaboration-project-archive-dialog"]',
      ),
    ).toBeNull();
    expect(
      container.querySelector(
        `[data-testid="collaboration-workspace-project-${project.id}"]`,
      ),
    ).toBeNull();
  });

  it("hides archive for read-only cloud members", async () => {
    const { api, projects } = createApi();
    projects[0] = { ...project, access_role: "Reporter" };
    await render(<PlatformHarness api={api} />);
    expect(
      byTestId(`collaboration-workspace-project-${project.id}`),
    ).toBeTruthy();
    expect(
      container.querySelector(
        `[data-testid="collaboration-project-menu-${project.id}"]`,
      ),
    ).toBeNull();
  });
  it.each(["agents", "devices"] as const)(
    "uses a real accessible settings icon in the %s catalog",
    async (kind) => {
      const { api } = createApi();
      const manageResource = vi.fn();
      await render(
        <PlatformHarness api={api} manageResource={manageResource} />,
      );
      await click(byTestId(`collaboration-primary-${kind}`));
      const button = byTestId(
        `collaboration-${kind}-page`,
      ).querySelector<HTMLButtonElement>(
        ".collaboration-resource-settings-button",
      )!;
      expect(button).not.toBeNull();
      expect(button.textContent).toBe("");
      expect(button.getAttribute("aria-label")).toBe("设置");
      expect(button.getAttribute("title")).toBe("设置");
      expect(button.querySelector('svg[aria-hidden="true"]')).not.toBeNull();
      await click(button);
      expect(manageResource).toHaveBeenCalledOnce();
    },
  );
  it.each(["zh-CN", "en"] as const)(
    "does not present Runtime as an agent attribute in %s",
    async (locale) => {
      const { api } = createApi();
      await render(<PlatformHarness api={api} locale={locale} />);
      await click(byTestId("collaboration-primary-agents"));
      const page = byTestId("collaboration-agents-page");
      expect(page.textContent?.toLowerCase()).not.toContain("runtime");
      expect(
        page.querySelector(".collaboration-resource-row-runtime"),
      ).toBeNull();
      expect(
        page.querySelector(".collaboration-resource-row-copy small"),
      ).toBeNull();
      expect(
        page.querySelector(".collaboration-resource-catalog-list-header")
          ?.children.length,
      ).toBe(5);
      await change(
        byTestId("collaboration-agents-search") as HTMLInputElement,
        "no-matching-agent",
      );
      expect(page.textContent?.toLowerCase()).not.toContain("runtime");
    },
  );
  it("explains how agent availability is determined", async () => {
    const unavailableAgent = {
      ...agent,
      id: "agent-unavailable",
      team_id: 13,
      name: "配置失效智能体",
      status: "unavailable" as const,
    };
    const { api } = createApi({
      initialResources: {
        agents: [agent, unavailableAgent],
        execution_environments: [environment],
      },
    });
    await render(<PlatformHarness api={api} />);

    await click(byTestId("collaboration-primary-agents"));

    expect(
      byTestId(`collaboration-agents-row-${agent.id}`)
        .querySelector(".collaboration-resource-row-status")
        ?.getAttribute("title"),
    ).toBe("配置完整，成员角色、执行方式和模型均可正常解析。");
    expect(
      byTestId(`collaboration-agents-row-${unavailableAgent.id}`)
        .querySelector(".collaboration-resource-row-status")
        ?.getAttribute("title"),
    ).toBe("智能体已停用，或成员角色、执行方式、模型配置缺失或失效。");
  });
  it("tracks the selected workspace when navigating between spaces and root pages", async () => {
    const { api } = createApi({
      initialWorkspaces: [localWorkspace, workspace],
    });
    await render(<PlatformHarness api={api} />);
    const row = (id: string) =>
      byTestId(`collaboration-workspace-tree-${id}`).querySelector(
        ".collaboration-workspace-row",
      )!;
    await click(byTestId(`collaboration-workspace-home-${localWorkspace.id}`));
    expect(row(localWorkspace.id).classList.contains("active")).toBe(true);
    expect(
      row(localWorkspace.id)
        .querySelector(".collaboration-workspace-identity")
        ?.getAttribute("aria-current"),
    ).toBe("page");
    await click(byTestId(`collaboration-workspace-home-${workspace.id}`));
    expect(row(workspace.id).classList.contains("active")).toBe(true);
    expect(row(localWorkspace.id).classList.contains("active")).toBe(false);
    await click(byTestId("collaboration-primary-agents"));
    expect(row(workspace.id).classList.contains("active")).toBe(false);
    expect(
      row(workspace.id)
        .querySelector(".collaboration-workspace-identity")
        ?.hasAttribute("aria-current"),
    ).toBe(false);
  });
  it.each(["agents", "teams", "devices"] as const)(
    "requires cloud login before creating %s",
    async (kind) => {
      const { api } = createApi({
        initialWorkspaces: [localWorkspace, workspace, groupWorkspace],
      });
      const requestLogin = vi.fn();
      const renderDeviceCreator = vi.fn(() => null);
      const props = { api, renderDeviceCreator };
      await render(
        <PlatformHarness
          {...props}
          cloudAccess={{ authenticated: false, requestLogin }}
        />,
      );
      await click(byTestId(`collaboration-primary-${kind}`));
      await click(byTestId(`collaboration-${kind}-create`));
      expect(
        container.querySelector(
          `[data-testid="collaboration-${kind}-create-cloud-personal"]`,
        ),
      ).toBeNull();
      expect(
        container.querySelector(
          `[data-testid="collaboration-${kind}-create-workspace-${groupWorkspace.id}"]`,
        ),
      ).toBeNull();
      expect(
        Boolean(
          container.querySelector(
            `[data-testid="collaboration-${kind}-create-local"]`,
          ),
        ),
      ).toBe(kind !== "devices");
      await click(byTestId(`collaboration-${kind}-create-cloud-login`));
      expect(requestLogin).toHaveBeenCalledOnce();
      expect(renderDeviceCreator).not.toHaveBeenCalled();
      expect(
        container.querySelector('[data-testid="resource-destination-dialog"]'),
      ).toBeNull();

      await render(
        <PlatformHarness
          {...props}
          cloudAccess={{ authenticated: true, requestLogin }}
        />,
      );
      await click(byTestId(`collaboration-${kind}-create`));
      expect(
        byTestId(`collaboration-${kind}-create-cloud-personal`),
      ).toBeTruthy();
      expect(
        container.querySelector(
          `[data-testid="collaboration-${kind}-create-cloud-login"]`,
        ),
      ).toBeNull();
      await render(
        <PlatformHarness
          {...props}
          cloudAccess={{ authenticated: false, requestLogin }}
        />,
      );
      expect(
        container.querySelector(
          `[data-testid="collaboration-${kind}-create-cloud-personal"]`,
        ),
      ).toBeNull();
      expect(byTestId(`collaboration-${kind}-create-cloud-login`)).toBeTruthy();
    },
  );
  it.each(["agents", "teams", "devices"])(
    "renders %s destinations solely from parameters",
    async (kind) => {
      const selected = vi.fn();
      const closed = vi.fn();
      const disabledSelected = vi.fn();
      await render(
        <ResourceDestinationDialog
          title={kind}
          description="Choose an owner"
          closeLabel="Close"
          options={[
            {
              id: "ready",
              testId: "destination-ready",
              label: "Ready",
              description: "Available",
              icon: null,
              onSelect: selected,
            },
            {
              id: "blocked",
              testId: "destination-blocked",
              label: "Blocked",
              description: "Requires a space",
              icon: null,
              disabled: true,
              onSelect: disabledSelected,
            },
          ]}
          onClose={closed}
        />,
      );
      expect(document.activeElement).toBe(
        byTestId("resource-destination-close"),
      );
      expect(
        (byTestId("destination-blocked") as HTMLButtonElement).disabled,
      ).toBe(true);
      await click(byTestId("destination-blocked"));
      expect(disabledSelected).not.toHaveBeenCalled();
      expect(closed).not.toHaveBeenCalled();
      await click(byTestId("destination-ready"));
      expect(selected).toHaveBeenCalledOnce();
      expect(closed).toHaveBeenCalledOnce();
      await act(async () => {
        byTestId("resource-destination-dialog").dispatchEvent(
          new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
        );
      });
      expect(closed).toHaveBeenCalledTimes(2);
    },
  );

  it("keeps the same owner choices for agents and teams without cloud spaces", async () => {
    const { api } = createApi({ initialWorkspaces: [localWorkspace] });
    await render(
      <PlatformHarness
        api={api}
        workspaceOwnerOptions={[
          { namespace: "engineering", label: "Engineering" },
        ]}
      />,
    );
    for (const kind of ["agents", "teams"]) {
      await click(byTestId(`collaboration-primary-${kind}`));
      await click(byTestId(`collaboration-${kind}-create`));
      expect(byTestId(`collaboration-${kind}-create-local`)).toBeTruthy();
      expect(
        byTestId(`collaboration-${kind}-create-cloud-personal`),
      ).toBeTruthy();
      expect(
        byTestId(`collaboration-${kind}-create-owner-engineering`),
      ).toBeTruthy();
      expect(
        (
          byTestId(
            `collaboration-${kind}-create-cloud-personal`,
          ) as HTMLButtonElement
        ).disabled,
      ).toBe(kind === "teams");
      expect(byTestId("resource-destination-dialog").textContent).not.toContain(
        "暂无可用空间",
      );
      await click(byTestId("resource-destination-close"));
      expect(byTestId("test-location").textContent).toContain(
        `"rootView":"${kind}"`,
      );
    }
  });
  it("renders completed navigation sources while another source is still pending", async () => {
    const localWorkspace = {
      ...workspace,
      id: "local-workspace",
      location: "local" as const,
    };
    const localProject = {
      ...project,
      id: "local-project",
      workspace_id: localWorkspace.id,
      project_store: "local" as const,
    };
    const cloudWorkspace = { ...workspace, id: "cloud-workspace" };
    const cloudProject = {
      ...project,
      id: "cloud-project",
      workspace_id: cloudWorkspace.id,
    };
    const { api: localApi } = createApi({
      initialWorkspaces: [localWorkspace],
      initialProjects: [localProject],
    });
    const { api: cloudApi } = createApi({
      initialWorkspaces: [cloudWorkspace],
      initialProjects: [cloudProject],
    });
    const cloudWorkspaces = deferred<CollaborationWorkspace[]>();
    const cloudProjects = deferred<CollaborationProject[]>();
    cloudApi.workspaces!.list = vi.fn(() => cloudWorkspaces.promise);
    cloudApi.projects.list = vi.fn(() => cloudProjects.promise);

    await render(
      <PlatformControllerHarness
        api={localApi}
        navigationApis={[localApi, cloudApi]}
      />,
    );

    expect(
      JSON.parse(byTestId("platform-controller-state").textContent ?? "{}"),
    ).toMatchObject({
      loading: false,
      error: null,
      workspaceIds: [localWorkspace.id],
      projectIds: [localProject.id],
    });

    cloudWorkspaces.resolve([cloudWorkspace]);
    cloudProjects.resolve([cloudProject]);
    await flush();

    expect(
      JSON.parse(byTestId("platform-controller-state").textContent ?? "{}"),
    ).toMatchObject({
      loading: false,
      error: null,
      workspaceIds: [localWorkspace.id, cloudWorkspace.id],
      projectIds: [localProject.id, cloudProject.id],
    });
  });

  it("loads every navigation source when restoring a project deep link", async () => {
    const localWorkspace = {
      ...workspace,
      id: "local-workspace",
      location: "local" as const,
    };
    const localProject = {
      ...project,
      id: "local-project",
      workspace_id: localWorkspace.id,
      project_store: "local" as const,
    };
    const cloudWorkspace = { ...workspace, id: "cloud-workspace" };
    const cloudProject = {
      ...project,
      id: "cloud-project",
      workspace_id: cloudWorkspace.id,
    };
    const { api: localApi } = createApi({
      initialWorkspaces: [localWorkspace],
      initialProjects: [localProject],
    });
    const { api: cloudApi } = createApi({
      initialWorkspaces: [cloudWorkspace],
      initialProjects: [cloudProject],
    });

    await render(
      <PlatformControllerHarness
        api={localApi}
        navigationApis={[localApi, cloudApi]}
        location={{
          ...initialLocation,
          workspaceId: cloudWorkspace.id,
          projectId: cloudProject.id,
        }}
      />,
    );

    expect(
      JSON.parse(byTestId("platform-controller-state").textContent ?? "{}"),
    ).toMatchObject({
      loading: false,
      error: null,
      workspaceIds: [localWorkspace.id, cloudWorkspace.id],
      projectIds: [cloudProject.id],
    });
    expect(localApi.projects.list).toHaveBeenCalled();
    expect(cloudApi.projects.list).toHaveBeenCalled();
  });

  it("reports an incomplete deep-link load when the target project is missing", async () => {
    const localWorkspace = {
      ...workspace,
      id: "local-workspace",
      location: "local" as const,
    };
    const localProject = {
      ...project,
      id: "local-project",
      workspace_id: localWorkspace.id,
      project_store: "local" as const,
    };
    const cloudWorkspace = { ...workspace, id: "cloud-workspace" };
    const cloudProject = {
      ...project,
      id: "cloud-project",
      workspace_id: cloudWorkspace.id,
    };
    const { api: localApi } = createApi({
      initialWorkspaces: [localWorkspace],
      initialProjects: [localProject],
    });
    const { api: cloudApi } = createApi({
      initialWorkspaces: [cloudWorkspace],
      initialProjects: [cloudProject],
    });
    cloudApi.projects.list = vi
      .fn()
      .mockRejectedValue(new Error("cloud projects unavailable"));

    await render(
      <PlatformControllerHarness
        api={localApi}
        navigationApis={[localApi, cloudApi]}
        location={{
          ...initialLocation,
          workspaceId: cloudWorkspace.id,
          projectId: cloudProject.id,
        }}
      />,
    );

    expect(
      JSON.parse(byTestId("platform-controller-state").textContent ?? "{}"),
    ).toMatchObject({
      loading: false,
      error: "加载协作空间失败",
    });
  });

  it("keeps successful workspaces when projects from the same source fail", async () => {
    const cloudWorkspace = { ...workspace, id: "cloud-workspace" };
    const { api } = createApi({
      initialWorkspaces: [cloudWorkspace],
      initialProjects: [],
    });
    api.projects.list = vi
      .fn()
      .mockRejectedValue(new Error("projects offline"));

    await render(<PlatformControllerHarness api={api} />);

    expect(
      JSON.parse(byTestId("platform-controller-state").textContent ?? "{}"),
    ).toMatchObject({
      loading: false,
      error: null,
      workspaceIds: [cloudWorkspace.id],
      projectIds: [],
    });

    await render(
      <PlatformControllerHarness
        api={api}
        location={{ ...initialLocation, workspaceId: cloudWorkspace.id }}
      />,
    );

    expect(api.workspaces!.list).toHaveBeenCalledTimes(2);
    expect(api.projects.list).toHaveBeenCalledTimes(2);
  });

  it("enters a cached local workspace without retrying an unavailable cloud source", async () => {
    const localWorkspace = {
      ...workspace,
      id: "local-workspace",
      location: "local" as const,
    };
    const localProject = {
      ...project,
      id: "local-project",
      workspace_id: localWorkspace.id,
      project_store: "local" as const,
    };
    const { api: localApi } = createApi({
      initialWorkspaces: [localWorkspace],
      initialProjects: [localProject],
    });
    const { api: cloudApi } = createApi({
      initialWorkspaces: [],
      initialProjects: [],
    });
    cloudApi.workspaces!.list = vi
      .fn()
      .mockRejectedValue(new Error("cloud unavailable"));
    cloudApi.projects.list = vi
      .fn()
      .mockRejectedValue(new Error("cloud unavailable"));

    await render(
      <PlatformControllerHarness
        api={localApi}
        navigationApis={[localApi, cloudApi]}
      />,
    );
    expect(cloudApi.workspaces.list).toHaveBeenCalledOnce();
    expect(cloudApi.projects.list).toHaveBeenCalledOnce();

    await render(
      <PlatformControllerHarness
        api={localApi}
        navigationApis={[localApi, cloudApi]}
        location={{ ...initialLocation, workspaceId: localWorkspace.id }}
      />,
    );

    expect(cloudApi.workspaces.list).toHaveBeenCalledOnce();
    expect(cloudApi.projects.list).toHaveBeenCalledOnce();
    expect(
      JSON.parse(byTestId("platform-controller-state").textContent ?? "{}"),
    ).toMatchObject({
      loading: false,
      error: null,
      workspaceIds: [localWorkspace.id],
      projectIds: [localProject.id],
    });
  });

  it("keeps an emptied local workspace covered after archiving its final project", async () => {
    const cachedLocalWorkspace = {
      ...localWorkspace,
      project_count: 1,
    };
    const otherLocalWorkspace = {
      ...localWorkspace,
      id: "other-local-workspace",
      name: "另一个本地空间",
    };
    const localProject = {
      ...project,
      id: "local-project",
      workspace_id: cachedLocalWorkspace.id,
      project_store: "local" as const,
    };
    const { api: localApi, projects } = createApi({
      initialWorkspaces: [cachedLocalWorkspace, otherLocalWorkspace],
      initialProjects: [localProject],
    });
    localApi.projects.archive = vi.fn(async () => {
      projects.splice(0, 1);
    });
    const { api: cloudApi } = createApi({
      initialWorkspaces: [],
      initialProjects: [],
    });
    cloudApi.workspaces!.list = vi
      .fn()
      .mockRejectedValue(new Error("cloud unavailable"));
    cloudApi.projects.list = vi
      .fn()
      .mockRejectedValue(new Error("cloud unavailable"));

    await render(
      <PlatformHarness
        api={localApi}
        navigationApis={[localApi, cloudApi]}
        start={{
          ...initialLocation,
          workspaceId: cachedLocalWorkspace.id,
          projectId: localProject.id,
        }}
        renderProject={() => <div>Project board</div>}
      />,
    );
    expect(cloudApi.workspaces.list).toHaveBeenCalledOnce();
    expect(cloudApi.projects.list).toHaveBeenCalledOnce();
    await click(byTestId(`collaboration-project-menu-${localProject.id}`));
    await click(
      portalByTestId(`collaboration-project-archive-${localProject.id}`),
    );
    await click(byTestId("collaboration-project-archive-confirm"));
    await flush();
    expect(cloudApi.workspaces.list).toHaveBeenCalledOnce();
    expect(cloudApi.projects.list).toHaveBeenCalledOnce();
    await click(
      byTestId(`collaboration-workspace-home-${otherLocalWorkspace.id}`),
    );
    expect(cloudApi.workspaces.list).toHaveBeenCalledOnce();
    expect(cloudApi.projects.list).toHaveBeenCalledOnce();
    await click(
      byTestId(`collaboration-workspace-home-${cachedLocalWorkspace.id}`),
    );

    expect(cloudApi.workspaces.list).toHaveBeenCalledOnce();
    expect(cloudApi.projects.list).toHaveBeenCalledOnce();
    expect(
      JSON.parse(byTestId("test-location").textContent ?? "{}"),
    ).toMatchObject({
      workspaceId: cachedLocalWorkspace.id,
      projectId: null,
    });
  });

  it("reuses a completed empty navigation cache", async () => {
    const { api } = createApi({
      initialWorkspaces: [],
      initialProjects: [],
    });

    await render(<PlatformControllerHarness api={api} />);
    await render(
      <PlatformControllerHarness
        api={api}
        location={{ ...initialLocation, workspaceId: workspace.id }}
      />,
    );

    expect(api.workspaces!.list).toHaveBeenCalledOnce();
    expect(api.projects.list).toHaveBeenCalledOnce();
  });

  it("loads Agent resources on the teams page", async () => {
    const { api } = createApi();

    await render(
      <PlatformControllerHarness
        api={api}
        location={{ ...initialLocation, rootView: "teams" }}
      />,
    );

    expect(api.resources!.list).toHaveBeenCalledOnce();
  });

  it("loads only run data alongside navigation on the runs page", async () => {
    const { api } = createApi();
    const listMyWork = vi
      .fn()
      .mockRejectedValue(new Error("my work unavailable"));
    const listExecutions = vi
      .fn()
      .mockRejectedValue(new Error("runs unavailable"));
    api.myWork = { list: listMyWork };
    api.executions.list = listExecutions;

    await render(
      <PlatformControllerHarness
        api={api}
        location={{ ...initialLocation, rootView: "runs" }}
      />,
    );

    const state = JSON.parse(
      byTestId("platform-controller-state").textContent ?? "{}",
    );
    expect(listMyWork).not.toHaveBeenCalled();
    expect(listExecutions).toHaveBeenCalledWith(project.id, {
      includeTerminal: true,
    });
    expect(state).toEqual({
      loading: false,
      error: null,
      workspaceIds: [workspace.id],
      projectIds: [project.id],
      myWork: [],
      executions: [],
    });
  });

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
    expect(byTestId("collaboration-issue-home")).toBeTruthy();
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

  it("opens the project composer from the trailing action without a project folder icon", async () => {
    const { api } = createApi();
    await render(<PlatformHarness api={api} />);
    const projectButton = byTestId(
      `collaboration-workspace-project-${project.id}`,
    );
    expect(projectButton.querySelector("svg")).toBeNull();
    await click(projectButton);
    await click(
      byTestId(`collaboration-project-new-conversation-${project.id}`),
    );
    expect(byTestId("collaboration-issue-home")).toBeTruthy();
    expect(byTestId("test-location").textContent).toContain(
      '"rootView":"home"',
    );
    expect(byTestId("test-location").textContent).toContain('"projectId":null');
  });

  it("starts the first project from collaboration home and preserves its workspace", async () => {
    const { api } = createApi({ initialProjects: [] });
    await render(<PlatformHarness api={api} />);

    expect(byTestId("collaboration-first-project-starter")).toBeTruthy();
    await click(byTestId("collaboration-first-project-create"));
    await change(
      byTestId("collaboration-project-name-input") as HTMLInputElement,
      project.name,
    );
    await click(byTestId("collaboration-project-create-confirm"));

    expect(api.projects.create).toHaveBeenCalledWith(
      expect.objectContaining({
        name: project.name,
        workspaceId: workspace.id,
      }),
    );
    expect(byTestId("test-location").textContent).toContain(
      `"workspaceId":"${workspace.id}"`,
    );
    expect(byTestId("test-location").textContent).toContain(
      `"projectId":"${project.id}"`,
    );
  });

  it("asks for the owning workspace before creating a project from a multi-space home", async () => {
    const designWorkspace: CollaborationWorkspace = {
      ...workspace,
      id: "workspace-design",
      name: "设计协作空间",
      namespace: "design",
      project_count: 0,
    };
    const { api } = createApi({
      initialWorkspaces: [workspace, designWorkspace],
      initialProjects: [],
    });
    await render(
      <PlatformHarness
        api={api}
        workspaceOwnerOptions={[
          { label: "个人", namespace: "default" },
          { label: "设计团队", namespace: "design" },
        ]}
      />,
    );

    await click(byTestId("collaboration-first-project-create"));
    await click(
      byTestId(`collaboration-project-workspace-${designWorkspace.id}`),
    );
    expect(container.textContent).toContain("设计协作空间 · 归属：设计团队");
    await change(
      byTestId("collaboration-project-name-input") as HTMLInputElement,
      project.name,
    );
    await click(byTestId("collaboration-project-create-confirm"));

    expect(api.projects.create).toHaveBeenCalledWith(
      expect.objectContaining({
        name: project.name,
        workspaceId: designWorkspace.id,
      }),
    );
  });

  it("uses the selected workspace location in the project creation dialog", async () => {
    const { api } = createApi({
      initialWorkspaces: [workspace, localWorkspace],
      initialProjects: [],
    });
    await render(
      <PlatformHarness
        api={api}
        capabilities={{
          automation: false,
          dingtalkAitable: false,
          projectLocation: "cloud",
        }}
      />,
    );

    await click(byTestId("collaboration-first-project-create"));
    await click(
      byTestId(`collaboration-project-workspace-${localWorkspace.id}`),
    );

    expect(byTestId("cloud-project-location-local")).toBeTruthy();
    expect(
      container.querySelector('[data-testid="cloud-project-location-cloud"]'),
    ).toBeNull();
    expect(container.textContent).toContain(
      "保存在当前设备，可接入 GitHub 或 GitLab Issues",
    );
    expect(container.textContent).not.toContain("项目可见性");
  });

  it("offers cloud sign-in instead of defaulting the first project to local", async () => {
    const { api } = createApi({
      initialWorkspaces: [localWorkspace],
      initialProjects: [],
    });
    const requestLogin = vi.fn();
    await render(
      <PlatformHarness
        api={api}
        cloudAccess={{ authenticated: false, requestLogin }}
        capabilities={{
          automation: false,
          dingtalkAitable: false,
          projectLocation: "cloud",
          workspaceLocations: ["local", "cloud"],
        }}
      />,
    );

    expect(container.textContent).not.toContain("今天要推进什么？");
    expect(container.textContent).toContain(
      "把一个目标交给成员和智能体，并持续看到推进过程。",
    );
    expect(container.textContent).toContain("记录目标分配协作跟踪结果");
    expect(
      byTestId("collaboration-first-project-create").textContent,
    ).toContain("创建项目");

    await click(byTestId("collaboration-first-project-create"));
    expect(
      byTestId(`collaboration-project-workspace-${localWorkspace.id}`),
    ).toBeTruthy();
    await click(byTestId("collaboration-project-workspace-cloud-login"));
    expect(requestLogin).toHaveBeenCalledOnce();
    expect(
      container.querySelector('[data-testid="cloud-project-location-local"]'),
    ).toBeNull();

    await click(
      byTestId(`collaboration-project-workspace-${localWorkspace.id}`),
    );
    expect(byTestId("cloud-project-location-local")).toBeTruthy();
  });

  it("continues cloud project creation after creating its workspace", async () => {
    const { api } = createApi({
      initialWorkspaces: [localWorkspace],
      initialProjects: [],
    });
    await render(
      <PlatformHarness
        api={api}
        cloudAccess={{ authenticated: true, requestLogin: vi.fn() }}
        capabilities={{
          automation: false,
          dingtalkAitable: false,
          projectLocation: "cloud",
          workspaceLocations: ["local", "cloud"],
        }}
      />,
    );

    await click(byTestId("collaboration-first-project-create"));
    await click(byTestId("collaboration-project-workspace-cloud-create"));
    await change(
      byTestId("collaboration-workspace-name-input") as HTMLInputElement,
      "云端研发空间",
    );
    await click(byTestId("collaboration-workspace-create-confirm"));

    expect(byTestId("cloud-project-location-cloud")).toBeTruthy();
    expect(
      container.querySelector('[data-testid="cloud-project-location-local"]'),
    ).toBeNull();
    expect(container.textContent).toContain("云端研发空间 · 归属：个人");
    expect(container.textContent).toContain("项目可见性");
  });

  it("uses collaboration home as a guided new Issue entry", async () => {
    const { api } = createApi();
    await render(<PlatformHarness api={api} />);

    expect(byTestId("collaboration-issue-home")).toBeTruthy();
    expect(byTestId("collaboration-issue-guide-1").textContent).toContain(
      "拆解一个新需求",
    );
    expect(byTestId("collaboration-issue-guide-2").textContent).toContain(
      "修复一个问题",
    );
    expect(
      (byTestId("collaboration-issue-project") as HTMLSelectElement).value,
    ).toBe(project.id);
    expect(
      (byTestId("collaboration-home-create-issue") as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    await click(byTestId("collaboration-issue-guide-2"));
    expect(byTestId("collaboration-home-issue-content").textContent).toContain(
      "修复一个问题",
    );
    expect(document.activeElement).toBe(
      byTestId("collaboration-home-issue-content"),
    );

    await click(byTestId("collaboration-home-create-issue"));

    expect(api.issues.create).toHaveBeenCalledWith(project.id, {
      title: "修复一个问题：记录现象、复现步骤、影响范围和期望结果。",
      description: "修复一个问题：记录现象、复现步骤、影响范围和期望结果。",
    });
    expect(
      document.querySelector(
        '[data-testid="collaboration-issue-create-dialog"]',
      ),
    ).toBeNull();
  });

  it("saves a selected project team as the Issue owner, not as a numeric agent team", async () => {
    const { api } = createApi();
    api.projects.listCollaborationGroups = vi.fn(
      async () =>
        [
          { id: "squad-1", name: "交付小队" },
        ] as import("../types").CollaborationGroup[],
    );
    await render(<PlatformHarness api={api} />);
    await click(byTestId("collaboration-issue-owner"));
    await click(
      document.querySelector<HTMLElement>(
        '[data-testid="collaboration-issue-owner-group:squad-1"]',
      )!,
    );
    expect(byTestId("collaboration-issue-owner").textContent).toContain(
      "交付小队",
    );
    await click(byTestId("collaboration-issue-guide-2"));
    await click(byTestId("collaboration-home-create-issue"));
    expect(api.issues.update).toHaveBeenCalledWith(
      issue.id,
      expect.objectContaining({ assigneeGroupId: "squad-1" }),
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

    expect(
      container.querySelector(".collaboration-workspace-location-heading"),
    ).toBeNull();
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
    expect(
      byTestId("collaboration-workspace-wework-local-workspace").textContent,
    ).toContain("本地");
    expect(
      byTestId(
        "collaboration-workspace-location-wework-local-workspace",
      ).getAttribute("data-location"),
    ).toBe("local");
    expect(
      byTestId(
        "collaboration-workspace-wework-local-workspace",
      ).parentElement?.querySelector(".lucide-laptop"),
    ).toBeTruthy();
    expect(
      byTestId("collaboration-workspace-workspace-1").textContent,
    ).toContain("云端");
    expect(
      byTestId("collaboration-workspace-location-workspace-1").getAttribute(
        "data-location",
      ),
    ).toBe("cloud");
    expect(
      byTestId(
        "collaboration-workspace-workspace-1",
      ).parentElement?.querySelector(".lucide-cloud"),
    ).toBeTruthy();

    await click(byTestId("collaboration-workspace-create"));
    expect(container.textContent).toContain("保存在 Wegent 云端");
  });

  it("shows Wework primary navigation before the non-collapsible spaces section", async () => {
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

    const sidebar = byTestId("collaboration-platform-sidebar");
    const brand = sidebar.querySelector(".collaboration-platform-brand");
    const navigation = sidebar.querySelector(
      ".collaboration-primary-navigation",
    );
    const spacesTitle = byTestId("collaboration-workspaces-section-title");

    expect(brand?.textContent).toBe("协作空间");
    expect(byTestId("collaboration-primary-home").textContent).toContain(
      "新建 Issue",
    );
    expect(byTestId("collaboration-primary-agents").textContent).toContain(
      "智能体",
    );
    expect(byTestId("collaboration-primary-teams").textContent).toContain(
      "协作小组",
    );
    expect(byTestId("collaboration-primary-devices").textContent).toContain(
      "设备",
    );
    expect(spacesTitle.textContent).toBe("空间");
    expect(
      container.querySelector(
        '[data-testid="collaboration-workspaces-section-toggle"]',
      ),
    ).toBeNull();
    expect(navigation?.compareDocumentPosition(spacesTitle)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );

    await click(byTestId("collaboration-primary-agents"));
    expect(byTestId("collaboration-agents-page")).toBeTruthy();
    expect(byTestId("test-location").textContent).toContain(
      '"rootView":"agents"',
    );
    await click(byTestId("collaboration-agents-filter-local"));
    await click(byTestId("collaboration-agents-create"));
    expect(byTestId("collaboration-agents-create-local")).toBeTruthy();
    await click(byTestId("collaboration-agents-create-local"));
    expect(
      container.querySelector(".collaboration-resource-dialog"),
    ).toBeNull();

    await click(byTestId("collaboration-primary-teams"));
    expect(byTestId("collaboration-teams-page")).toBeTruthy();
    expect(byTestId("test-location").textContent).toContain(
      '"rootView":"teams"',
    );

    await click(byTestId("collaboration-primary-devices"));
    expect(byTestId("collaboration-devices-page")).toBeTruthy();
    expect(byTestId("test-location").textContent).toContain(
      '"rootView":"devices"',
    );

    await click(byTestId(`collaboration-workspace-home-${workspace.id}`));
    await click(byTestId("collaboration-primary-home"));
    expect(byTestId("test-location").textContent).toContain(
      '"workspaceId":null',
    );
    expect(byTestId("test-location").textContent).toContain(
      '"rootView":"home"',
    );
  });

  it("opens the Issue home from a project without reloading navigation", async () => {
    const { api } = createApi();
    const listNavigationProjects = vi.fn(async () => [project]);
    const listNavigationWorkspaces = vi.fn(async () => [workspace]);
    const navigationApi = {
      projects: {
        list: listNavigationProjects,
      },
      workspaces: {
        list: listNavigationWorkspaces,
        listCollaborationGroups: vi.fn(async () => []),
      },
    } as unknown as SharedWorkspaceApi;

    await render(
      <PlatformHarness
        api={api}
        navigationApis={[navigationApi]}
        start={{
          ...initialLocation,
          workspaceId: workspace.id,
          workspaceView: "projects",
          projectId: project.id,
        }}
      />,
    );

    expect(listNavigationProjects).toHaveBeenCalledOnce();
    expect(listNavigationWorkspaces).toHaveBeenCalledOnce();
    await click(byTestId("collaboration-primary-home"));
    await flush();

    expect(byTestId("collaboration-issue-home")).toBeTruthy();
    expect(container.querySelector(".collaboration-loading")).toBeNull();
    expect(listNavigationProjects).toHaveBeenCalledOnce();
    expect(listNavigationWorkspaces).toHaveBeenCalledOnce();
    expect(
      byTestId(`collaboration-workspace-project-${project.id}`),
    ).toBeTruthy();
  });

  it("opens a project from cached navigation without listing navigation again", async () => {
    const { api } = createApi();

    await render(<PlatformHarness api={api} />);

    expect(api.workspaces?.list).toHaveBeenCalledOnce();
    expect(api.projects.list).toHaveBeenCalledOnce();

    await click(byTestId(`collaboration-workspace-project-${project.id}`));

    expect(byTestId("test-location").textContent).toContain(
      `"projectId":"${project.id}"`,
    );
    expect(api.workspaces?.list).toHaveBeenCalledOnce();
    expect(api.projects.list).toHaveBeenCalledOnce();
  });

  it("renders a workspace before project snapshots finish and skips unrelated workspace data", async () => {
    const { api } = createApi();
    const failedIssue = {
      ...issue,
      execution_state: "failed",
    };
    const projectSnapshot = deferred<{
      items: CollaborationIssue[];
      members: CollaborationMember[];
      agents: CollaborationOwnedAgent[];
      taskBindings: [];
    }>();
    api.issues.getBoardSnapshot = vi.fn(() => projectSnapshot.promise);

    await render(
      <PlatformHarness
        api={api}
        start={{ ...initialLocation, workspaceId: workspace.id }}
      />,
    );

    expect(byTestId("collaboration-workspace-home")).toBeTruthy();
    expect(api.issues.getBoardSnapshot).toHaveBeenCalledWith(project.id);
    expect(api.workspaces?.listAgents).not.toHaveBeenCalled();
    expect(api.workspaces?.listCollaborationGroups).not.toHaveBeenCalled();
    expect(api.workspaces?.listExecutionEnvironments).not.toHaveBeenCalled();

    projectSnapshot.resolve({
      items: [failedIssue],
      members: [member],
      agents: [agent],
      taskBindings: [],
    });
    await flush();

    expect(container.textContent).toContain(failedIssue.title);
  });

  it.each([2, 4])(
    "renders %i real team participants without double-counting the leader",
    async (count) => {
      const { api } = createApi();
      const leader = {
        kind: "human" as const,
        id: String(member.user_id),
        responsibility: "",
      };
      vi.mocked(api.workspaces!.listCollaborationGroups).mockResolvedValue([
        {
          id: "group-display",
          workspace_id: workspace.id,
          owner_type: "workspace",
          owner_id: workspace.id,
          description: "",
          stages: [],
          version: 1,
          created_by_user_id: member.user_id,
          created_at: "2026-09-19T00:00:00Z",
          updated_at: "2026-09-19T00:00:00Z",
          name: "Member display regression",
          leader,
          coordination_mode: "manager",
          members: [
            leader,
            ...Array.from({ length: count - 1 }, (_, index) => ({
              kind: "agent" as const,
              id: index === 0 ? leader.id : `agent-${index}`,
              responsibility: "",
            })),
          ],
        },
      ]);
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
      await click(byTestId("collaboration-primary-teams"));
      const page = byTestId("collaboration-teams-page");
      expect(page.textContent).toContain(`${count} 成员`);
      const avatars = page.querySelector(
        ".collaboration-resource-row-members",
      )!;
      expect(avatars.querySelectorAll(":scope > span")).toHaveLength(
        Math.min(count, 3),
      );
      expect(avatars.querySelectorAll("svg")).toHaveLength(Math.min(count, 3));
      expect(avatars.querySelector("em")?.textContent ?? "").toBe(
        count > 3 ? "+1" : "",
      );
      expect(
        page.querySelector(".collaboration-resource-row-leader")?.textContent,
      ).toBe(member.user_name);
      const locationBefore = byTestId("test-location").textContent;
      await click(byTestId("collaboration-teams-settings-group-display"));
      expect(byTestId("collaboration-team-settings-dialog")).toBeTruthy();
      expect(byTestId("collaboration-group-detail-group-display")).toBeTruthy();
      expect(byTestId("test-location").textContent).toBe(locationBefore);
      expect(
        container.querySelector(
          '[data-testid="collaboration-group-detail-back"]',
        ),
      ).toBeNull();
      await click(byTestId("collaboration-team-settings-close"));
      expect(
        container.querySelector(
          '[data-testid="collaboration-team-settings-dialog"]',
        ),
      ).toBeNull();
      expect(byTestId("collaboration-teams-page")).toBeTruthy();
      expect(byTestId("test-location").textContent).toBe(locationBefore);
    },
  );

  it("opens the only local space directly when creating a local team", async () => {
    const { api } = createApi({
      initialWorkspaces: [localWorkspace, workspace, groupWorkspace],
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

    await click(byTestId("collaboration-primary-teams"));
    await click(byTestId("collaboration-teams-filter-local"));
    await click(byTestId("collaboration-teams-create"));
    expect(byTestId("collaboration-teams-create-local")).toBeTruthy();
    expect(byTestId("collaboration-teams-create-cloud-personal")).toBeTruthy();
    expect(
      byTestId(`collaboration-teams-create-workspace-${groupWorkspace.id}`),
    ).toBeTruthy();
    await click(byTestId("collaboration-teams-create-local"));

    expect(byTestId("test-location").textContent).toContain(
      '"workspaceId":null',
    );
    expect(byTestId("test-location").textContent).toContain(
      '"rootView":"teams"',
    );
    expect(byTestId("collaboration-group-form")).toBeTruthy();
  });

  it("shows local and cloud device resources inside collaboration", async () => {
    const { api } = createApi({
      initialWorkspaces: [localWorkspace, workspace, groupWorkspace],
    });
    const manageResource = vi.fn();
    const renderDeviceCreator = vi.fn(
      ({
        source,
        onCreated,
      }: {
        source: "local" | "cloud";
        onCreated(deviceId?: number): Promise<void>;
      }) => (
        <div data-testid="test-device-creator">
          {source}
          <button
            data-testid="test-device-created"
            onClick={() => void onCreated(availableEnvironment.device_id)}
            type="button"
          >
            created
          </button>
        </div>
      ),
    );

    await render(
      <PlatformHarness
        api={api}
        manageResource={manageResource}
        renderDeviceCreator={renderDeviceCreator}
        capabilities={{
          automation: false,
          dingtalkAitable: false,
          workspaceLocations: ["local", "cloud"],
          sidebarPresentation: "full",
        }}
      />,
    );

    await click(byTestId("collaboration-primary-devices"));

    expect(
      container.querySelector(".collaboration-resource-collection-header")
        ?.textContent,
    ).toContain("设备2");
    expect(
      container.querySelector(".collaboration-resource-catalog-list-header")
        ?.textContent,
    ).toContain("运行状态");
    expect(
      container.querySelector(".collaboration-resource-catalog-list-header")
        ?.textContent,
    ).toContain("运行能力");
    expect(
      byTestId("collaboration-devices-filter-local").textContent,
    ).toContain("本地1");
    expect(
      byTestId("collaboration-devices-filter-cloud").textContent,
    ).toContain("云端1");
    expect(byTestId("collaboration-devices-row-environment-2")).toBeTruthy();
    expect(
      byTestId("collaboration-devices-row-environment-2").textContent,
    ).toContain("Claude Code");
    expect(
      byTestId("collaboration-devices-row-environment-2").textContent,
    ).toContain("Codex");
    expect(
      byTestId("collaboration-devices-row-environment-2").textContent,
    ).not.toContain("claude_code");
    expect(
      container.querySelector(
        '[data-testid="collaboration-devices-row-environment-1"]',
      ),
    ).toBeNull();
    await click(byTestId("collaboration-devices-filter-local"));
    expect(byTestId("collaboration-devices-row-environment-1")).toBeTruthy();
    expect(
      container.querySelector(
        '[data-testid="collaboration-devices-scope-all"]',
      ),
    ).toBeNull();
    expect(
      container.querySelector(
        '[data-testid="collaboration-devices-bind-environment-1"]',
      ),
    ).toBeNull();
    expect(
      container.querySelector(
        '[data-testid="collaboration-devices-row-environment-2"]',
      ),
    ).toBeNull();
    await click(byTestId("collaboration-devices-settings-environment-1"));
    expect(manageResource).toHaveBeenLastCalledWith(
      "environments",
      "environment-1",
      "local",
    );
    await click(byTestId("collaboration-devices-create"));
    expect(
      container.querySelector(
        '[data-testid="collaboration-devices-create-local"]',
      ),
    ).toBeNull();
    expect(
      container.querySelector('[role="dialog"]')?.textContent,
    ).not.toContain("暂无可用空间");
    expect(renderDeviceCreator).not.toHaveBeenCalled();
    await click(
      container.querySelector('[role="dialog"] button[aria-label="取消"]')!,
    );

    await click(byTestId("collaboration-devices-filter-cloud"));
    expect(byTestId("collaboration-devices-row-environment-2")).toBeTruthy();
    expect(
      container.querySelector(
        '[data-testid="collaboration-devices-row-environment-1"]',
      ),
    ).toBeNull();

    await click(byTestId("collaboration-devices-create"));
    await click(byTestId("collaboration-devices-create-cloud-personal"));
    expect(renderDeviceCreator).toHaveBeenCalledWith(
      expect.objectContaining({
        source: "cloud",
        hasCloudDevice: true,
      }),
    );
    expect(byTestId("test-device-creator").textContent).toContain("cloud");

    await click(byTestId("collaboration-devices-create"));
    await click(
      byTestId(`collaboration-devices-create-workspace-${groupWorkspace.id}`),
    );
    await click(byTestId("test-device-created"));
    expect(api.workspaces?.addExecutionEnvironment).toHaveBeenCalledWith(
      groupWorkspace.id,
      { deviceId: availableEnvironment.device_id },
    );

    await click(byTestId("collaboration-devices-bind-environment-2"));
    expect(container.querySelector('[role="dialog"]')?.textContent).toContain(
      "空间只引用资源",
    );
    await click(byTestId(`collaboration-devices-space-${workspace.id}`));
    expect(api.workspaces?.addExecutionEnvironment).toHaveBeenCalledWith(
      workspace.id,
      { deviceId: availableEnvironment.device_id },
    );
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
    await render(
      <PlatformHarness
        api={api}
        workspaceOwnerOptions={[
          { label: "个人", namespace: "default" },
          { label: "研发团队", namespace: "engineering" },
        ]}
      />,
    );

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
    await change(
      byTestId("collaboration-workspace-owner-select") as HTMLSelectElement,
      "engineering",
    );
    await click(byTestId("collaboration-workspace-create-confirm"));
    expect(api.workspaces?.create).toHaveBeenCalledWith({
      name: workspace.name,
      description: workspace.description,
      namespace: "engineering",
    });

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
    const workspaceActions = byTestId("collaboration-workspace-actions");
    const workspaceRow = workspaceActions.closest(
      ".collaboration-workspace-row",
    );
    expect(workspaceActions.parentElement?.nextElementSibling).toBe(
      workspaceRow?.querySelector(".collaboration-workspace-toggle"),
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
    await click(byTestId("collaboration-workspace-participants-tab-agents"));
    expect(container.textContent).toContain(agent.name);
    await click(byTestId("collaboration-workspace-nav-execution-environments"));
    expect(container.textContent).toContain(environment.name);
    await click(byTestId("collaboration-workspace-actions"));
    await click(byTestId("collaboration-workspace-nav-settings"));
    expect(byTestId("collaboration-workspace-settings-save")).toBeTruthy();
  });

  it("keeps only workspace creation in the spaces section header", async () => {
    const { api } = createApi();
    const manageResource = vi.fn();
    await render(<PlatformHarness api={api} manageResource={manageResource} />);

    expect(byTestId("collaboration-workspace-sidebar-create")).toBeTruthy();
    expect(
      container.querySelector(
        '[data-testid="collaboration-workspace-section-actions"]',
      ),
    ).toBeNull();
    expect(
      container.querySelector('[data-testid="collaboration-manage-agents"]'),
    ).toBeNull();
    expect(
      container.querySelector(
        '[data-testid="collaboration-manage-environments"]',
      ),
    ).toBeNull();
    expect(manageResource).not.toHaveBeenCalled();
  });

  it("summarizes cross-project operations and opens items that need attention", async () => {
    const runningIssue = {
      ...issue,
      id: "issue-running",
      status: "in_progress",
      execution_state: "running",
    };
    const failedIssue = {
      ...issue,
      id: "issue-failed",
      title: "发布流水线失败",
      execution_state: "failed",
    };
    const { api } = createApi({
      initialIssues: [runningIssue, failedIssue],
    });
    await render(
      <PlatformHarness
        api={api}
        start={{ ...initialLocation, workspaceId: workspace.id }}
      />,
    );

    expect(byTestId("collaboration-workspace-home")).toBeTruthy();
    expect(
      byTestId(`collaboration-workspace-operation-project-${project.id}`),
    ).toBeTruthy();
    expect(container.textContent).toContain("运行中");
    expect(container.textContent).toContain("发布流水线失败");

    await click(
      byTestId(`collaboration-workspace-attention-${failedIssue.id}`),
    );
    const location = JSON.parse(byTestId("test-location").textContent ?? "{}");
    expect(location).toMatchObject({
      workspaceView: "projects",
      projectId: project.id,
      issueId: failedIssue.id,
    });
  });

  it("opens workspace settings directly from the workspace home", async () => {
    const { api } = createApi();
    await render(
      <PlatformHarness
        api={api}
        start={{ ...initialLocation, workspaceId: workspace.id }}
      />,
    );

    await click(byTestId("collaboration-workspace-home-settings"));

    expect(byTestId("workspace-settings-shell")).toBeTruthy();
    expect(byTestId("collaboration-workspace-settings-save")).toBeTruthy();
  });

  it("keeps the workspace overview available when one project snapshot fails", async () => {
    const unavailableProject = {
      ...project,
      id: "project-2",
      public_id: "project-public-2",
      project_key: "OPS",
      name: "发布运维",
    };
    const { api } = createApi({
      initialProjects: [project, unavailableProject],
    });
    api.issues.getBoardSnapshot = vi.fn(async (projectId: string) => {
      if (projectId === unavailableProject.id) {
        throw new Error("snapshot unavailable");
      }
      return {
        items: [issue],
        members: [member],
        agents: [agent],
        taskBindings: [],
      };
    });

    await render(
      <PlatformHarness
        api={api}
        start={{ ...initialLocation, workspaceId: workspace.id }}
      />,
    );

    expect(byTestId("collaboration-workspace-home")).toBeTruthy();
    expect(
      byTestId(
        `collaboration-workspace-operation-project-${unavailableProject.id}`,
      ),
    ).toBeTruthy();
    expect(
      byTestId(`collaboration-workspace-unavailable-${unavailableProject.id}`),
    ).toBeTruthy();
    expect(container.textContent).toContain("状态不可用");
    expect(
      container.querySelector(
        '.collaboration-workspace-operation-metrics [data-tone="failed"] strong',
      )?.textContent,
    ).toBe("0");
  });

  it("formats workspace operation times with the selected locale", async () => {
    const { api } = createApi();
    await render(
      <PlatformHarness
        api={api}
        locale="en"
        start={{ ...initialLocation, workspaceId: workspace.id }}
      />,
    );

    expect(container.textContent).toContain("Sep");
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

  it("keeps workspace settings mounted while refreshing another workspace section", async () => {
    const { api } = createApi();
    await render(
      <PlatformHarness
        api={api}
        start={{ ...initialLocation, workspaceId: workspace.id }}
      />,
    );
    const pendingWorkspaces = deferred<CollaborationWorkspace[]>();
    api.workspaces!.list = vi.fn(() => pendingWorkspaces.promise);

    await click(byTestId("collaboration-workspace-actions"));
    await click(byTestId("collaboration-workspace-nav-settings"));

    expect(byTestId("workspace-settings-shell")).toBeTruthy();
    expect(byTestId("collaboration-workspace-nav-participants")).toBeTruthy();

    pendingWorkspaces.resolve([workspace]);
  });

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
    expect(api.projects.list).toHaveBeenCalledOnce();
    expect(api.projects.list).toHaveBeenCalledWith();
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

    await click(byTestId("collaboration-workspace-participants-tab-agents"));
    await click(byTestId("project-agent-add"));
    expect(
      container.querySelector('[data-testid="project-agent-mode-create"]'),
    ).toBeNull();
    await change(
      byTestId("project-agent-wegent-team") as HTMLSelectElement,
      "12",
    );
    await click(byTestId("project-agent-wegent-create"));
    expect(api.workspaces?.addAgent).toHaveBeenCalledWith(workspace.id, {
      teamId: 12,
    });
    await click(byTestId("project-agent-archive-12"));
    expect(api.workspaces?.removeAgent).toHaveBeenCalledWith(workspace.id, 12);

    await click(byTestId("collaboration-workspace-nav-execution-environments"));
    await click(byTestId("collaboration-workspace-execution-environment-add"));
    await click(
      byTestId("collaboration-workspace-execution-environment-candidate-22"),
    );
    expect(api.workspaces?.addExecutionEnvironment).toHaveBeenCalledWith(
      workspace.id,
      {
        deviceId: 22,
      },
    );
    await click(
      byTestId("collaboration-workspace-execution-environment-remove-22"),
    );
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

    await change(comment, "@");
    await click(
      byTestId(`collaboration-issue-mention-member-${member.user_id}`),
    );
    await change(comment, `@${member.user_name} 请处理交互设计`);
    await click(byTestId("collaboration-issue-comment-submit"));
    expect(api.comments.create).toHaveBeenLastCalledWith(
      issue.id,
      `@${member.user_name} 请处理交互设计`,
    );
    await click(byTestId("cloud-todo-detail-assignee"));
    await click(
      portalByTestId(
        `cloud-todo-detail-assignee-option-user:${member.user_id}`,
      ),
    );
    expect(
      container.querySelector(
        '[data-testid="wework-assignment-notify-confirm"]',
      ),
    ).toBeNull();
    await click(byTestId("cloud-todo-save"));
    expect(api.issues.assign).toHaveBeenLastCalledWith(project.id, issue.id, {
      version: issue.version,
      assigneeType: "user",
      assigneeId: String(member.user_id),
      notifyAssignee: true,
    });

    await change(comment, "@");
    await click(byTestId(`collaboration-issue-mention-agent-${agent.id}`));
    await change(comment, `@${agent.name} 请开始实现`);
    await click(byTestId("collaboration-issue-comment-submit"));
    expect(api.comments.create).toHaveBeenLastCalledWith(
      issue.id,
      `@${agent.name} 请开始实现`,
    );
    await click(byTestId("cloud-todo-detail-assignee"));
    await click(
      portalByTestId(`cloud-todo-detail-assignee-option-agent:${agent.id}`),
    );
    await click(byTestId("cloud-todo-save"));
    expect(api.issues.assign).toHaveBeenLastCalledWith(project.id, issue.id, {
      version: issue.version,
      assigneeType: "agent",
      assigneeId: agent.id,
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
      container.querySelector(
        '[data-testid="collaboration-assignment-target"]',
      ),
    ).toBeNull();
    await click(byTestId("cloud-todo-create-task"));
    expect(onCreateTask).toHaveBeenCalledOnce();
  });
});
