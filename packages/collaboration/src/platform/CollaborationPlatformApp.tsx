// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { useEffect, useMemo, useRef, useState } from "react";
import {
  Activity,
  AlertTriangle,
  Bot,
  CircleCheck,
  Cloud,
  ChevronRight,
  Clock3,
  Ellipsis,
  FolderPlus,
  FolderOpen,
  Laptop,
  Monitor,
  SquarePen,
  Plus,
  Search,
  Settings,
  UserRound,
  UsersRound,
  X,
} from "lucide-react";

import { CollaborationApp } from "../CollaborationApp";
import { Tooltip } from "../issue-detail/Tooltip";
import { truncateRuntimeTaskTitle } from "@wegent/chat-core/runtime-task-title";
import { IssueHomeComposer } from "./IssueHomeComposer";
import type { IssueHomeOwner } from "./issueHomeOwners";
import type { ComposerInputHandle } from "../composer";
import {
  createCollaborationTranslator,
  type CollaborationLocale,
} from "../i18n";
import type {
  SharedWorkspaceApi,
  WorkspaceMyWorkItem,
  WorkspaceProjectAgent,
} from "../ports/SharedWorkspaceApi";
import {
  createWegentProjectAgentInput,
  ProjectAgentConfiguration,
} from "../project-agent-config";
import { ProjectCreateDialog, projectCreateLabels } from "../project-create";
import {
  CollaborationParticipantsTabs,
  ProjectExecutionEnvironments,
  ProjectSettingsShell,
} from "../project-manage";
import type {
  CollaborationExecutionEnvironment,
  CollaborationExecution,
  CollaborationGroup,
  CollaborationIssue,
  CollaborationMember,
  CollaborationOwnedAgent,
  CollaborationProject,
  CollaborationWorkspace,
  CollaborationWorkspaceNavigationContext,
} from "../types";
import type {
  CollaborationPlatformHostAdapter,
  CollaborationPlatformLocation,
  CollaborationWorkspaceView,
} from "./types";
import { useCollaborationPlatformController } from "./useCollaborationPlatformController";
import {
  createWorkspaceOperationsSnapshot,
  workspaceIssueOperationState,
  type WorkspaceOperationState,
  type WorkspaceProjectIssuesSnapshot,
} from "./workspaceOperations";
import {
  WorkspaceCollaborationGroupsConfiguration,
  WorkspaceMembersConfiguration,
  type WorkspaceResourceCommands,
} from "./WorkspaceResourceConfiguration";

const platformMessages = {
  "zh-CN": {
    allSpaces: "所有空间",
    home: "新建 Issue",
    newConversation: "新建对话",
    teams: "小队",
    devices: "设备",
    spaces: "空间",
    allSources: "全部",
    localSource: "本地",
    cloudSource: "云端",
    createdByMe: "我创建的",
    teamShared: "团队共享",
    storageLocation: "存储位置",
    resourceSource: "资源来源",
    usedBySpaces: "使用空间",
    notAddedToSpace: "尚未加入空间",
    addedToSpaceCount: "已加入 {{count}} 个空间",
    addToSpace: "添加到空间",
    chooseSpace: "选择使用空间",
    chooseSpaceHint: "空间只引用资源，不会改变资源的归属或存储位置。",
    createResourceAt: "新建资源",
    createResourceAtHint: "选择存储位置；云端资源还需要选择个人或团队归属。",
    localWorkspaceResource: "本地空间",
    localWorkspaceResourceHint: "保存在当前设备的唯一本地空间中，可离线使用。",
    cloudPersonal: "云端个人资源",
    cloudPersonalHint: "保存在云端，仅你可见和管理，可跨设备使用。",
    cloudTeamHint: "保存在云端，由团队成员按权限共同管理。",
    noAvailableSpaces: "暂无可用空间",
    resourceSaved: "资源已保存",
    bindingsSaved: "空间引用已更新",
    localResources: "本地资源",
    cloudResources: "云端资源",
    localResourcesHint: "保存在当前设备，可离线使用。",
    cloudResourcesHint: "保存在云端，可跨设备和空间复用。",
    resourceSettings: "设置",
    createAgent: "新建智能体",
    createTeam: "新建小队",
    addDevice: "添加设备",
    agentsPageHint: "可复用的身份与执行配置，绑定 Runtime 后即可接收工作。",
    teamsPageHint: "由 Leader 协调智能体和成员，把工作交给最合适的人。",
    devicesPageHint:
      "统一查看本机、远端机器和云端 Runtime 的健康状态与工具能力。",
    searchAgents: "搜索智能体",
    searchTeams: "搜索小队",
    searchDevices: "搜索设备",
    available: "可用",
    offline: "离线",
    online: "在线",
    provisioning: "准备中",
    errorStatus: "异常",
    access: "访问范围",
    runtime: "Runtime",
    leader: "Leader",
    memberCount: "成员",
    environmentCount: "执行设备",
    toolCount: "工具",
    noLocalAgents: "当前设备还没有智能体",
    noCloudAgents: "云端还没有智能体",
    noLocalTeams: "当前设备还没有小队",
    noCloudTeams: "云端还没有小队",
    noLocalDevices: "当前没有本地设备",
    noCloudDevices: "当前没有云端设备",
    collaborationHome: "协作首页",
    collaborationHomeHint: "继续推进你和团队正在进行的工作。",
    issueHomeTitle: "今天要推进什么？",
    issueHomeHint: "描述要推进的工作，交给团队一起完成。",
    issueHomePlaceholder: "描述要推进的工作，@ 成员，# 引用 Issue…",
    issueHomeAssignmentFailed:
      "Issue 已创建，但部分分配失败，请在详情中确认并补充分配。",
    issueHomeMembersFailed: "成员或 Issue 加载失败，请重新选择项目后重试。",
    issueHomeProject: "目标项目",
    createIssue: "新建 Issue",
    issueGuideRequirement: "拆解一个新需求",
    issueGuideRequirementHint: "明确目标、范围、验收标准和协作分工。",
    issueGuideBug: "修复一个问题",
    issueGuideBugHint: "记录现象、复现步骤、影响范围和期望结果。",
    issueGuideReview: "推进方案评审",
    issueGuideReviewHint: "沉淀备选方案、关键取舍和待确认事项。",
    issueGuideResearch: "整理调研与决策",
    issueGuideResearchHint: "汇总背景、证据、结论和后续行动。",
    myWork: "我的工作",
    inbox: "收件箱",
    runCenter: "运行中心",
    needsYourAction: "需要你处理",
    activeWork: "进行中的工作",
    recentProjects: "最近访问",
    noActiveWork: "当前没有正在推进的工作",
    noActiveWorkHint: "可以进入最近项目创建 Issue，或查看已有工作。",
    noInboxItems: "当前没有需要你处理的事项",
    noRuns: "当前没有执行记录",
    currentOwner: "当前负责人",
    currentStep: "当前步骤",
    runStatus: "运行状态",
    lastUpdated: "最后更新",
    openIssue: "打开 Issue",
    reviewNow: "去确认",
    viewItem: "查看",
    unassigned: "未分配",
    human: "成员",
    agent: "智能体",
    group: "协作小组",
    workspaceHint: "空间是成员、项目、智能体和执行环境的协作边界。",
    createWorkspace: "创建云端空间",
    cloudStorageNotice:
      "空间、项目与 Issue 将保存在 Wegent 云端，可在 Wework 和网页端跨设备协作。",
    localStorage: "本地 · 仅当前设备",
    cloudStorage: "云端 · 可跨设备协作",
    localSpaces: "当前设备",
    cloudSpaces: "云端空间",
    localOnlyHint:
      "当前仅显示本地空间。创建云端空间后即可邀请成员并跨设备协作。",
    joinWorkspace: "加入空间",
    noSpaces: "还没有协作空间",
    noSpacesHint: "先创建空间，再在空间中组织成员、项目和 AI 资源。",
    workspaceHome: "空间首页",
    currentWorkspace: "当前空间",
    allProjects: "全部项目",
    members: "成员",
    agents: "智能体",
    collaborationParticipants: "协作成员",
    collaborationParticipantsHint:
      "统一管理空间中的智能体、成员和协作小组，供空间内项目复用。",
    collaborationGroups: "协作小组",
    environments: "执行环境",
    settings: "空间设置",
    basicInformation: "基本信息",
    projects: "项目",
    workspaceManagement: "空间管理",
    createProject: "创建项目",
    createCollaborationProject: "新建协作项目",
    firstProjectHomeTitle: "创建第一个协作项目",
    firstProjectHomeHint:
      "用项目组织 Issue、成员和智能体。创建后即可开始分配和自动处理工作。",
    chooseProjectWorkspace: "选择项目所属空间",
    chooseProjectWorkspaceHint: "项目创建后不可移动到其他协作空间。",
    noProjects: "还没有项目",
    noProjectsHint: "创建项目后即可使用看板和表格组织 Issue。",
    enterWorkspace: "进入空间",
    enterProject: "进入项目",
    projectCount: "项目",
    save: "保存",
    cancel: "取消",
    name: "名称",
    description: "描述",
    owner: "归属",
    personalOwner: "个人",
    ownerHint: "决定空间内新建智能体和其他资源的默认归属。",
    workspaceSettingsHint: "管理空间基本信息、成员和协作资源。",
    loadFailed: "加载协作空间失败",
    searchSpaces: "搜索空间",
    firstUseProgress: "开始协作",
    firstProjectTitle: "创建第一个项目",
    firstProjectHint:
      "项目负责组织 Issue、成员和分配方式；智能体与执行环境可以稍后配置。",
    configureAgents: "配置智能体",
    inviteMembers: "邀请成员",
    workspaceResources: "空间资源",
    operationsOverview: "运行总览",
    operationsHint: "跨项目查看当前正在推进、等待确认和发生异常的工作。",
    operatingProjects: "项目运行状态",
    operatingProjectsHint: "异常和待确认项目优先显示。",
    needsAttention: "需要关注",
    attentionCount: "项需要处理",
    issues: "项 Issue",
    noAttention: "当前没有异常或待确认事项",
    running: "运行中",
    waitingReview: "待确认",
    failed: "异常",
    unavailable: "状态不可用",
    pending: "待开始",
    stable: "正常",
    idle: "空闲",
    updatedAt: "最近变化",
    viewAll: "查看全部",
    collaborationSpaces: "协作空间",
    collaborationSettings: "协作设置",
    manageAgents: "管理智能体资源",
    manageEnvironments: "管理执行环境",
    expandWorkspace: "展开空间项目",
    collapseWorkspace: "收起空间项目",
  },
  en: {
    allSpaces: "All spaces",
    home: "New Issue",
    newConversation: "New conversation",
    teams: "Teams",
    devices: "Devices",
    spaces: "Spaces",
    allSources: "All",
    localSource: "Local",
    cloudSource: "Cloud",
    createdByMe: "Created by me",
    teamShared: "Team shared",
    storageLocation: "Storage",
    resourceSource: "Source",
    usedBySpaces: "Used by spaces",
    notAddedToSpace: "Not added to a space",
    addedToSpaceCount: "Used by {{count}} spaces",
    addToSpace: "Add to space",
    chooseSpace: "Choose a space",
    chooseSpaceHint:
      "A space references the resource without changing its owner or storage location.",
    createResourceAt: "Create resource",
    createResourceAtHint:
      "Choose where it is stored. Cloud resources also need a personal or team owner.",
    localWorkspaceResource: "Local space",
    localWorkspaceResourceHint:
      "Stored in this device's single local space and available offline.",
    cloudPersonal: "Cloud personal resource",
    cloudPersonalHint:
      "Stored in the cloud, visible only to you, and available across devices.",
    cloudTeamHint:
      "Stored in the cloud and managed by team members according to permissions.",
    noAvailableSpaces: "No spaces available",
    resourceSaved: "Resource saved",
    bindingsSaved: "Space references updated",
    localResources: "Local resources",
    cloudResources: "Cloud resources",
    localResourcesHint: "Stored on this device and available offline.",
    cloudResourcesHint:
      "Stored in the cloud for reuse across devices and spaces.",
    resourceSettings: "Settings",
    createAgent: "New agent",
    createTeam: "New team",
    addDevice: "Add device",
    agentsPageHint:
      "Reusable identities and execution settings that receive work through a bound runtime.",
    teamsPageHint:
      "A leader coordinates agents and members, handing work to the right collaborator.",
    devicesPageHint:
      "Monitor local, remote, and cloud runtimes, their health, and available tools.",
    searchAgents: "Search agents",
    searchTeams: "Search teams",
    searchDevices: "Search devices",
    available: "Available",
    offline: "Offline",
    online: "Online",
    provisioning: "Preparing",
    errorStatus: "Error",
    access: "Access",
    runtime: "Runtime",
    leader: "Leader",
    memberCount: "Members",
    environmentCount: "Execution devices",
    toolCount: "Tools",
    noLocalAgents: "No agents on this device",
    noCloudAgents: "No cloud agents yet",
    noLocalTeams: "No local teams yet",
    noCloudTeams: "No cloud teams yet",
    noLocalDevices: "No local devices",
    noCloudDevices: "No cloud devices",
    collaborationHome: "Collaboration home",
    collaborationHomeHint: "Keep your team's active work moving.",
    issueHomeTitle: "What should we move forward today?",
    issueHomeHint: "Describe the work you want to move forward with your team.",
    issueHomePlaceholder:
      "Describe the work. @ mention people, # reference project Issues…",
    issueHomeAssignmentFailed:
      "Issue created, but some assignments failed. Review and complete them in the details.",
    issueHomeMembersFailed:
      "Could not load members or Issues. Select the project again to retry.",
    issueHomeProject: "Project",
    createIssue: "New Issue",
    issueGuideRequirement: "Break down a requirement",
    issueGuideRequirementHint:
      "Define the goal, scope, acceptance criteria, and ownership.",
    issueGuideBug: "Fix a problem",
    issueGuideBugHint:
      "Capture symptoms, reproduction steps, impact, and expected behavior.",
    issueGuideReview: "Review a proposal",
    issueGuideReviewHint:
      "Record alternatives, tradeoffs, and decisions still needed.",
    issueGuideResearch: "Turn research into a decision",
    issueGuideResearchHint:
      "Summarize context, evidence, conclusions, and next actions.",
    myWork: "My work",
    inbox: "Inbox",
    runCenter: "Run center",
    needsYourAction: "Needs your action",
    activeWork: "Work in progress",
    recentProjects: "Recently visited",
    noActiveWork: "No work is currently in progress",
    noActiveWorkHint:
      "Open a recent project to create an issue or review existing work.",
    noInboxItems: "Nothing needs your attention right now",
    noRuns: "No execution records yet",
    currentOwner: "Current owner",
    currentStep: "Current step",
    runStatus: "Run status",
    lastUpdated: "Last updated",
    openIssue: "Open issue",
    reviewNow: "Review",
    viewItem: "View",
    unassigned: "Unassigned",
    human: "Member",
    agent: "Agent",
    group: "Collaboration group",
    workspaceHint:
      "A workspace is the collaboration boundary for members, projects, agents, and execution environments.",
    createWorkspace: "Create cloud space",
    cloudStorageNotice:
      "The space, projects, and issues are stored in Wegent Cloud for cross-device collaboration in Wework and on the web.",
    localStorage: "Local · This device only",
    cloudStorage: "Cloud · Cross-device",
    localSpaces: "This device",
    cloudSpaces: "Cloud spaces",
    localOnlyHint:
      "Only the local space is available. Create a cloud space to invite members and collaborate across devices.",
    joinWorkspace: "Join space",
    noSpaces: "No collaboration spaces yet",
    noSpacesHint:
      "Create a space, then organize members, projects, and AI resources inside it.",
    workspaceHome: "Space home",
    currentWorkspace: "Current space",
    allProjects: "All projects",
    members: "Members",
    agents: "Agents",
    collaborationParticipants: "Collaboration members",
    collaborationParticipantsHint:
      "Manage workspace agents, members, and collaboration groups together for reuse across projects.",
    collaborationGroups: "Collaboration groups",
    environments: "Execution environments",
    settings: "Space settings",
    basicInformation: "Basic information",
    projects: "Projects",
    workspaceManagement: "Space management",
    createProject: "Create project",
    createCollaborationProject: "New collaboration project",
    firstProjectHomeTitle: "Create your first collaboration project",
    firstProjectHomeHint:
      "Use projects to organize issues, members, and agents. Once created, you can start assigning and automating work.",
    chooseProjectWorkspace: "Choose a workspace",
    chooseProjectWorkspaceHint:
      "The project cannot be moved to another collaboration workspace after creation.",
    noProjects: "No projects yet",
    noProjectsHint:
      "Create a project to organize issues in board and table views.",
    enterWorkspace: "Enter space",
    enterProject: "Enter project",
    projectCount: "Projects",
    save: "Save",
    cancel: "Cancel",
    name: "Name",
    description: "Description",
    owner: "Owner",
    personalOwner: "Personal",
    ownerHint:
      "Determines the default owner for agents and other resources created in this workspace.",
    workspaceSettingsHint:
      "Manage the workspace profile, members, and collaboration resources.",
    loadFailed: "Failed to load collaboration spaces",
    searchSpaces: "Search spaces",
    firstUseProgress: "Getting started",
    firstProjectTitle: "Create your first project",
    firstProjectHint:
      "Projects organize issues, members, and assignments. Agents and execution environments can be configured later.",
    configureAgents: "Configure agents",
    inviteMembers: "Invite members",
    workspaceResources: "Workspace resources",
    operationsOverview: "Operations overview",
    operationsHint:
      "See what is running, waiting for review, or failing across projects.",
    operatingProjects: "Project operations",
    operatingProjectsHint:
      "Projects with failures or review gates are shown first.",
    needsAttention: "Needs attention",
    attentionCount: "items need action",
    issues: "issues",
    noAttention: "No failures or review gates right now",
    running: "Running",
    waitingReview: "Awaiting review",
    failed: "Failed",
    unavailable: "Status unavailable",
    pending: "Ready",
    stable: "Healthy",
    idle: "Idle",
    updatedAt: "Last change",
    viewAll: "View all",
    collaborationSpaces: "Collaboration spaces",
    collaborationSettings: "Collaboration settings",
    manageAgents: "Manage agent resources",
    manageEnvironments: "Manage execution environments",
    expandWorkspace: "Expand workspace projects",
    collapseWorkspace: "Collapse workspace projects",
  },
} as const;

type PlatformMessages = (typeof platformMessages)[CollaborationLocale];

export type CollaborationProjectRendererWorkspaceContext =
  | CollaborationWorkspace
  | CollaborationWorkspaceNavigationContext;

export interface CollaborationProjectRendererContext {
  project: CollaborationProject;
  workspace: CollaborationProjectRendererWorkspaceContext;
}

function navigateWithin(
  host: CollaborationPlatformHostAdapter,
  patch: Partial<CollaborationPlatformLocation>,
) {
  host.navigate({ ...host.location, ...patch });
}

function workspaceAgentRecord(
  agent: CollaborationOwnedAgent,
): WorkspaceProjectAgent {
  const teamId = agent.team_id;
  if (teamId == null) {
    throw new Error("Workspace Agent is missing team_id");
  }
  return {
    ...agent,
    id: String(teamId),
    runtime: "wegent",
    status: "active",
    version: 1,
    wegentTeamId: teamId,
  };
}

function createWorkspaceAgentConfigurationApi(
  api: SharedWorkspaceApi,
  workspaceId: string,
): SharedWorkspaceApi {
  const workspaces = api.workspaces;
  if (!workspaces) return api;
  return {
    ...api,
    agents: {
      async list() {
        return (await workspaces.listAgents(workspaceId)).map(
          workspaceAgentRecord,
        );
      },
      async create(_scopeId, input) {
        const teamId = Number(input.wegentTeamId);
        if (!Number.isFinite(teamId)) {
          throw new Error("Workspace Agent is missing wegentTeamId");
        }
        return workspaceAgentRecord(
          await workspaces.addAgent(workspaceId, { teamId }),
        );
      },
      async update(_scopeId, agentId) {
        const teamId = Number(agentId);
        if (!Number.isFinite(teamId)) {
          throw new Error("Workspace Agent id must be a team id");
        }
        const current = (await workspaces.listAgents(workspaceId)).find(
          (agent) => agent.team_id === teamId,
        );
        if (!current) throw new Error("Workspace Agent was not found");
        await workspaces.removeAgent(workspaceId, teamId);
        return {
          ...workspaceAgentRecord(current),
          status: "archived",
        };
      },
    },
  };
}

function CollaborationPlatformNavigation({
  host,
  messages,
  workspaces,
  workspaceNavigationContext,
  projects,
  onCreateWorkspace,
  onNewConversation,
  footer,
}: {
  host: CollaborationPlatformHostAdapter;
  messages: PlatformMessages;
  workspaces: CollaborationWorkspace[];
  workspaceNavigationContext: CollaborationWorkspaceNavigationContext | null;
  projects: CollaborationProject[];
  onCreateWorkspace(): void;
  onNewConversation(projectId: string): void;
  footer?: React.ReactNode;
}) {
  const navigationWorkspaces = useMemo(
    () =>
      workspaceNavigationContext
        ? [
            ...workspaces.map((workspace) => ({ workspace, canOpen: true })),
            ...(workspaces.some(
              (workspace) => workspace.id === workspaceNavigationContext.id,
            )
              ? []
              : [{ workspace: workspaceNavigationContext, canOpen: false }]),
          ]
        : workspaces.map((workspace) => ({ workspace, canOpen: true })),
    [workspaceNavigationContext, workspaces],
  );
  const [expandedWorkspaceIds, setExpandedWorkspaceIds] = useState<Set<string>>(
    () =>
      new Set(
        host.location.workspaceId
          ? [host.location.workspaceId]
          : navigationWorkspaces
              .slice(0, 1)
              .map(({ workspace }) => workspace.id),
      ),
  );
  const [workspacesExpanded, setWorkspacesExpanded] = useState(true);
  const [collaborationMenuOpen, setCollaborationMenuOpen] = useState(false);
  const [workspaceMenuId, setWorkspaceMenuId] = useState<string | null>(null);
  const fullSidebar = host.capabilities.sidebarPresentation !== "context";
  const collaborationMenuRef = useRef<HTMLDivElement>(null);
  const workspaceMenuRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const workspaceId =
      host.location.workspaceId ?? navigationWorkspaces[0]?.workspace.id;
    if (!workspaceId) return;
    setExpandedWorkspaceIds((current) => {
      if (current.has(workspaceId)) return current;
      return new Set([...current, workspaceId]);
    });
  }, [host.location.workspaceId, navigationWorkspaces]);
  useEffect(() => {
    if (!collaborationMenuOpen) return;
    const closeOnOutsidePointer = (event: PointerEvent) => {
      if (!collaborationMenuRef.current?.contains(event.target as Node)) {
        setCollaborationMenuOpen(false);
      }
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setCollaborationMenuOpen(false);
    };
    document.addEventListener("pointerdown", closeOnOutsidePointer);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOnOutsidePointer);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [collaborationMenuOpen]);
  useEffect(() => {
    if (!workspaceMenuId) return;
    const closeOnOutsidePointer = (event: PointerEvent) => {
      if (!workspaceMenuRef.current?.contains(event.target as Node)) {
        setWorkspaceMenuId(null);
      }
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setWorkspaceMenuId(null);
    };
    document.addEventListener("pointerdown", closeOnOutsidePointer);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOnOutsidePointer);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [workspaceMenuId]);
  const openWorkspaceHome = (workspaceId: string) =>
    host.navigate({
      platformView: "spaces",
      workspaceId,
      workspaceView: "home",
      projectId: null,
      projectView: "board",
      issueId: null,
    });
  const toggleWorkspace = (workspaceId: string) => {
    setExpandedWorkspaceIds((current) => {
      const next = new Set(current);
      if (next.has(workspaceId)) next.delete(workspaceId);
      else next.add(workspaceId);
      return next;
    });
  };
  return (
    <aside
      className={`collaboration-platform-sidebar collaboration-platform-sidebar-${host.capabilities.sidebarPresentation ?? "full"}`}
      data-testid="collaboration-platform-sidebar"
    >
      {fullSidebar ? (
        <>
          <div className="collaboration-platform-brand">
            {messages.collaborationSpaces}
          </div>
          <nav
            className="collaboration-primary-navigation"
            aria-label={messages.collaborationSpaces}
          >
            <button
              type="button"
              className={
                !host.location.workspaceId &&
                (host.location.rootView ?? "home") === "home"
                  ? "active"
                  : undefined
              }
              aria-current={
                !host.location.workspaceId &&
                (host.location.rootView ?? "home") === "home"
                  ? "page"
                  : undefined
              }
              data-testid="collaboration-primary-home"
              onClick={() =>
                host.navigate({
                  platformView: "spaces",
                  rootView: "home",
                  workspaceId: null,
                  workspaceView: "home",
                  projectId: null,
                  projectView: "board",
                  issueId: null,
                })
              }
            >
              <Plus aria-hidden="true" />
              <span>{messages.home}</span>
            </button>
            <button
              type="button"
              className={
                !host.location.workspaceId &&
                host.location.rootView === "agents"
                  ? "active"
                  : undefined
              }
              aria-current={
                !host.location.workspaceId &&
                host.location.rootView === "agents"
                  ? "page"
                  : undefined
              }
              data-testid="collaboration-primary-agents"
              onClick={() =>
                host.navigate({
                  platformView: "spaces",
                  rootView: "agents",
                  workspaceId: null,
                  workspaceView: "home",
                  projectId: null,
                  projectView: "board",
                  issueId: null,
                })
              }
            >
              <Bot aria-hidden="true" />
              <span>{messages.agents}</span>
            </button>
            <button
              type="button"
              className={
                !host.location.workspaceId && host.location.rootView === "teams"
                  ? "active"
                  : undefined
              }
              aria-current={
                !host.location.workspaceId && host.location.rootView === "teams"
                  ? "page"
                  : undefined
              }
              data-testid="collaboration-primary-teams"
              onClick={() =>
                host.navigate({
                  platformView: "spaces",
                  rootView: "teams",
                  workspaceId: null,
                  workspaceView: "home",
                  projectId: null,
                  projectView: "board",
                  issueId: null,
                })
              }
            >
              <UsersRound aria-hidden="true" />
              <span>{messages.teams}</span>
            </button>
            <button
              type="button"
              className={
                !host.location.workspaceId &&
                host.location.rootView === "devices"
                  ? "active"
                  : undefined
              }
              aria-current={
                !host.location.workspaceId &&
                host.location.rootView === "devices"
                  ? "page"
                  : undefined
              }
              data-testid="collaboration-primary-devices"
              onClick={() =>
                host.navigate({
                  platformView: "spaces",
                  rootView: "devices",
                  workspaceId: null,
                  workspaceView: "home",
                  projectId: null,
                  projectView: "board",
                  issueId: null,
                })
              }
            >
              <Monitor aria-hidden="true" />
              <span>{messages.devices}</span>
            </button>
          </nav>
        </>
      ) : null}
      <div className="collaboration-workspace-section-heading">
        {fullSidebar ? (
          <span
            className="collaboration-workspace-section-title"
            data-testid="collaboration-workspaces-section-title"
          >
            {messages.spaces}
          </span>
        ) : (
          <button
            type="button"
            className="collaboration-workspace-section-toggle"
            aria-expanded={workspacesExpanded}
            data-testid="collaboration-workspaces-section-toggle"
            onClick={() => setWorkspacesExpanded((expanded) => !expanded)}
          >
            <span>{messages.collaborationSpaces}</span>
            <ChevronRight aria-hidden="true" />
          </button>
        )}
        <div
          className="collaboration-workspace-section-actions"
          ref={collaborationMenuRef}
        >
          <button
            type="button"
            className="collaboration-workspace-section-settings"
            aria-label={messages.collaborationSettings}
            title={messages.collaborationSettings}
            aria-expanded={collaborationMenuOpen}
            aria-haspopup="menu"
            data-testid="collaboration-workspace-section-actions"
            onClick={() => setCollaborationMenuOpen((open) => !open)}
          >
            <Ellipsis aria-hidden="true" />
          </button>
          <button
            type="button"
            className="collaboration-workspace-section-create"
            aria-label={messages.createWorkspace}
            title={messages.createWorkspace}
            data-testid="collaboration-workspace-create"
            onClick={onCreateWorkspace}
          >
            <span data-testid="collaboration-workspace-sidebar-create">
              <FolderPlus aria-hidden="true" />
            </span>
          </button>
          {collaborationMenuOpen ? (
            <div role="menu">
              {host.manageResource ? (
                <>
                  <button
                    type="button"
                    role="menuitem"
                    data-testid="collaboration-manage-agents"
                    onClick={() => {
                      setCollaborationMenuOpen(false);
                      host.manageResource?.("agents");
                    }}
                  >
                    {messages.manageAgents}
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    data-testid="collaboration-manage-environments"
                    onClick={() => {
                      setCollaborationMenuOpen(false);
                      host.manageResource?.("environments");
                    }}
                  >
                    {messages.manageEnvironments}
                  </button>
                </>
              ) : null}
            </div>
          ) : null}
        </div>
      </div>
      {fullSidebar || workspacesExpanded ? (
        <div className="collaboration-workspace-tree">
          {navigationWorkspaces.map(({ workspace: candidate, canOpen }) => {
            const expanded = expandedWorkspaceIds.has(candidate.id);
            const candidateProjects = projects.filter(
              (project) => project.workspace_id === candidate.id,
            );
            const workspaceActive =
              host.location.workspaceId === candidate.id &&
              !host.location.projectId;
            const canManageWorkspace =
              canOpen &&
              "access_role" in candidate &&
              (candidate.access_role === "Owner" ||
                candidate.access_role === "Maintainer");
            const menuOpen = workspaceMenuId === candidate.id;
            return (
              <section
                className="collaboration-workspace-group"
                data-testid={`collaboration-workspace-tree-${candidate.id}`}
                key={candidate.id}
              >
                <div
                  className={`collaboration-workspace-row${
                    workspaceActive ? " active" : ""
                  }${canManageWorkspace ? " has-actions" : ""}`}
                >
                  {canOpen ? (
                    <button
                      type="button"
                      className="collaboration-workspace-identity"
                      data-testid={
                        host.location.workspaceId === candidate.id
                          ? "collaboration-workspace-nav-projects"
                          : `collaboration-workspace-home-${candidate.id}`
                      }
                      aria-current={workspaceActive ? "page" : undefined}
                      onClick={() => openWorkspaceHome(candidate.id)}
                    >
                      <span
                        className="collaboration-workspace-folder"
                        aria-hidden="true"
                      >
                        <FolderOpen />
                      </span>
                      <span
                        className="collaboration-workspace-title-block"
                        data-location={candidate.location}
                        data-testid={`collaboration-workspace-${candidate.id}`}
                      >
                        <span className="collaboration-workspace-title">
                          {candidate.name}
                        </span>
                      </span>
                    </button>
                  ) : (
                    <div
                      className="collaboration-workspace-identity"
                      data-testid="collaboration-project-parent-workspace-context"
                    >
                      <span
                        className="collaboration-workspace-folder"
                        aria-hidden="true"
                      >
                        <FolderOpen />
                      </span>
                      <span
                        className="collaboration-workspace-title-block"
                        data-location={candidate.location}
                        data-testid={`collaboration-workspace-${candidate.id}`}
                      >
                        <span className="collaboration-workspace-title">
                          {candidate.name}
                        </span>
                      </span>
                    </div>
                  )}
                  {canManageWorkspace ? (
                    <div
                      className="collaboration-workspace-actions"
                      ref={menuOpen ? workspaceMenuRef : undefined}
                    >
                      <button
                        type="button"
                        aria-label={messages.settings}
                        aria-expanded={menuOpen}
                        aria-haspopup="menu"
                        data-testid={
                          host.location.workspaceId === candidate.id
                            ? "collaboration-workspace-actions"
                            : `collaboration-workspace-actions-${candidate.id}`
                        }
                        onClick={() =>
                          setWorkspaceMenuId((current) =>
                            current === candidate.id ? null : candidate.id,
                          )
                        }
                      >
                        <Ellipsis aria-hidden="true" />
                      </button>
                      {menuOpen ? (
                        <div role="menu">
                          <button
                            type="button"
                            role="menuitem"
                            data-testid="collaboration-workspace-nav-settings"
                            onClick={() => {
                              setWorkspaceMenuId(null);
                              host.navigate({
                                platformView: "spaces",
                                workspaceId: candidate.id,
                                workspaceView: "settings",
                                projectId: null,
                                projectView: "board",
                                issueId: null,
                              });
                            }}
                          >
                            <Settings aria-hidden="true" />
                            {messages.settings}
                          </button>
                        </div>
                      ) : null}
                    </div>
                  ) : null}
                  <button
                    type="button"
                    className="collaboration-workspace-toggle"
                    aria-expanded={expanded}
                    aria-label={
                      expanded
                        ? messages.collapseWorkspace
                        : messages.expandWorkspace
                    }
                    data-testid={`collaboration-workspace-toggle-${candidate.id}`}
                    onClick={() => toggleWorkspace(candidate.id)}
                  >
                    <ChevronRight aria-hidden="true" />
                  </button>
                </div>
                {expanded ? (
                  <nav
                    className="collaboration-workspace-project-list"
                    aria-label={`${candidate.name} · ${messages.projects}`}
                  >
                    {candidateProjects.map((project) => (
                      <div
                        className="collaboration-workspace-project-row"
                        key={project.id}
                      >
                        <button
                          type="button"
                          className={`collaboration-workspace-project${
                            host.location.projectId === project.id
                              ? " active"
                              : ""
                          }`}
                          aria-current={
                            host.location.projectId === project.id
                              ? "page"
                              : undefined
                          }
                          title={project.name}
                          data-testid={`collaboration-workspace-project-${project.id}`}
                          onClick={() =>
                            host.navigate({
                              platformView: "spaces",
                              workspaceId: candidate.id,
                              workspaceView: "projects",
                              projectId: project.id,
                              projectView: "board",
                              issueId: null,
                            })
                          }
                        >
                          <span>{project.name}</span>
                        </button>
                        <Tooltip
                          label={messages.newConversation}
                          className="collaboration-project-action-anchor"
                        >
                          <button
                            type="button"
                            className="collaboration-project-new-conversation"
                            aria-label={`${messages.newConversation} · ${project.name}`}
                            data-testid={`collaboration-project-new-conversation-${project.id}`}
                            onClick={() => onNewConversation(project.id)}
                          >
                            <SquarePen aria-hidden="true" />
                          </button>
                        </Tooltip>
                      </div>
                    ))}
                  </nav>
                ) : null}
              </section>
            );
          })}
        </div>
      ) : null}
      {footer ? (
        <div className="collaboration-platform-sidebar-footer">{footer}</div>
      ) : null}
    </aside>
  );
}

function PageHeader({
  title,
  subtitle,
  action,
}: {
  title: string;
  subtitle: string;
  action?: React.ReactNode;
}) {
  return (
    <header className="collaboration-platform-page-header">
      <div>
        <h1>{title}</h1>
        <p>{subtitle}</p>
      </div>
      {action}
    </header>
  );
}

function EmptyState({
  title,
  description,
  action,
}: {
  title: string;
  description: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="collaboration-platform-empty">
      <strong>{title}</strong>
      <p>{description}</p>
      {action}
    </div>
  );
}

type ResourceSource = "local" | "cloud";
type ResourceScope = "all" | "mine" | "shared";
type ResourceCatalogKind = "agents" | "teams" | "devices";

function ResourceSourceIcon({ source }: { source: ResourceSource }) {
  const Icon = source === "local" ? Laptop : Cloud;
  return <Icon aria-hidden="true" />;
}

function ResourceCatalogPage({
  kind,
  agents,
  groups,
  environments,
  canCreateDevice,
  workspaces,
  ownerOptions,
  messages,
  onAddToWorkspace,
  onCreateAgent,
  onCreateDevice,
  onCreateLocalAgent,
  onCreateTeam,
  onManageResource,
  onOpenTeamWorkspace,
}: {
  kind: ResourceCatalogKind;
  agents: CollaborationOwnedAgent[];
  groups: CollaborationGroup[];
  environments: CollaborationExecutionEnvironment[];
  canCreateDevice: boolean;
  workspaces: CollaborationWorkspace[];
  ownerOptions: CollaborationPlatformHostAdapter["workspaceOwnerOptions"];
  messages: PlatformMessages;
  onAddToWorkspace(
    workspaceId: string,
    kind: ResourceCatalogKind,
    resourceId: string,
  ): Promise<void>;
  onCreateAgent(namespace: string, ownerLabel: string): void;
  onCreateDevice(source: ResourceSource, workspaceId?: string): void;
  onCreateLocalAgent(): void;
  onCreateTeam(workspaceId: string): void;
  onManageResource(
    kind: ResourceCatalogKind,
    resourceId?: string,
    source?: ResourceSource,
  ): void;
  onOpenTeamWorkspace(workspaceId: string): void;
}) {
  const defaultSource: ResourceSource =
    (kind === "agents" &&
      agents.some((agent) => (agent.location ?? "cloud") === "cloud")) ||
    (kind === "teams" &&
      groups.some(
        (group) =>
          workspaces.find((workspace) => workspace.id === group.workspace_id)
            ?.location === "cloud",
      )) ||
    (kind === "devices" &&
      environments.some((environment) => environment.kind === "cloud_host"))
      ? "cloud"
      : "local";
  const [source, setSource] = useState<ResourceSource>(defaultSource);
  const [scope, setScope] = useState<ResourceScope>("all");
  const [query, setQuery] = useState("");
  const [createOpen, setCreateOpen] = useState(false);
  const [bindingResourceId, setBindingResourceId] = useState<string | null>(
    null,
  );
  const [bindingWorkspaceId, setBindingWorkspaceId] = useState<string | null>(
    null,
  );
  const workspaceLocations = useMemo(
    () =>
      new Map(
        workspaces.map((workspace) => [workspace.id, workspace.location]),
      ),
    [workspaces],
  );
  const localWorkspace =
    workspaces.find((workspace) => workspace.location === "local") ?? null;
  const cloudWorkspaces = workspaces.filter(
    (workspace) => workspace.location === "cloud",
  );
  const cloudPersonalWorkspace =
    cloudWorkspaces.find((workspace) => workspace.namespace === "default") ??
    null;
  const cloudGroupWorkspaces = cloudWorkspaces.filter(
    (workspace) => workspace.namespace !== "default",
  );
  const normalizedQuery = query.trim().toLocaleLowerCase();
  useEffect(() => {
    setSource(defaultSource);
    setScope("all");
    setQuery("");
    setCreateOpen(false);
    setBindingResourceId(null);
    setBindingWorkspaceId(null);
  }, [defaultSource, kind]);
  const pageCopy = {
    agents: {
      title: messages.agents,
      hint: messages.agentsPageHint,
      search: messages.searchAgents,
      create: messages.createAgent,
      icon: Bot,
    },
    teams: {
      title: messages.teams,
      hint: messages.teamsPageHint,
      search: messages.searchTeams,
      create: messages.createTeam,
      icon: UsersRound,
    },
    devices: {
      title: messages.devices,
      hint: messages.devicesPageHint,
      search: messages.searchDevices,
      create: messages.addDevice,
      icon: Monitor,
    },
  }[kind];

  const agentRows = agents.map((agent) => {
    const runtime =
      agent.execution_environment_ids
        .map(
          (environmentId) =>
            environments.find((environment) => environment.id === environmentId)
              ?.name,
        )
        .filter(Boolean)
        .join(", ") || messages.unavailable;
    return {
      id: agent.id,
      name: agent.name,
      source: agent.location ?? ("cloud" as const),
      scope:
        agent.owner_type === "user" ? ("mine" as const) : ("shared" as const),
      owner: agent.owner_name,
      detail: runtime,
      access:
        agent.owner_type === "workspace"
          ? messages.currentWorkspace
          : messages.personalOwner,
      runtime,
      leader: "",
      memberCount: 0,
      tools: [] as string[],
      updatedAt: agent.status,
      status:
        agent.status === "available"
          ? messages.available
          : messages.unavailable,
      statusTone: agent.status,
      workspaceNames:
        agent.owner_type === "workspace"
          ? workspaces
              .filter((workspace) => workspace.id === agent.owner_id)
              .map((workspace) => workspace.name)
          : [],
    };
  });
  const teamRows = groups.map((group) => ({
    id: group.id,
    name: group.name,
    source: workspaceLocations.get(group.workspace_id) ?? ("cloud" as const),
    scope: "shared" as const,
    owner:
      workspaces.find((workspace) => workspace.id === group.workspace_id)
        ?.name ?? group.owner_id,
    detail: `${group.members.length + 1} ${messages.memberCount}`,
    access: messages.currentWorkspace,
    runtime: "",
    leader:
      agents.find((agent) => agent.id === group.leader.id)?.name ??
      group.leader.responsibility ??
      group.leader.id,
    memberCount: group.members.length + 1,
    tools: [] as string[],
    updatedAt: group.updated_at,
    status: messages.available,
    statusTone: "available",
    workspaceNames: workspaces
      .filter((workspace) => workspace.id === group.workspace_id)
      .map((workspace) => workspace.name),
  }));
  const deviceRows = environments.map((environment) => ({
    id: environment.id,
    name: environment.name,
    source:
      environment.kind === "local_device"
        ? ("local" as const)
        : ("cloud" as const),
    scope:
      environment.owner_type === "user"
        ? ("mine" as const)
        : ("shared" as const),
    owner: environment.owner_name,
    detail: `${environment.coding_tools.length} ${messages.toolCount}`,
    access:
      environment.owner_type === "workspace"
        ? messages.currentWorkspace
        : messages.personalOwner,
    runtime:
      environment.kind === "local_device"
        ? messages.localResources
        : messages.cloudResources,
    leader: "",
    memberCount: 0,
    tools: environment.coding_tools,
    updatedAt: environment.updated_at,
    status:
      environment.status === "online"
        ? messages.online
        : environment.status === "provisioning"
          ? messages.provisioning
          : environment.status === "error"
            ? messages.errorStatus
            : messages.offline,
    statusTone: environment.status,
    workspaceNames:
      environment.owner_type === "workspace"
        ? workspaces
            .filter((workspace) => workspace.id === environment.owner_id)
            .map((workspace) => workspace.name)
        : [],
  }));
  const rows =
    kind === "agents" ? agentRows : kind === "teams" ? teamRows : deviceRows;
  const visibleRows = rows.filter(
    (row) =>
      row.source === source &&
      (source === "local" || scope === "all" || row.scope === scope) &&
      (!normalizedQuery ||
        `${row.name} ${row.owner} ${row.workspaceNames.join(" ")}`
          .toLocaleLowerCase()
          .includes(normalizedQuery)),
  );
  const PageIcon = pageCopy.icon;
  const sourceCounts = {
    local: rows.filter((row) => row.source === "local").length,
    cloud: rows.filter((row) => row.source === "cloud").length,
  };
  const rowsInSource = rows.filter((row) => row.source === source);
  const scopeCounts = {
    all: rowsInSource.length,
    mine: rowsInSource.filter((row) => row.scope === "mine").length,
    shared: rowsInSource.filter((row) => row.scope === "shared").length,
  };
  const bindingRow = rows.find((row) => row.id === bindingResourceId) ?? null;
  const formatCount = (template: string, count: number) =>
    template.replace("{{count}}", String(count));
  const workspaceUsage = (row: (typeof rows)[number]) =>
    row.source === "local"
      ? messages.localSpaces
      : row.workspaceNames.length
        ? formatCount(messages.addedToSpaceCount, row.workspaceNames.length)
        : messages.notAddedToSpace;
  const scopeLabel = (rowScope: Exclude<ResourceScope, "all">) =>
    rowScope === "mine" ? messages.createdByMe : messages.teamShared;
  const ScopeIcon = ({ value }: { value: Exclude<ResourceScope, "all"> }) => {
    const Icon = value === "mine" ? UserRound : UsersRound;
    return <Icon aria-hidden="true" />;
  };
  const startCreate = () => {
    setCreateOpen(true);
  };

  return (
    <div
      className="collaboration-platform-page collaboration-resource-catalog-page"
      data-testid={`collaboration-${kind}-page`}
    >
      <header className="collaboration-resource-collection-header">
        <span className="collaboration-resource-collection-icon">
          <PageIcon aria-hidden="true" />
        </span>
        <span className="collaboration-resource-collection-copy">
          <span>
            <h1>{pageCopy.title}</h1>
            <em>{rows.length}</em>
          </span>
          <p>{pageCopy.hint}</p>
        </span>
        {kind !== "devices" || canCreateDevice ? (
          <button
            type="button"
            className="collaboration-primary-button"
            data-testid={`collaboration-${kind}-create`}
            onClick={startCreate}
          >
            <Plus aria-hidden="true" />
            {pageCopy.create}
          </button>
        ) : null}
      </header>

      <div className="collaboration-resource-catalog-toolbar">
        <div className="collaboration-resource-filter-stack">
          <span>{messages.storageLocation}</span>
          <div
            className="collaboration-resource-source-filter"
            role="group"
            aria-label={messages.storageLocation}
          >
            {(["local", "cloud"] as const).map((candidate) => (
              <button
                type="button"
                className={source === candidate ? "active" : undefined}
                aria-pressed={source === candidate}
                data-testid={`collaboration-${kind}-filter-${candidate}`}
                key={candidate}
                onClick={() => {
                  setSource(candidate);
                  setScope("all");
                }}
              >
                <ResourceSourceIcon source={candidate} />
                <span>
                  {candidate === "local"
                    ? messages.localSource
                    : messages.cloudSource}
                </span>
                <em>{sourceCounts[candidate]}</em>
              </button>
            ))}
          </div>
          {source === "cloud" ? (
            <>
              <span>{messages.resourceSource}</span>
              <div
                className="collaboration-resource-scope-filter"
                role="group"
                aria-label={messages.resourceSource}
              >
                {(["all", "mine", "shared"] as const).map((candidate) => (
                  <button
                    type="button"
                    className={scope === candidate ? "active" : undefined}
                    aria-pressed={scope === candidate}
                    data-testid={`collaboration-${kind}-scope-${candidate}`}
                    key={candidate}
                    onClick={() => setScope(candidate)}
                  >
                    {candidate === "all"
                      ? messages.allSources
                      : candidate === "mine"
                        ? messages.createdByMe
                        : messages.teamShared}
                    <em>{scopeCounts[candidate]}</em>
                  </button>
                ))}
              </div>
            </>
          ) : null}
        </div>
        <label className="collaboration-resource-catalog-search">
          <Search aria-hidden="true" />
          <input
            data-testid={`collaboration-${kind}-search`}
            placeholder={pageCopy.search}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
      </div>

      <section className="collaboration-resource-catalog-list" data-kind={kind}>
        {visibleRows.length ? (
          <div className="collaboration-resource-catalog-list-header">
            <span>{pageCopy.title}</span>
            {kind === "agents" ? (
              <>
                <span>{messages.runStatus}</span>
                <span>{messages.resourceSource}</span>
                <span>{messages.runtime}</span>
                <span>{messages.usedBySpaces}</span>
              </>
            ) : kind === "teams" ? (
              <>
                <span>{messages.leader}</span>
                <span>{messages.memberCount}</span>
                <span>{messages.resourceSource}</span>
                <span>{messages.usedBySpaces}</span>
              </>
            ) : (
              <>
                <span>{messages.runStatus}</span>
                <span>{messages.resourceSource}</span>
                <span>{messages.toolCount}</span>
                <span>{messages.usedBySpaces}</span>
              </>
            )}
            <span aria-hidden="true" />
          </div>
        ) : null}
        {visibleRows.length ? (
          visibleRows.map((row) => (
            <article
              data-source={row.source}
              data-testid={`collaboration-${kind}-row-${row.id}`}
              key={row.id}
            >
              <span className="collaboration-resource-row-icon">
                {kind === "agents" ? (
                  <Bot aria-hidden="true" />
                ) : kind === "teams" ? (
                  <UsersRound aria-hidden="true" />
                ) : (
                  <Monitor aria-hidden="true" />
                )}
              </span>
              <span className="collaboration-resource-row-copy">
                <strong>{row.name}</strong>
                <small>{row.detail}</small>
              </span>
              {kind === "agents" ? (
                <>
                  <span
                    className="collaboration-resource-row-status"
                    data-tone={row.statusTone}
                  >
                    {row.status}
                  </span>
                  <span className="collaboration-resource-row-scope">
                    {row.source === "local" ? (
                      <ResourceSourceIcon source="local" />
                    ) : (
                      <ScopeIcon value={row.scope} />
                    )}
                    {row.source === "local"
                      ? messages.localSpaces
                      : scopeLabel(row.scope)}
                  </span>
                  <span className="collaboration-resource-row-runtime">
                    <ResourceSourceIcon source={row.source} />
                    {row.runtime}
                  </span>
                  <span className="collaboration-resource-row-detail">
                    {workspaceUsage(row)}
                  </span>
                </>
              ) : kind === "teams" ? (
                <>
                  <span className="collaboration-resource-row-leader">
                    <Bot aria-hidden="true" />
                    {row.leader}
                  </span>
                  <span className="collaboration-resource-row-members">
                    <span />
                    <span />
                    <span />
                    <em>+{Math.max(row.memberCount - 3, 0)}</em>
                  </span>
                  <span className="collaboration-resource-row-scope">
                    {row.source === "local" ? (
                      <ResourceSourceIcon source="local" />
                    ) : (
                      <ScopeIcon value={row.scope} />
                    )}
                    {row.source === "local"
                      ? messages.localSpaces
                      : scopeLabel(row.scope)}
                  </span>
                  <span className="collaboration-resource-row-detail">
                    {workspaceUsage(row)}
                  </span>
                </>
              ) : (
                <>
                  <span
                    className="collaboration-resource-row-status"
                    data-tone={row.statusTone}
                  >
                    {row.status}
                  </span>
                  <span className="collaboration-resource-row-scope">
                    {row.source === "local" ? (
                      <ResourceSourceIcon source="local" />
                    ) : (
                      <ScopeIcon value={row.scope} />
                    )}
                    {row.source === "local"
                      ? messages.localSpaces
                      : scopeLabel(row.scope)}
                  </span>
                  <span className="collaboration-resource-row-tools">
                    {row.tools.slice(0, 3).map((tool) => (
                      <em key={tool}>{tool}</em>
                    ))}
                    {row.tools.length > 3 ? (
                      <em>+{row.tools.length - 3}</em>
                    ) : null}
                  </span>
                  <span className="collaboration-resource-row-detail">
                    {workspaceUsage(row)}
                  </span>
                </>
              )}
              <span className="collaboration-resource-row-actions">
                {kind === "teams" || row.source === "cloud" ? (
                  <button
                    type="button"
                    className="collaboration-resource-bind-button"
                    data-testid={`collaboration-${kind}-bind-${row.id}`}
                    onClick={() => {
                      if (kind === "teams") {
                        const group = groups.find(
                          (candidate) => candidate.id === row.id,
                        );
                        if (group) onOpenTeamWorkspace(group.workspace_id);
                        return;
                      }
                      setBindingResourceId(row.id);
                    }}
                  >
                    {kind === "teams"
                      ? messages.resourceSettings
                      : messages.addToSpace}
                  </button>
                ) : null}
                {kind !== "teams" ? (
                  <button
                    type="button"
                    className="collaboration-resource-settings-button"
                    data-testid={`collaboration-${kind}-settings-${row.id}`}
                    onClick={() => onManageResource(kind, row.id, row.source)}
                  >
                    {messages.resourceSettings}
                  </button>
                ) : null}
              </span>
            </article>
          ))
        ) : (
          <div className="collaboration-resource-catalog-empty">
            <PageIcon aria-hidden="true" />
            <strong>
              {source === "local"
                ? kind === "agents"
                  ? messages.noLocalAgents
                  : kind === "teams"
                    ? messages.noLocalTeams
                    : messages.noLocalDevices
                : kind === "agents"
                  ? messages.noCloudAgents
                  : kind === "teams"
                    ? messages.noCloudTeams
                    : messages.noCloudDevices}
            </strong>
            <p>{pageCopy.hint}</p>
          </div>
        )}
      </section>
      {createOpen ? (
        <div
          className="collaboration-resource-dialog-backdrop"
          role="presentation"
          onMouseDown={() => setCreateOpen(false)}
        >
          <section
            className="collaboration-resource-dialog"
            role="dialog"
            aria-modal="true"
            aria-label={messages.createResourceAt}
            onMouseDown={(event) => event.stopPropagation()}
          >
            <header>
              <div>
                <h2>{messages.createResourceAt}</h2>
                <p>{messages.createResourceAtHint}</p>
              </div>
              <button
                type="button"
                aria-label={messages.cancel}
                onClick={() => setCreateOpen(false)}
              >
                <X aria-hidden="true" />
              </button>
            </header>
            <div className="collaboration-resource-create-options">
              {localWorkspace ? (
                <button
                  type="button"
                  data-testid={`collaboration-${kind}-create-local`}
                  onClick={() => {
                    setCreateOpen(false);
                    if (kind === "agents") {
                      onCreateLocalAgent();
                    } else if (kind === "teams") {
                      onCreateTeam(localWorkspace.id);
                    } else {
                      onCreateDevice("local");
                    }
                  }}
                >
                  <Laptop aria-hidden="true" />
                  <span>
                    <strong>{messages.localWorkspaceResource}</strong>
                    <small>{messages.localWorkspaceResourceHint}</small>
                  </span>
                  <ChevronRight aria-hidden="true" />
                </button>
              ) : null}
              {kind === "agents" ? (
                <>
                  <button
                    type="button"
                    data-testid="collaboration-agents-create-cloud-personal"
                    onClick={() => {
                      setCreateOpen(false);
                      onCreateAgent("default", messages.personalOwner);
                    }}
                  >
                    <UserRound aria-hidden="true" />
                    <span>
                      <strong>{messages.cloudPersonal}</strong>
                      <small>{messages.cloudPersonalHint}</small>
                    </span>
                    <ChevronRight aria-hidden="true" />
                  </button>
                  {(ownerOptions ?? [])
                    .filter((option) => option.namespace !== "default")
                    .map((option) => (
                      <button
                        type="button"
                        data-testid={`collaboration-agents-create-owner-${option.namespace}`}
                        key={option.namespace}
                        onClick={() => {
                          setCreateOpen(false);
                          onCreateAgent(option.namespace, option.label);
                        }}
                      >
                        <UsersRound aria-hidden="true" />
                        <span>
                          <strong>{option.label}</strong>
                          <small>{messages.cloudTeamHint}</small>
                        </span>
                        <ChevronRight aria-hidden="true" />
                      </button>
                    ))}
                </>
              ) : kind === "teams" ? (
                <>
                  {cloudPersonalWorkspace ? (
                    <button
                      type="button"
                      data-testid="collaboration-teams-create-cloud-personal"
                      onClick={() => {
                        setCreateOpen(false);
                        onCreateTeam(cloudPersonalWorkspace.id);
                      }}
                    >
                      <UserRound aria-hidden="true" />
                      <span>
                        <strong>{messages.cloudPersonal}</strong>
                        <small>{messages.cloudResourcesHint}</small>
                      </span>
                      <ChevronRight aria-hidden="true" />
                    </button>
                  ) : null}
                  {cloudGroupWorkspaces.map((workspace) => (
                    <button
                      type="button"
                      data-testid={`collaboration-teams-create-workspace-${workspace.id}`}
                      key={workspace.id}
                      onClick={() => {
                        setCreateOpen(false);
                        onCreateTeam(workspace.id);
                      }}
                    >
                      <UsersRound aria-hidden="true" />
                      <span>
                        <strong>{workspace.name}</strong>
                        <small>{messages.cloudTeamHint}</small>
                      </span>
                      <ChevronRight aria-hidden="true" />
                    </button>
                  ))}
                  {!cloudPersonalWorkspace && !cloudGroupWorkspaces.length ? (
                    <p>{messages.noAvailableSpaces}</p>
                  ) : null}
                </>
              ) : (
                <>
                  <button
                    type="button"
                    data-testid="collaboration-devices-create-cloud-personal"
                    onClick={() => {
                      setCreateOpen(false);
                      onCreateDevice("cloud");
                    }}
                  >
                    <UserRound aria-hidden="true" />
                    <span>
                      <strong>{messages.cloudPersonal}</strong>
                      <small>{messages.cloudPersonalHint}</small>
                    </span>
                    <ChevronRight aria-hidden="true" />
                  </button>
                  {cloudGroupWorkspaces.map((workspace) => (
                    <button
                      type="button"
                      data-testid={`collaboration-devices-create-workspace-${workspace.id}`}
                      key={workspace.id}
                      onClick={() => {
                        setCreateOpen(false);
                        onCreateDevice("cloud", workspace.id);
                      }}
                    >
                      <UsersRound aria-hidden="true" />
                      <span>
                        <strong>{workspace.name}</strong>
                        <small>{messages.cloudTeamHint}</small>
                      </span>
                      <ChevronRight aria-hidden="true" />
                    </button>
                  ))}
                  {!cloudGroupWorkspaces.length ? (
                    <p>{messages.noAvailableSpaces}</p>
                  ) : null}
                </>
              )}
            </div>
          </section>
        </div>
      ) : null}
      {bindingRow ? (
        <div
          className="collaboration-resource-dialog-backdrop"
          role="presentation"
          onMouseDown={() => setBindingResourceId(null)}
        >
          <section
            className="collaboration-resource-dialog"
            role="dialog"
            aria-modal="true"
            aria-label={messages.chooseSpace}
            onMouseDown={(event) => event.stopPropagation()}
          >
            <header>
              <div>
                <h2>{messages.chooseSpace}</h2>
                <p>{messages.chooseSpaceHint}</p>
              </div>
              <button
                type="button"
                aria-label={messages.cancel}
                onClick={() => setBindingResourceId(null)}
              >
                <X aria-hidden="true" />
              </button>
            </header>
            <div className="collaboration-resource-space-options">
              {workspaces.length ? (
                workspaces.map((workspace) => (
                  <button
                    type="button"
                    key={workspace.id}
                    data-testid={`collaboration-${kind}-space-${workspace.id}`}
                    disabled={bindingWorkspaceId === workspace.id}
                    onClick={() => {
                      setBindingWorkspaceId(workspace.id);
                      void onAddToWorkspace(workspace.id, kind, bindingRow.id)
                        .then(() => setBindingResourceId(null))
                        .finally(() => setBindingWorkspaceId(null));
                    }}
                  >
                    <FolderOpen aria-hidden="true" />
                    <span>
                      <strong>{workspace.name}</strong>
                      <small>
                        {workspace.location === "local"
                          ? messages.localStorage
                          : messages.cloudStorage}
                      </small>
                    </span>
                    <ChevronRight aria-hidden="true" />
                  </button>
                ))
              ) : (
                <p>{messages.noAvailableSpaces}</p>
              )}
            </div>
          </section>
        </div>
      ) : null}
    </div>
  );
}

function ProjectCards({
  projects,
  messages,
  onOpen,
}: {
  projects: CollaborationProject[];
  messages: PlatformMessages;
  onOpen(project: CollaborationProject): void;
}) {
  if (!projects.length) {
    return (
      <EmptyState
        title={messages.noProjects}
        description={messages.noProjectsHint}
      />
    );
  }
  return (
    <div className="collaboration-project-card-grid">
      {projects.map((project) => (
        <button
          type="button"
          className="collaboration-project-card"
          data-testid={`collaboration-project-card-${project.id}`}
          key={project.id}
          onClick={() => onOpen(project)}
        >
          <span className="collaboration-project-card-mark">
            {project.project_key.slice(0, 2)}
          </span>
          <span>
            <strong>{project.name}</strong>
            <small>{project.description || project.project_key}</small>
          </span>
          <em>{messages.enterProject} →</em>
        </button>
      ))}
    </div>
  );
}

function WorkspaceHome({
  projects,
  projectIssues,
  locale,
  messages,
  onOpenProject,
  onOpenProjects,
  onOpenIssue,
}: {
  projects: CollaborationProject[];
  projectIssues: Record<string, WorkspaceProjectIssuesSnapshot>;
  locale: CollaborationLocale;
  messages: PlatformMessages;
  onOpenProject(project: CollaborationProject): void;
  onOpenProjects(): void;
  onOpenIssue(project: CollaborationProject, issue: CollaborationIssue): void;
}) {
  const snapshot = createWorkspaceOperationsSnapshot({
    projects,
    projectIssues,
  });
  const metrics = [
    {
      id: "running",
      label: messages.running,
      value: snapshot.totals.running,
      icon: Activity,
      tone: "running",
    },
    {
      id: "review",
      label: messages.waitingReview,
      value: snapshot.totals.review,
      icon: Clock3,
      tone: "review",
    },
    {
      id: "failed",
      label: messages.failed,
      value: snapshot.totals.failed,
      icon: AlertTriangle,
      tone: "failed",
    },
    {
      id: "pending",
      label: messages.pending,
      value: snapshot.totals.pending,
      icon: CircleCheck,
      tone: "pending",
    },
  ];

  return (
    <div data-testid="collaboration-workspace-home">
      <section
        className="collaboration-workspace-operation-metrics"
        aria-label={messages.operationsOverview}
      >
        {metrics.map((metric) => {
          const Icon = metric.icon;
          return (
            <div data-tone={metric.tone} key={metric.id}>
              <span>
                <Icon aria-hidden="true" />
              </span>
              <strong>{metric.value}</strong>
              <small>{metric.label}</small>
            </div>
          );
        })}
      </section>

      <div className="collaboration-workspace-operations-layout">
        <section className="collaboration-workspace-operations-projects">
          <div className="collaboration-workspace-operations-heading">
            <div>
              <h2>{messages.operatingProjects}</h2>
              <p>{messages.operatingProjectsHint}</p>
            </div>
            <button type="button" onClick={onOpenProjects}>
              {messages.viewAll}
              <ChevronRight aria-hidden="true" />
            </button>
          </div>
          <div className="collaboration-workspace-operation-table">
            {snapshot.operations.map((operation) => {
              const projectState: WorkspaceOperationState | "idle" =
                operation.unavailable
                  ? "unavailable"
                  : operation.failedCount > 0
                    ? "failed"
                    : operation.reviewCount > 0
                      ? "review"
                      : operation.runningCount > 0
                        ? "running"
                        : "idle";
              return (
                <button
                  type="button"
                  data-testid={`collaboration-workspace-operation-project-${operation.project.id}`}
                  key={operation.project.id}
                  onClick={() => onOpenProject(operation.project)}
                >
                  <span className="collaboration-project-card-mark">
                    {operation.project.project_key.slice(0, 2)}
                  </span>
                  <span className="collaboration-workspace-operation-project-copy">
                    <strong>{operation.project.name}</strong>
                    <small>
                      {operation.unavailable
                        ? messages.unavailable
                        : `${operation.issues.length} ${messages.issues}`}
                    </small>
                  </span>
                  <OperationStateBadge
                    messages={messages}
                    state={projectState}
                  />
                  {operation.unavailable ? (
                    <span className="collaboration-workspace-operation-counts">
                      <span data-tone="failed">{messages.unavailable}</span>
                    </span>
                  ) : (
                    <span className="collaboration-workspace-operation-counts">
                      <span data-tone="running">
                        {operation.runningCount} {messages.running}
                      </span>
                      <span data-tone="review">
                        {operation.reviewCount} {messages.waitingReview}
                      </span>
                      {operation.failedCount > 0 ? (
                        <span data-tone="failed">
                          {operation.failedCount} {messages.failed}
                        </span>
                      ) : null}
                    </span>
                  )}
                  <time dateTime={operation.updatedAt}>
                    {formatOperationTime(locale, operation.updatedAt)}
                  </time>
                  <ChevronRight aria-hidden="true" />
                </button>
              );
            })}
          </div>
        </section>

        <section className="collaboration-workspace-attention">
          <div className="collaboration-workspace-operations-heading">
            <div>
              <h2>{messages.needsAttention}</h2>
              <p>
                {snapshot.totals.failed +
                  snapshot.totals.review +
                  snapshot.totals.unavailable}{" "}
                {messages.attentionCount}
              </p>
            </div>
          </div>
          {snapshot.unavailableProjects.length > 0 ||
          snapshot.attentionItems.length > 0 ? (
            <div className="collaboration-workspace-attention-list">
              {snapshot.unavailableProjects.map((operation) => (
                <button
                  type="button"
                  data-testid={`collaboration-workspace-unavailable-${operation.project.id}`}
                  key={`unavailable:${operation.project.id}`}
                  onClick={() => onOpenProject(operation.project)}
                >
                  <OperationStateBadge
                    messages={messages}
                    state="unavailable"
                  />
                  <strong>{operation.project.name}</strong>
                  <span>{messages.unavailable}</span>
                  <time dateTime={operation.updatedAt}>
                    {formatOperationTime(locale, operation.updatedAt)}
                  </time>
                </button>
              ))}
              {snapshot.attentionItems.map(({ issue, project }) => {
                const state = workspaceIssueOperationState(issue);
                return (
                  <button
                    type="button"
                    data-testid={`collaboration-workspace-attention-${issue.id}`}
                    key={issue.id}
                    onClick={() => onOpenIssue(project, issue)}
                  >
                    <OperationStateBadge messages={messages} state={state} />
                    <strong>{issue.title}</strong>
                    <span>{project.name}</span>
                    <time dateTime={issue.updated_at}>
                      {formatOperationTime(locale, issue.updated_at)}
                    </time>
                  </button>
                );
              })}
            </div>
          ) : (
            <div className="collaboration-workspace-attention-empty">
              <CircleCheck aria-hidden="true" />
              <strong>{messages.stable}</strong>
              <span>{messages.noAttention}</span>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

function OperationStateBadge({
  state,
  messages,
}: {
  state: WorkspaceOperationState | "idle";
  messages: PlatformMessages;
}) {
  const label =
    state === "failed"
      ? messages.failed
      : state === "unavailable"
        ? messages.unavailable
        : state === "review"
          ? messages.waitingReview
          : state === "running"
            ? messages.running
            : state === "pending"
              ? messages.pending
              : state === "completed"
                ? messages.stable
                : messages.idle;
  return (
    <span className="collaboration-workspace-operation-state" data-tone={state}>
      <i aria-hidden="true" />
      {label}
    </span>
  );
}

function formatOperationTime(
  locale: CollaborationLocale,
  value: string,
): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return new Intl.DateTimeFormat(locale, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

function workItemOwner(item: WorkspaceMyWorkItem, messages: PlatformMessages) {
  if (item.assignee_group_id) {
    return {
      name: item.assignee_group_name || messages.group,
      kind: messages.group,
      icon: UsersRound,
    };
  }
  if (item.assignee_team_id != null) {
    return {
      name: item.assignee_team_name || messages.group,
      kind: messages.group,
      icon: UsersRound,
    };
  }
  if (item.assignee_agent_id) {
    return {
      name: item.assignee_agent_name || messages.agent,
      kind: messages.agent,
      icon: Bot,
    };
  }
  if (item.assignee_user_id != null) {
    return {
      name: item.assignee_name || messages.human,
      kind: messages.human,
      icon: UserRound,
    };
  }
  return {
    name: messages.unassigned,
    kind: "",
    icon: UserRound,
  };
}

function workItemStep(
  item: WorkspaceMyWorkItem,
  messages: PlatformMessages,
): string {
  const nodes = item.workflow?.nodes ?? [];
  const activeIndex = nodes.findIndex((node) =>
    [
      "assigned",
      "awaiting_approval",
      "failed",
      "in_progress",
      "running",
    ].includes(node.status),
  );
  if (activeIndex >= 0) {
    return `${activeIndex + 1}/${nodes.length} ${nodes[activeIndex].name}`;
  }
  if (item.status === "in_review") return messages.waitingReview;
  if (item.execution_state) return item.execution_state.replace(/_/g, " ");
  return item.status.replace(/_/g, " ");
}

function workItemStatus(item: WorkspaceMyWorkItem, messages: PlatformMessages) {
  const state = workspaceIssueOperationState(item);
  return {
    state,
    label:
      state === "failed"
        ? messages.failed
        : state === "review"
          ? messages.waitingReview
          : state === "running"
            ? messages.running
            : state === "completed"
              ? messages.stable
              : messages.pending,
  };
}

function WorkItemRow({
  item,
  locale,
  messages,
  onOpen,
}: {
  item: WorkspaceMyWorkItem;
  locale: CollaborationLocale;
  messages: PlatformMessages;
  onOpen(item: WorkspaceMyWorkItem): void;
}) {
  const owner = workItemOwner(item, messages);
  const status = workItemStatus(item, messages);
  const OwnerIcon = owner.icon;
  return (
    <button
      type="button"
      className="collaboration-home-work-row"
      data-testid={`collaboration-home-work-${item.id}`}
      onClick={() => onOpen(item)}
    >
      <span className="collaboration-home-work-issue">
        <strong>
          #{item.sequence_number} {item.title}
        </strong>
        <small>
          {item.project_key} · {item.project_name}
        </small>
      </span>
      <span className="collaboration-home-work-owner">
        <i>
          <OwnerIcon aria-hidden="true" />
        </i>
        <span>
          <strong>{owner.name}</strong>
          <small>{owner.kind}</small>
        </span>
      </span>
      <span className="collaboration-home-work-step">
        <strong>{workItemStep(item, messages)}</strong>
        <small>{item.workflow?.orchestration_status ?? item.status}</small>
      </span>
      <OperationStateBadge messages={messages} state={status.state} />
      <time dateTime={item.updated_at}>
        {formatOperationTime(locale, item.updated_at)}
      </time>
      <ChevronRight aria-hidden="true" />
    </button>
  );
}

function FirstProjectStarter({
  messages,
  onCreate,
}: {
  messages: PlatformMessages;
  onCreate(): void;
}) {
  return (
    <section
      className="collaboration-first-project-starter"
      data-testid="collaboration-first-project-starter"
    >
      <span className="collaboration-project-card-mark">01</span>
      <div>
        <h2>{messages.firstProjectHomeTitle}</h2>
        <p>{messages.firstProjectHomeHint}</p>
      </div>
      <button
        type="button"
        className="collaboration-primary-button"
        data-testid="collaboration-first-project-create"
        onClick={onCreate}
      >
        {messages.createCollaborationProject}
      </button>
    </section>
  );
}

function IssueHomeLauncher({
  messages,
  projects,
  selectedProjectId,
  onSelectProject,
  onCreateIssue,
  pending,
  api,
  locale,
  renderTaskComposer,
}: {
  messages: PlatformMessages;
  projects: CollaborationProject[];
  selectedProjectId: string;
  onSelectProject(projectId: string): void;
  onCreateIssue(
    content: string,
    owner: IssueHomeOwner | null,
    files: File[],
  ): Promise<boolean>;
  pending: boolean;
  api: SharedWorkspaceApi;
  locale: CollaborationLocale;
  renderTaskComposer?: CollaborationPlatformHostAdapter["renderIssueComposer"];
}) {
  const [content, setContent] = useState("");
  const [members, setMembers] = useState<CollaborationMember[]>([]);
  const [mentionIssues, setMentionIssues] = useState<CollaborationIssue[]>([]);
  const [mentionAgents, setMentionAgents] = useState<WorkspaceProjectAgent[]>(
    [],
  );
  const [mentionGroups, setMentionGroups] = useState<
    import("../types").CollaborationGroup[]
  >([]);
  const [memberError, setMemberError] = useState<string | null>(null);
  const composerRef = useRef<ComposerInputHandle>(null);
  useEffect(() => {
    let active = true;
    setMembers([]);
    setMentionIssues([]);
    setMentionAgents([]);
    setMentionGroups([]);
    setMemberError(null);
    void Promise.all([
      api.members.list(selectedProjectId),
      api.issues.list(selectedProjectId),
      api.agents.list(selectedProjectId),
      api.projects.listCollaborationGroups?.(selectedProjectId) ?? [],
    ])
      .then(([items, issues, agents, groups]) => {
        if (active) {
          setMembers(items);
          setMentionIssues(issues);
          setMentionAgents(agents);
          setMentionGroups(groups);
        }
      })
      .catch(() => {
        if (active) setMemberError(messages.issueHomeMembersFailed);
      });
    return () => {
      active = false;
    };
  }, [api, selectedProjectId, messages.issueHomeMembersFailed]);
  const guides = [
    {
      title: messages.issueGuideRequirement,
      hint: messages.issueGuideRequirementHint,
    },
    {
      title: messages.issueGuideBug,
      hint: messages.issueGuideBugHint,
    },
    {
      title: messages.issueGuideReview,
      hint: messages.issueGuideReviewHint,
    },
    {
      title: messages.issueGuideResearch,
      hint: messages.issueGuideResearchHint,
    },
  ];

  const composer = (
    <IssueHomeComposer
      renderTaskComposer={renderTaskComposer}
      ref={composerRef}
      value={content}
      onChange={setContent}
      onSubmit={onCreateIssue}
      pending={pending}
      members={members}
      issues={mentionIssues}
      agents={mentionAgents}
      groups={mentionGroups}
      projects={projects}
      projectId={selectedProjectId}
      onSelectProject={(id) => {
        setMembers([]);
        setMentionIssues([]);
        onSelectProject(id);
      }}
      translate={createCollaborationTranslator(locale)}
      placeholder={messages.issueHomePlaceholder}
      projectLabel={messages.issueHomeProject}
      memberLabel={messages.members}
      error={memberError}
    />
  );
  if (renderTaskComposer)
    return (
      <div
        className="flex min-h-0 flex-1"
        data-testid="collaboration-issue-home"
      >
        {composer}
      </div>
    );

  return (
    <section
      className="collaboration-issue-home"
      data-testid="collaboration-issue-home"
    >
      <div className="collaboration-issue-home-heading">
        <h1 className="heading-md">{messages.issueHomeTitle}</h1>
        <p>{messages.issueHomeHint}</p>
      </div>
      <div className="collaboration-issue-home-guides">
        {guides.map((guide, index) => (
          <button
            type="button"
            data-testid={`collaboration-issue-guide-${index + 1}`}
            key={guide.title}
            title={guide.hint}
            disabled={pending}
            onClick={() => {
              const current = composerRef.current?.getValue() ?? content;
              const next = `${current ? `${current}\n` : ""}${guide.title}：${guide.hint}`;
              composerRef.current?.setValue(next);
              composerRef.current?.focus();
            }}
          >
            <strong>{guide.title}</strong>
          </button>
        ))}
      </div>
      <div className="collaboration-issue-home-composer">{composer}</div>
    </section>
  );
}

function WorkItemsPage({
  title,
  subtitle,
  empty,
  items,
  locale,
  messages,
  onOpenItem,
}: {
  title: string;
  subtitle: string;
  empty: string;
  items: WorkspaceMyWorkItem[];
  locale: CollaborationLocale;
  messages: PlatformMessages;
  onOpenItem(item: WorkspaceMyWorkItem): void;
}) {
  return (
    <div className="collaboration-platform-page">
      <PageHeader title={title} subtitle={subtitle} />
      {items.length ? (
        <div className="collaboration-home-work-list">
          {items.map((item) => (
            <WorkItemRow
              item={item}
              locale={locale}
              messages={messages}
              key={item.id}
              onOpen={onOpenItem}
            />
          ))}
        </div>
      ) : (
        <EmptyState title={empty} description={messages.workspaceHint} />
      )}
    </div>
  );
}

function RunCenter({
  entries,
  locale,
  messages,
}: {
  entries: Array<{
    project: CollaborationProject;
    execution: CollaborationExecution;
  }>;
  locale: CollaborationLocale;
  messages: PlatformMessages;
}) {
  return (
    <div className="collaboration-platform-page">
      <PageHeader
        title={messages.runCenter}
        subtitle={messages.operationsHint}
      />
      {entries.length ? (
        <div className="collaboration-run-center-list">
          {entries.map(({ project, execution }) => (
            <article key={`${project.id}-${execution.id}`}>
              <span>
                <strong>{execution.task_title}</strong>
                <small>
                  {project.name} · #{execution.id}
                </small>
              </span>
              <span>{execution.executor_type}</span>
              <OperationStateBadge
                messages={messages}
                state={
                  execution.status === "failed"
                    ? "failed"
                    : execution.completed_at
                      ? "completed"
                      : "running"
                }
              />
              <time dateTime={execution.updated_at}>
                {formatOperationTime(locale, execution.updated_at)}
              </time>
            </article>
          ))}
        </div>
      ) : (
        <EmptyState
          title={messages.noRuns}
          description={messages.operationsHint}
        />
      )}
    </div>
  );
}

function WorkspaceSettings({
  workspace,
  messages,
  onSave,
}: {
  workspace: CollaborationWorkspace;
  messages: PlatformMessages;
  onSave(input: {
    version: number;
    name: string;
    description: string;
  }): Promise<void>;
}) {
  const [name, setName] = useState(workspace.name);
  const [description, setDescription] = useState(workspace.description);
  const [saving, setSaving] = useState(false);
  return (
    <section className="collaboration-platform-panel collaboration-workspace-settings">
      <h2>{messages.settings}</h2>
      <p>{messages.workspaceSettingsHint}</p>
      <label>
        {messages.name}
        <input value={name} onChange={(event) => setName(event.target.value)} />
      </label>
      <label>
        {messages.description}
        <textarea
          value={description}
          onChange={(event) => setDescription(event.target.value)}
        />
      </label>
      <button
        type="button"
        className="collaboration-primary-button"
        data-testid="collaboration-workspace-settings-save"
        disabled={saving || !name.trim()}
        onClick={() => {
          setSaving(true);
          void onSave({
            version: workspace.version,
            name: name.trim(),
            description: description.trim(),
          }).finally(() => setSaving(false));
        }}
      >
        {messages.save}
      </button>
    </section>
  );
}

function RootTeamCreator({
  api,
  workspace,
  groups,
  locale,
  onClose,
  onCreated,
}: {
  api: SharedWorkspaceApi;
  workspace: CollaborationWorkspace;
  groups: CollaborationGroup[];
  locale: CollaborationLocale;
  onClose(): void;
  onCreated(): Promise<void>;
}) {
  const [members, setMembers] = useState<CollaborationMember[]>([]);
  const [agents, setAgents] = useState<CollaborationOwnedAgent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    if (!api.workspaces) {
      setError("Workspace API is unavailable");
      setLoading(false);
      return;
    }
    void Promise.all([
      api.workspaces.listMembers(workspace.id),
      api.workspaces.listAgents(workspace.id),
    ])
      .then(([nextMembers, nextAgents]) => {
        if (!active) return;
        setMembers(nextMembers);
        setAgents(nextAgents);
      })
      .catch((cause) => {
        if (!active) return;
        setError(cause instanceof Error ? cause.message : String(cause));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [api.workspaces, workspace.id]);

  const commands = useMemo<WorkspaceResourceCommands>(() => {
    if (!api.workspaces) {
      throw new Error("Workspace API is unavailable");
    }
    return {
      searchUsers: (query) => api.members.searchUsers(query),
      addMember: (userId, role) =>
        api.workspaces!.addMember(workspace.id, { userId, role }),
      updateMember: (userId, inputRole) =>
        api.workspaces!.updateMember(workspace.id, userId, {
          role: inputRole,
        }),
      removeMember: (userId) =>
        api.workspaces!.removeMember(workspace.id, userId),
      async createCollaborationGroup(input) {
        const created = await api.workspaces!.createCollaborationGroup(
          workspace.id,
          input,
        );
        await onCreated();
        return created;
      },
      updateCollaborationGroup: (groupId, input) =>
        api.workspaces!.updateCollaborationGroup(workspace.id, groupId, input),
      removeCollaborationGroup: (groupId) =>
        api.workspaces!.removeCollaborationGroup(workspace.id, groupId),
    };
  }, [api.members, api.workspaces, onCreated, workspace.id]);

  if (loading || error) {
    return (
      <div className="collaboration-dialog-backdrop" role="presentation">
        <section className="collaboration-resource-dialog" role="dialog">
          <header>
            <div>
              <h2>{locale === "zh-CN" ? "新建小队" : "New team"}</h2>
              <p>
                {error ??
                  (locale === "zh-CN"
                    ? "正在加载空间成员与智能体…"
                    : "Loading workspace members and agents…")}
              </p>
            </div>
            <button type="button" onClick={onClose}>
              <X aria-hidden="true" />
            </button>
          </header>
        </section>
      </div>
    );
  }

  return (
    <WorkspaceCollaborationGroupsConfiguration
      workspace={workspace}
      groups={groups}
      members={members}
      agents={agents}
      locale={locale}
      commands={commands}
      initialCreateOpen
      onCreateOpenChange={(open) => {
        if (!open) onClose();
      }}
    />
  );
}

export function CollaborationPlatformApp({
  api,
  refreshKey,
  navigationApis,
  host,
  locale = "zh-CN",
  onCreateTask,
  onReady,
  renderProject,
  renderShell,
  sidebarFooter,
}: {
  api: SharedWorkspaceApi;
  refreshKey?: string;
  navigationApis?: SharedWorkspaceApi[];
  host: CollaborationPlatformHostAdapter;
  locale?: CollaborationLocale;
  onCreateTask?(
    project: CollaborationProject,
    issue: CollaborationIssue,
    workflowStep?: string,
  ): void;
  onReady?(): void;
  renderProject?(context: CollaborationProjectRendererContext): React.ReactNode;
  renderShell?(shell: {
    main: React.ReactNode;
    sidebar: React.ReactNode;
  }): React.ReactNode;
  sidebarFooter?: React.ReactNode;
}) {
  const messages = platformMessages[locale];
  const translate = createCollaborationTranslator(locale);
  const { state, commands } = useCollaborationPlatformController({
    api,
    navigationApis,
    location: host.location,
    loadFailedMessage: messages.loadFailed,
    refreshKey,
  });
  const [workspaceDialogOpen, setWorkspaceDialogOpen] = useState(false);
  const [projectDialogOpen, setProjectDialogOpen] = useState(false);
  const [projectWorkspaceId, setProjectWorkspaceId] = useState<string | null>(
    null,
  );
  const [workspacePickerOpen, setWorkspacePickerOpen] = useState(false);
  const [rootAgentForm, setRootAgentForm] = useState<{
    mode: "create" | "edit";
    source: ResourceSource;
    namespace: string;
    ownerLabel: string;
    resourceId?: string;
    teamId?: number;
  } | null>(null);
  const [rootDeviceCreator, setRootDeviceCreator] = useState<{
    source: ResourceSource;
    workspaceId?: string;
  } | null>(null);
  const [rootTeamCreationWorkspaceId, setRootTeamCreationWorkspaceId] =
    useState<string | null>(null);
  const [rootIssueProjectId, setRootIssueProjectId] = useState<string | null>(
    null,
  );
  const [rootIssueLoading, setRootIssueLoading] = useState(false);
  const rootIssueSubmitting = useRef(false);
  const projectWorkspace =
    projectWorkspaceId == null
      ? null
      : (state.workspaces.find(
          (workspace) => workspace.id === projectWorkspaceId,
        ) ??
        (state.workspace?.id === projectWorkspaceId ? state.workspace : null));
  const projectWorkspaceOwnerLabel =
    projectWorkspace == null
      ? null
      : (host.workspaceOwnerOptions?.find(
          (option) => option.namespace === projectWorkspace.namespace,
        )?.label ??
        (projectWorkspace.namespace === "default"
          ? messages.personalOwner
          : projectWorkspace.namespace));
  const workspaceLocations = host.capabilities.workspaceLocations ?? ["cloud"];
  const canCreateCloudWorkspace = workspaceLocations.includes("cloud");
  const rootIssueProject =
    state.projects.find((project) => project.id === rootIssueProjectId) ??
    state.projects[0] ??
    null;
  useEffect(() => {
    if (!state.loading && !state.error) onReady?.();
  }, [onReady, state.error, state.loading]);
  const scopedApi = useMemo<SharedWorkspaceApi>(() => {
    if (!host.location.workspaceId) return api;
    const workspaceId = host.location.workspaceId;
    const projectId = host.location.projectId;
    const hasFullWorkspaceAccess = state.workspace?.id === workspaceId;
    return {
      ...api,
      projects: {
        ...api.projects,
        list: async () => {
          const projects = await (hasFullWorkspaceAccess
            ? api.projects.list(workspaceId)
            : api.projects.list());
          if (hasFullWorkspaceAccess || !projectId) return projects;
          return projects.filter((project) => project.id === projectId);
        },
        create: (input) => api.projects.create({ ...input, workspaceId }),
      },
    };
  }, [
    api,
    host.location.projectId,
    host.location.workspaceId,
    state.workspace,
  ]);
  const workspaceAgentConfigurationApi = useMemo(
    () =>
      host.location.workspaceId
        ? createWorkspaceAgentConfigurationApi(api, host.location.workspaceId)
        : api,
    [api, host.location.workspaceId],
  );
  const projectResourceAgents = useMemo(() => {
    const agents = new Map<number, CollaborationOwnedAgent>();
    for (const agent of [...state.resources.agents, ...state.agents]) {
      if (agent.team_id != null) agents.set(agent.team_id, agent);
    }
    return [...agents.values()];
  }, [state.agents, state.resources.agents]);
  const projectResourceEnvironments = useMemo(() => {
    const environments = new Map<number, CollaborationExecutionEnvironment>();
    for (const environment of [
      ...state.resources.execution_environments,
      ...state.executionEnvironments,
    ]) {
      if (environment.device_id != null) {
        environments.set(environment.device_id, environment);
      }
    }
    return [...environments.values()];
  }, [state.executionEnvironments, state.resources.execution_environments]);

  const openProject = (project: CollaborationProject) =>
    navigateWithin(host, {
      workspaceId: project.workspace_id,
      workspaceView: "projects",
      projectId: project.id,
      projectView: "board",
      issueId: null,
    });
  const startProjectCreation = () => {
    if (state.workspace) {
      setProjectWorkspaceId(state.workspace.id);
      setProjectDialogOpen(true);
      return;
    }
    if (state.workspaces.length === 1) {
      setProjectWorkspaceId(state.workspaces[0].id);
      setProjectDialogOpen(true);
      return;
    }
    setWorkspacePickerOpen(true);
  };
  const startRootIssueCreation = async (
    content: string,
    owner: IssueHomeOwner | null,
    files: File[],
  ) => {
    if (!rootIssueProject || rootIssueSubmitting.current || !content.trim())
      return false;
    rootIssueSubmitting.current = true;
    setRootIssueLoading(true);
    try {
      const created = await api.issues.create(rootIssueProject.id, {
        title: truncateRuntimeTaskTitle(content.replace(/\s+/g, " "))!,
        description: content,
      });
      let assignmentFailed = false;
      for (const file of files) {
        try {
          await api.attachments.upload(created.id, file);
        } catch (error) {
          host.notify?.(
            error instanceof Error ? error.message : messages.loadFailed,
            "error",
          );
        }
      }
      if (owner) {
        try {
          const current = await api.issues.get(created.id);
          await api.issues.update(created.id, {
            version: current.version,
            ...(owner.kind === "user"
              ? { assigneeUserId: Number(owner.id) }
              : owner.kind === "agent"
                ? { assigneeAgentId: owner.id }
                : { assigneeGroupId: owner.id }),
          });
        } catch {
          assignmentFailed = true;
        }
      }
      if (assignmentFailed)
        host.notify?.(messages.issueHomeAssignmentFailed, "error");
      navigateWithin(host, {
        workspaceId: rootIssueProject.workspace_id,
        workspaceView: "projects",
        projectId: rootIssueProject.id,
        projectView: "board",
        issueId: created.id,
      });
      return true;
    } catch (error) {
      host.notify?.(
        error instanceof Error ? error.message : messages.loadFailed,
        "error",
      );
      return false;
    } finally {
      rootIssueSubmitting.current = false;
      setRootIssueLoading(false);
    }
  };
  const openMyWorkItem = (item: WorkspaceMyWorkItem) => {
    const project = state.projects.find(
      (candidate) => candidate.id === item.cloud_project_id,
    );
    if (!project?.workspace_id) return;
    navigateWithin(host, {
      workspaceId: project.workspace_id,
      workspaceView: "projects",
      projectId: project.id,
      projectView: "board",
      issueId: item.id,
    });
  };
  const openResourceWorkspace = (
    workspaceId: string,
    kind: ResourceCatalogKind,
  ) => {
    const workspaceViews: Record<
      ResourceCatalogKind,
      CollaborationWorkspaceView
    > = {
      agents: "agents",
      teams: "collaboration-groups",
      devices: "execution-environments",
    };
    navigateWithin(host, {
      workspaceId,
      workspaceView: workspaceViews[kind],
      projectId: null,
      projectView: "board",
      issueId: null,
    });
  };
  const bindRootResource = async (
    workspaceId: string,
    kind: ResourceCatalogKind,
    resourceId: string,
  ) => {
    if (!api.workspaces) throw new Error("Workspace API is unavailable");
    try {
      if (kind === "agents") {
        const agent = state.resources.agents.find(
          (candidate) => candidate.id === resourceId,
        );
        if (agent?.location === "local") {
          const workspace = state.workspaces.find(
            (candidate) => candidate.id === workspaceId,
          );
          if (workspace?.location !== "local") {
            throw new Error(
              locale === "zh-CN"
                ? "本地智能体只能在本地空间中使用"
                : "Local Agents can only be used in the local space",
            );
          }
          host.notify?.(messages.bindingsSaved, "success");
          return;
        }
        if (!agent?.team_id) throw new Error("Agent cannot be authorized");
        await api.workspaces.addAgent(workspaceId, { teamId: agent.team_id });
      } else if (kind === "devices") {
        const environment = state.resources.execution_environments.find(
          (candidate) => candidate.id === resourceId,
        );
        if (!environment?.device_id) {
          throw new Error("Execution environment cannot be authorized");
        }
        await api.workspaces.addExecutionEnvironment(workspaceId, {
          deviceId: environment.device_id,
        });
      } else {
        openResourceWorkspace(workspaceId, kind);
        return;
      }
      await commands.reload();
      host.notify?.(messages.bindingsSaved, "success");
    } catch (error) {
      host.notify?.(
        error instanceof Error ? error.message : messages.loadFailed,
        "error",
      );
      throw error;
    }
  };
  const manageRootResource = (
    kind: ResourceCatalogKind,
    resourceId?: string,
    source?: ResourceSource,
  ) => {
    if (kind === "devices") {
      host.manageResource?.("environments", resourceId, source);
      return;
    }
    if (kind === "teams") return;
    const agent = state.resources.agents.find(
      (candidate) => candidate.id === resourceId,
    );
    if (agent?.location === "local") {
      if (host.projectAgentConfiguration?.renderLocalAgentEditor) {
        setRootAgentForm({
          mode: "edit",
          source: "local",
          namespace: "default",
          ownerLabel: agent.owner_name,
          resourceId: agent.id,
        });
      }
      return;
    }
    if (!agent?.team_id || !host.projectAgentConfiguration?.renderAgentEditor) {
      host.manageResource?.("agents", resourceId);
      return;
    }
    const ownerLabel =
      host.workspaceOwnerOptions?.find(
        (option) => option.namespace === agent.owner_id,
      )?.label ?? agent.owner_name;
    setRootAgentForm({
      mode: "edit",
      source: agent.location ?? "cloud",
      namespace: agent.owner_type === "user" ? "default" : agent.owner_id,
      ownerLabel,
      teamId: agent.team_id,
    });
  };
  let content: React.ReactNode;
  if (state.loading) {
    content = (
      <div className="collaboration-loading">
        {translate("common.loading", "正在加载…")}
      </div>
    );
  } else if (state.error) {
    content = (
      <div className="collaboration-alert" role="alert">
        {state.error}
      </div>
    );
  } else if (
    host.location.projectId &&
    (state.workspace || state.workspaceNavigationContext)
  ) {
    const workspaceContext =
      state.workspace ?? state.workspaceNavigationContext;
    const selectedProject =
      state.projects.find(
        (project) => String(project.id) === host.location.projectId,
      ) ?? null;
    content =
      selectedProject && renderProject && workspaceContext ? (
        renderProject({ project: selectedProject, workspace: workspaceContext })
      ) : (
        <CollaborationApp
          api={scopedApi}
          locale={locale}
          showProjectBack={false}
          host={{
            capabilities: {
              automation: host.capabilities.automation,
              dingtalkAitable: host.capabilities.dingtalkAitable,
              projectLocation: host.capabilities.projectLocation,
            },
            location: {
              projectId: host.location.projectId,
              issueId: host.location.issueId,
              view: host.location.projectView,
            },
            navigate: (location) =>
              navigateWithin(host, {
                projectId: location.projectId,
                issueId: location.issueId,
                projectView: location.view,
                workspaceView: "projects",
              }),
            notify: host.notify,
            openExternal: host.openExternal,
            manageResource: host.manageResource,
            projectAgentConfiguration: host.projectAgentConfiguration,
            projectAgentResourceContext: {
              name: workspaceContext!.name,
              namespace:
                "namespace" in workspaceContext!
                  ? workspaceContext!.namespace
                  : "default",
            },
          }}
          onCreateTask={onCreateTask}
        />
      );
  } else if (!state.workspace) {
    const rootView = host.location.rootView ?? "home";
    const inboxItems = state.myWork.filter((item) => {
      const operation = workspaceIssueOperationState(item);
      return item.is_unread || operation === "failed" || operation === "review";
    });
    content =
      rootView === "agents" ||
      rootView === "teams" ||
      rootView === "devices" ? (
        <ResourceCatalogPage
          kind={rootView}
          agents={state.resources.agents}
          groups={state.collaborationGroups}
          environments={state.resources.execution_environments}
          canCreateDevice={Boolean(host.renderDeviceCreator)}
          workspaces={state.workspaces}
          ownerOptions={host.workspaceOwnerOptions}
          messages={messages}
          onAddToWorkspace={bindRootResource}
          onCreateAgent={(namespace, ownerLabel) =>
            setRootAgentForm({
              mode: "create",
              source: "cloud",
              namespace,
              ownerLabel,
            })
          }
          onCreateDevice={(source, workspaceId) =>
            setRootDeviceCreator({ source, workspaceId })
          }
          onCreateLocalAgent={() =>
            setRootAgentForm({
              mode: "create",
              source: "local",
              namespace: "default",
              ownerLabel: messages.localWorkspaceResource,
            })
          }
          onCreateTeam={(workspaceId) =>
            setRootTeamCreationWorkspaceId(workspaceId)
          }
          onManageResource={manageRootResource}
          onOpenTeamWorkspace={(workspaceId) =>
            openResourceWorkspace(workspaceId, "teams")
          }
        />
      ) : rootView === "runs" ? (
        <RunCenter
          entries={state.executions}
          locale={locale}
          messages={messages}
        />
      ) : rootView === "my-work" ? (
        <WorkItemsPage
          title={messages.myWork}
          subtitle={messages.workspaceHint}
          empty={messages.noActiveWork}
          items={state.myWork}
          locale={locale}
          messages={messages}
          onOpenItem={openMyWorkItem}
        />
      ) : rootView === "inbox" ? (
        <WorkItemsPage
          title={messages.inbox}
          subtitle={messages.needsYourAction}
          empty={messages.noInboxItems}
          items={inboxItems}
          locale={locale}
          messages={messages}
          onOpenItem={openMyWorkItem}
        />
      ) : (
        <div
          className={
            host.renderIssueComposer && state.projects.length
              ? "collaboration-task-home-page"
              : "collaboration-platform-page collaboration-home-page"
          }
        >
          {!state.workspaces.length ? (
            <>
              <PageHeader
                title={messages.issueHomeTitle}
                subtitle={messages.issueHomeHint}
              />
              <EmptyState
                title={messages.noSpaces}
                description={messages.noSpacesHint}
                action={
                  canCreateCloudWorkspace ? (
                    <button
                      type="button"
                      className="collaboration-primary-button"
                      onClick={() => setWorkspaceDialogOpen(true)}
                    >
                      {messages.createWorkspace}
                    </button>
                  ) : null
                }
              />
            </>
          ) : !state.projects.length ? (
            <>
              <PageHeader
                title={messages.issueHomeTitle}
                subtitle={messages.issueHomeHint}
              />
              <FirstProjectStarter
                messages={messages}
                onCreate={startProjectCreation}
              />
            </>
          ) : (
            <IssueHomeLauncher
              renderTaskComposer={host.renderIssueComposer}
              api={api}
              locale={locale}
              messages={messages}
              projects={state.projects}
              selectedProjectId={rootIssueProject?.id ?? ""}
              onSelectProject={setRootIssueProjectId}
              pending={rootIssueLoading}
              onCreateIssue={(content, memberIds, files) =>
                startRootIssueCreation(content, memberIds, files)
              }
            />
          )}
        </div>
      );
  } else {
    const workspace = state.workspace;
    const canManageWorkspace =
      workspace.access_role === "Owner" ||
      workspace.access_role === "Maintainer";
    const requestedWorkspaceSettingsView =
      host.location.workspaceView === "settings" ||
      host.location.workspaceView === "members" ||
      host.location.workspaceView === "agents" ||
      host.location.workspaceView === "collaboration-participants" ||
      host.location.workspaceView === "collaboration-groups" ||
      host.location.workspaceView === "execution-environments"
        ? host.location.workspaceView
        : null;
    const workspaceSettingsView =
      requestedWorkspaceSettingsView === "members" ||
      requestedWorkspaceSettingsView === "agents" ||
      requestedWorkspaceSettingsView === "collaboration-groups"
        ? "collaboration-participants"
        : requestedWorkspaceSettingsView;
    const initialWorkspaceParticipantTab =
      requestedWorkspaceSettingsView === "members"
        ? "members"
        : requestedWorkspaceSettingsView === "collaboration-groups"
          ? "groups"
          : "agents";
    const createProjectAction = (
      <button
        type="button"
        className="collaboration-primary-button"
        data-testid="collaboration-workspace-project-create"
        onClick={startProjectCreation}
      >
        ＋ {messages.createProject}
      </button>
    );
    if (workspaceSettingsView) {
      const workspaceSettingsSections = [
        ...(canManageWorkspace
          ? [
              {
                id: "settings",
                label: messages.basicInformation,
                testId: "collaboration-workspace-nav-settings",
                content: (
                  <div className="collaboration-platform-page collaboration-workspace-settings-page">
                    <PageHeader
                      title={messages.basicInformation}
                      subtitle={`${messages.settings} · ${workspace.name}`}
                    />
                    <WorkspaceSettings
                      workspace={workspace}
                      messages={messages}
                      onSave={async (input) => {
                        await commands.updateWorkspace(input);
                        host.notify?.(messages.save, "success");
                      }}
                    />
                  </div>
                ),
              },
            ]
          : []),
        {
          id: "collaboration-participants",
          label: messages.collaborationParticipants,
          testId: "collaboration-workspace-nav-participants",
          content: (
            <div className="collaboration-platform-page collaboration-workspace-settings-page">
              <PageHeader
                title={messages.collaborationParticipants}
                subtitle={messages.collaborationParticipantsHint}
              />
              <CollaborationParticipantsTabs
                agentsContent={
                  <ProjectAgentConfiguration
                    api={workspaceAgentConfigurationApi}
                    canManage={
                      workspace.access_role === "Owner" ||
                      workspace.access_role === "Maintainer" ||
                      workspace.access_role === "Developer"
                    }
                    host={host.projectAgentConfiguration}
                    project={{
                      id: workspace.id,
                      name: workspace.name,
                      namespace: workspace.namespace,
                      workspace_id: null,
                      project_store:
                        workspace.location === "local" ? "local" : "backend",
                    }}
                    onError={() => host.notify?.(messages.loadFailed, "error")}
                    scope="workspace"
                    translate={translate}
                  />
                }
                agentsLabel={messages.agents}
                ariaLabel={messages.collaborationParticipants}
                groupsContent={
                  <WorkspaceCollaborationGroupsConfiguration
                    workspace={workspace}
                    groups={state.collaborationGroups}
                    members={state.members}
                    agents={state.agents}
                    locale={locale}
                    commands={commands}
                  />
                }
                groupsLabel={messages.collaborationGroups}
                initialTab={initialWorkspaceParticipantTab}
                membersContent={
                  <WorkspaceMembersConfiguration
                    workspace={workspace}
                    members={state.members}
                    locale={locale}
                    commands={commands}
                  />
                }
                membersLabel={messages.members}
                testIdPrefix="collaboration-workspace-participants"
              />
            </div>
          ),
        },
        {
          id: "execution-environments",
          label: messages.environments,
          testId: "collaboration-workspace-nav-execution-environments",
          content: (
            <ProjectExecutionEnvironments
              api={api}
              workspace={workspace}
              translate={translate}
            />
          ),
        },
      ];
      content = (
        <ProjectSettingsShell
          ariaLabel={`${messages.settings} · ${workspace.name}`}
          testId="workspace-settings-shell"
          selectedSectionId={workspaceSettingsView}
          onSectionChange={(sectionId) =>
            navigateWithin(host, {
              workspaceView: sectionId as CollaborationWorkspaceView,
              projectId: null,
              issueId: null,
            })
          }
          sections={workspaceSettingsSections}
        />
      );
    } else {
      content = (
        <div className="collaboration-platform-page">
          <PageHeader
            title={
              host.location.workspaceView === "projects"
                ? messages.allProjects
                : workspace.name
            }
            subtitle={
              host.location.workspaceView === "projects"
                ? messages.noProjectsHint
                : messages.operationsHint
            }
            action={
              <div className="collaboration-platform-page-actions">
                {host.location.workspaceView === "home" &&
                canManageWorkspace ? (
                  <button
                    type="button"
                    className="collaboration-platform-secondary-button"
                    data-testid="collaboration-workspace-home-settings"
                    onClick={() =>
                      navigateWithin(host, {
                        workspaceView: "settings",
                        projectId: null,
                        issueId: null,
                      })
                    }
                  >
                    <Settings aria-hidden="true" />
                    {messages.settings}
                  </button>
                ) : null}
                {createProjectAction}
              </div>
            }
          />
          {host.location.workspaceView === "home" ? (
            state.projects.length === 0 ? (
              <section
                className="collaboration-workspace-starter"
                data-testid="collaboration-workspace-starter"
              >
                <small>{messages.firstUseProgress}</small>
                <h2>{messages.firstProjectTitle}</h2>
                <p>{messages.firstProjectHint}</p>
                <div>
                  <button
                    type="button"
                    className="collaboration-primary-button"
                    data-testid="collaboration-workspace-starter-create-project"
                    onClick={startProjectCreation}
                  >
                    {messages.createProject}
                  </button>
                  <button
                    type="button"
                    data-testid="collaboration-workspace-starter-configure-agents"
                    onClick={() =>
                      navigateWithin(host, {
                        workspaceView: "collaboration-participants",
                        projectId: null,
                        issueId: null,
                      })
                    }
                  >
                    {messages.configureAgents}
                  </button>
                  <button
                    type="button"
                    data-testid="collaboration-workspace-starter-invite-members"
                    onClick={() =>
                      navigateWithin(host, {
                        workspaceView: "members",
                        projectId: null,
                        issueId: null,
                      })
                    }
                  >
                    {messages.inviteMembers}
                  </button>
                </div>
              </section>
            ) : (
              <WorkspaceHome
                projects={state.projects}
                projectIssues={state.projectIssues}
                locale={locale}
                messages={messages}
                onOpenProject={openProject}
                onOpenProjects={() =>
                  navigateWithin(host, {
                    workspaceView: "projects",
                    projectId: null,
                    issueId: null,
                  })
                }
                onOpenIssue={(project, issue) =>
                  navigateWithin(host, {
                    workspaceView: "projects",
                    projectId: project.id,
                    projectView: "board",
                    issueId: issue.id,
                  })
                }
              />
            )
          ) : null}
          {host.location.workspaceView === "projects" ? (
            <section className="collaboration-platform-panel">
              <h2>{messages.projects}</h2>
              <ProjectCards
                projects={state.projects}
                messages={messages}
                onOpen={openProject}
              />
            </section>
          ) : null}
        </div>
      );
    }
  }

  const sidebar = (
    <CollaborationPlatformNavigation
      host={host}
      messages={messages}
      workspaces={state.workspaces}
      workspaceNavigationContext={state.workspaceNavigationContext}
      projects={state.navigationProjects}
      onCreateWorkspace={() => setWorkspaceDialogOpen(true)}
      onNewConversation={(projectId) => {
        setRootIssueProjectId(projectId);
        host.navigate({
          platformView: "spaces",
          rootView: "home",
          workspaceId: null,
          workspaceView: "home",
          projectId: null,
          projectView: "board",
          issueId: null,
        });
      }}
      footer={sidebarFooter}
    />
  );
  const main = <main className="collaboration-platform-main">{content}</main>;

  return (
    <section
      className={renderShell ? undefined : "collaboration-platform-app"}
      data-testid="collaboration-platform-root"
      style={renderShell ? { height: "100%", minHeight: 0 } : undefined}
    >
      {renderShell ? (
        renderShell({ main, sidebar })
      ) : (
        <>
          {sidebar}
          {main}
        </>
      )}
      {workspaceDialogOpen ? (
        <WorkspaceCreateDialog
          messages={messages}
          ownerOptions={host.workspaceOwnerOptions}
          onClose={() => setWorkspaceDialogOpen(false)}
          onCreate={async (input) => {
            const workspace = await commands.createWorkspace(input);
            setWorkspaceDialogOpen(false);
            navigateWithin(host, {
              workspaceId: workspace.id,
              workspaceView: "home",
              projectId: null,
              issueId: null,
            });
          }}
        />
      ) : null}
      {workspacePickerOpen ? (
        <WorkspaceProjectPicker
          messages={messages}
          workspaces={state.workspaces}
          onClose={() => setWorkspacePickerOpen(false)}
          onSelect={(workspaceId) => {
            setWorkspacePickerOpen(false);
            setProjectWorkspaceId(workspaceId);
            setProjectDialogOpen(true);
          }}
        />
      ) : null}
      {projectDialogOpen && projectWorkspaceId ? (
        <ProjectCreateDialog
          targets={[
            {
              location: host.capabilities.projectLocation ?? "cloud",
              create: (input) =>
                state.workspace?.id === projectWorkspaceId
                  ? commands.createProject(input)
                  : api.projects.create({
                      ...input,
                      workspaceId: projectWorkspaceId,
                    }),
            },
          ]}
          defaultLocation={host.capabilities.projectLocation ?? "cloud"}
          allowDingTalkAITable={host.capabilities.dingtalkAitable}
          labels={projectCreateLabels[locale]}
          workspaceContext={
            projectWorkspace && projectWorkspaceOwnerLabel
              ? {
                  name: projectWorkspace.name,
                  owner: `${messages.owner}${
                    locale === "zh-CN" ? "：" : ": "
                  }${projectWorkspaceOwnerLabel}`,
                }
              : undefined
          }
          resourceSetup={
            state.workspace?.id === projectWorkspaceId
              ? {
                  workspaceName: state.workspace.name,
                  members: state.members,
                  agents: projectResourceAgents,
                  executionEnvironments: projectResourceEnvironments,
                  configure: async (project, selection) => {
                    const existingMembers = await api.members.list(project.id);
                    const existingMemberIds = new Set(
                      existingMembers.map((member) => member.user_id),
                    );
                    const selectedAgents = projectResourceAgents.filter(
                      (agent) =>
                        agent.team_id != null &&
                        selection.agentTeamIds.includes(agent.team_id),
                    );
                    await Promise.all([
                      ...selection.memberUserIds
                        .filter((userId) => !existingMemberIds.has(userId))
                        .map((userId) =>
                          api.members.add(project.id, userId, "Developer"),
                        ),
                      ...selection.executionEnvironmentDeviceIds.map(
                        (deviceId) =>
                          api.projects.addExecutionEnvironment(
                            project.id,
                            deviceId,
                          ),
                      ),
                    ]);
                    await Promise.all(
                      selectedAgents.map((agent) =>
                        api.agents.create(
                          project.id,
                          createWegentProjectAgentInput(agent),
                        ),
                      ),
                    );
                  },
                }
              : undefined
          }
          testIds={{
            name: "collaboration-project-name-input",
            description: "collaboration-project-description-input",
            confirm: "collaboration-project-create-confirm",
          }}
          onClose={() => {
            setProjectDialogOpen(false);
            setProjectWorkspaceId(null);
          }}
          onCreated={(project) => {
            setProjectDialogOpen(false);
            setProjectWorkspaceId(null);
            openProject(project);
          }}
        />
      ) : null}
      {rootAgentForm?.mode === "create" &&
      rootAgentForm.source === "local" &&
      host.projectAgentConfiguration?.renderLocalAgentCreator
        ? host.projectAgentConfiguration.renderLocalAgentCreator({
            onClose: () => setRootAgentForm(null),
            onCreated: async () => {
              setRootAgentForm(null);
              await commands.reload();
              host.notify?.(messages.resourceSaved, "success");
            },
          })
        : null}
      {rootAgentForm?.mode === "create" &&
      rootAgentForm.source === "cloud" &&
      host.projectAgentConfiguration?.renderAgentCreator
        ? host.projectAgentConfiguration.renderAgentCreator({
            namespace: rootAgentForm.namespace,
            workspaceName: rootAgentForm.ownerLabel,
            onClose: () => setRootAgentForm(null),
            onCreated: async () => {
              setRootAgentForm(null);
              await commands.reload();
              host.notify?.(messages.resourceSaved, "success");
            },
          })
        : null}
      {rootAgentForm?.mode === "edit" &&
      rootAgentForm.source === "local" &&
      host.projectAgentConfiguration?.renderLocalAgentEditor
        ? host.projectAgentConfiguration.renderLocalAgentEditor({
            resourceId: rootAgentForm.resourceId ?? "",
            onClose: () => setRootAgentForm(null),
            onSaved: async () => {
              setRootAgentForm(null);
              await commands.reload();
              host.notify?.(messages.resourceSaved, "success");
            },
          })
        : null}
      {rootDeviceCreator && host.renderDeviceCreator
        ? host.renderDeviceCreator({
            source: rootDeviceCreator.source,
            workspaceId: rootDeviceCreator.workspaceId,
            hasCloudDevice: state.resources.execution_environments.some(
              (environment) => environment.kind === "cloud_host",
            ),
            onClose: () => setRootDeviceCreator(null),
            onCreated: async (deviceId) => {
              if (deviceId && rootDeviceCreator.workspaceId && api.workspaces) {
                await api.workspaces.addExecutionEnvironment(
                  rootDeviceCreator.workspaceId,
                  { deviceId },
                );
              }
              setRootDeviceCreator(null);
              await commands.reload();
              host.notify?.(messages.resourceSaved, "success");
            },
          })
        : null}
      {rootTeamCreationWorkspaceId
        ? (() => {
            const workspace = state.workspaces.find(
              (candidate) => candidate.id === rootTeamCreationWorkspaceId,
            );
            if (!workspace) return null;
            return (
              <RootTeamCreator
                api={api}
                workspace={workspace}
                groups={state.collaborationGroups.filter(
                  (group) => group.workspace_id === workspace.id,
                )}
                locale={locale}
                onClose={() => setRootTeamCreationWorkspaceId(null)}
                onCreated={async () => {
                  setRootTeamCreationWorkspaceId(null);
                  await commands.reload();
                  host.notify?.(messages.resourceSaved, "success");
                }}
              />
            );
          })()
        : null}
      {rootAgentForm?.mode === "edit" &&
      rootAgentForm.source === "cloud" &&
      rootAgentForm.teamId &&
      host.projectAgentConfiguration?.renderAgentEditor
        ? host.projectAgentConfiguration.renderAgentEditor({
            agent: { teamId: rootAgentForm.teamId },
            namespace: rootAgentForm.namespace,
            workspaceName: rootAgentForm.ownerLabel,
            onClose: () => setRootAgentForm(null),
            onSaved: async () => {
              setRootAgentForm(null);
              await commands.reload();
              host.notify?.(messages.resourceSaved, "success");
            },
          })
        : null}
    </section>
  );
}

function WorkspaceProjectPicker({
  messages,
  workspaces,
  onClose,
  onSelect,
}: {
  messages: PlatformMessages;
  workspaces: CollaborationWorkspace[];
  onClose(): void;
  onSelect(workspaceId: string): void;
}) {
  return (
    <div className="collaboration-dialog-backdrop">
      <section
        className="collaboration-dialog collaboration-workspace-picker"
        role="dialog"
        aria-modal="true"
        aria-label={messages.chooseProjectWorkspace}
      >
        <header>
          <div>
            <h2>{messages.chooseProjectWorkspace}</h2>
            <p>{messages.chooseProjectWorkspaceHint}</p>
          </div>
          <button type="button" onClick={onClose} aria-label={messages.cancel}>
            <X aria-hidden="true" />
          </button>
        </header>
        <div>
          {workspaces.map((workspace) => (
            <button
              type="button"
              data-testid={`collaboration-project-workspace-${workspace.id}`}
              key={workspace.id}
              onClick={() => onSelect(workspace.id)}
            >
              <span className="collaboration-project-card-mark">
                {workspace.name.slice(0, 2)}
              </span>
              <span>
                <strong>{workspace.name}</strong>
                <small>
                  {workspace.project_count} {messages.projectCount}
                </small>
              </span>
              <ChevronRight aria-hidden="true" />
            </button>
          ))}
        </div>
      </section>
    </div>
  );
}

function WorkspaceCreateDialog({
  messages,
  ownerOptions,
  onClose,
  onCreate,
}: {
  messages: PlatformMessages;
  ownerOptions?: Array<{ label: string; namespace: string }>;
  onClose(): void;
  onCreate(input: {
    name: string;
    description?: string;
    namespace?: string;
  }): Promise<void>;
}) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [namespace, setNamespace] = useState("default");
  const [saving, setSaving] = useState(false);
  const effectiveOwnerOptions = ownerOptions ?? [
    { label: messages.personalOwner, namespace: "default" },
  ];
  return (
    <div className="collaboration-dialog-backdrop">
      <section
        className="collaboration-dialog collaboration-workspace-create-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={messages.createWorkspace}
      >
        <h2>{messages.createWorkspace}</h2>
        <p className="collaboration-workspace-storage-notice">
          {messages.cloudStorageNotice}
        </p>
        <label>
          {messages.name}
          <input
            autoFocus
            data-testid="collaboration-workspace-name-input"
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
        </label>
        <label>
          {messages.description}
          <textarea
            data-testid="collaboration-workspace-description-input"
            value={description}
            onChange={(event) => setDescription(event.target.value)}
          />
        </label>
        <label>
          {messages.owner}
          <select
            data-testid="collaboration-workspace-owner-select"
            onChange={(event) => setNamespace(event.target.value)}
            value={namespace}
          >
            {effectiveOwnerOptions.map((option) => (
              <option key={option.namespace} value={option.namespace}>
                {option.label}
              </option>
            ))}
          </select>
          <small>{messages.ownerHint}</small>
        </label>
        <footer>
          <button type="button" onClick={onClose}>
            {messages.cancel}
          </button>
          <button
            type="button"
            className="collaboration-primary-button"
            data-testid="collaboration-workspace-create-confirm"
            disabled={saving || !name.trim()}
            onClick={() => {
              setSaving(true);
              void onCreate({
                name: name.trim(),
                description: description.trim() || undefined,
                namespace,
              }).finally(() => setSaving(false));
            }}
          >
            {messages.createWorkspace}
          </button>
        </footer>
      </section>
    </div>
  );
}
