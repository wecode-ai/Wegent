// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import {
  Children,
  type ComponentProps,
  type ReactElement,
  type ReactNode,
} from "react";
import { beforeEach, describe, expect, expectTypeOf, it, vi } from "vitest";

const collaborationAppMocks = vi.hoisted(() => ({
  useController: vi.fn(),
}));

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return {
    ...actual,
    useCallback: <T extends (...args: never[]) => unknown>(callback: T) =>
      callback,
    useEffect: vi.fn(),
    useMemo: <T,>(factory: () => T) => factory(),
    useRef: <T,>(initialValue: T) => ({ current: initialValue }),
    useState: <T,>(initialValue: T | (() => T)) => [
      typeof initialValue === "function"
        ? (initialValue as () => T)()
        : initialValue,
      vi.fn(),
    ],
  };
});

vi.mock("./workspace-controller", () => ({
  useCollaborationWorkspaceController: collaborationAppMocks.useController,
}));

vi.mock("./project-board/projectBoardDnd", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./project-board/projectBoardDnd")>()),
  useProjectBoardSensors: () => [],
}));

import { CollaborationApp } from "./CollaborationApp";
import { CollaborationSettings } from "./CollaborationSettings";
import {
  CollaborationParticipantsTabs,
  ProjectCollaborationGroups,
  ProjectCollaborationParticipants,
  ProjectAutomaticProcessing,
  ProjectSettingsShell,
} from "./project-manage";
import { CollaborationFilesAdapter } from "./web-adapter/CollaborationFilesAdapter";
import { MyWorkAdapter } from "./web-adapter/MyWorkAdapter";
import { ProjectBoardAdapter } from "./web-adapter/ProjectBoardAdapter";
import { ProjectIssueTable } from "./platform";
import { ProjectBoardBody } from "./project-board";
import { WorkspaceProjectsHomeAdapter } from "./web-adapter/WorkspaceProjectsHomeAdapter";
import {
  CollaborationProjectViewShell,
  buildCollaborationProjectViewOptions,
  collaborationProjectViewIds,
} from "./project-shell";
import type { SharedWorkspaceApi } from "./ports/SharedWorkspaceApi";
import type {
  CollaborationCapabilities,
  CollaborationHostAdapter,
  CollaborationIssue,
  CollaborationLocation,
  CollaborationProject,
} from "./types";
import {
  WorkspaceProjectsHome,
  type WorkspaceProjectsHomeHost,
} from "./workspace/WorkspaceProjectsHome";

function descendants(node: ReactNode): ReactElement[] {
  if (!node || typeof node !== "object" || !("props" in node)) return [];
  const element = node as ReactElement;
  return [
    element,
    ...Children.toArray(element.props.children).flatMap((child) =>
      descendants(child),
    ),
  ];
}

function findByType(node: ReactNode, type: ReactElement["type"]) {
  return descendants(node).find((element) => element.type === type);
}

function findByTestId(node: ReactNode, testId: string) {
  return descendants(node).find(
    (element) => element.props["data-testid"] === testId,
  );
}

function createHost(
  myWork: boolean | undefined,
  rootView: CollaborationLocation["rootView"],
): CollaborationHostAdapter {
  return {
    capabilities: {
      myWork,
      automation: true,
      dingtalkAitable: false,
    },
    location: {
      projectId: null,
      issueId: null,
      view: "board",
      rootView,
    },
    navigate: vi.fn(),
  };
}

function createApi(): SharedWorkspaceApi {
  return {
    workspaces: {
      listCollaborationGroups: vi.fn(async () => []),
    },
    projects: {
      listCollaborationGroups: vi.fn(async () => []),
    },
    automations: {},
  } as unknown as SharedWorkspaceApi;
}

function renderApp(host: CollaborationHostAdapter) {
  return CollaborationApp({
    api: createApi(),
    host,
  });
}

function createProject(version: number): CollaborationProject {
  return {
    id: "project-1",
    workspace_id: "workspace-1",
    project_key: "PRJ",
    name: "Project",
    description: "",
    project_store: "backend",
    task_provider: "local",
    provider_config: {},
    created_by_user_id: 1,
    status: "active",
    tags: [],
    version,
    created_at: "2026-09-11T00:00:00Z",
    updated_at: `2026-09-11T00:00:0${version}Z`,
  };
}

function controllerWithProject(project: CollaborationProject) {
  return {
    state: {
      projects: [project],
      myWork: [],
      projectItems: { [project.id]: [] },
      projectMembers: { [project.id]: [] },
      project,
      issues: [],
      members: [],
      agents: [],
      selectedIssue: null,
      comments: [],
      assignments: [],
      executions: [],
      taskBindings: [],
      loading: false,
      error: null,
    },
    commands: {
      reportError: vi.fn(),
      replaceProject: vi.fn(),
      markIssueRead: vi.fn().mockResolvedValue(null),
    },
  };
}

const Icon = () => null;

function createWorkspaceHomeHost(): WorkspaceProjectsHomeHost {
  return {
    icons: {
      Check: Icon,
      Cloud: Icon,
      Copy: Icon,
      HardDrive: Icon,
      Plus: Icon,
      Search: Icon,
      Settings: Icon,
    },
    translate: (_key, fallback) => fallback,
    copyText: async () => undefined,
    formatRelativeTime: (value) => value,
    renderTooltip: ({ children }) => children,
    renderModal: ({ children }) => children,
  };
}

describe("CollaborationApp API boundary", () => {
  beforeEach(() => {
    collaborationAppMocks.useController.mockReset();
    collaborationAppMocks.useController.mockReturnValue({
      state: {
        projects: [],
        myWork: [
          {
            id: "my-work-1",
            cloud_project_id: "project-1",
            project_key: "PRJ",
            title: "Hidden Web task",
          },
        ],
        projectItems: {},
        projectMembers: {},
        project: null,
        issues: [],
        members: [],
        agents: [],
        selectedIssue: null,
        comments: [],
        loading: false,
        error: null,
      },
      commands: {
        reportError: vi.fn(),
      },
    });
  });

  it("accepts the grouped SharedWorkspaceApi as its only cloud API", () => {
    expectTypeOf<
      ComponentProps<typeof CollaborationApp>["api"]
    >().toEqualTypeOf<SharedWorkspaceApi>();
    expect(true).toBe(true);
  });

  it("exposes only capabilities that change shared app behavior", () => {
    expectTypeOf<keyof CollaborationCapabilities>().toEqualTypeOf<
      "myWork" | "automation" | "dingtalkAitable"
    >();
  });

  it("models My Work as a root location rather than a project view", () => {
    const location: CollaborationLocation = {
      projectId: null,
      issueId: null,
      view: "board",
      rootView: "my-work",
    };

    expect(location.rootView).toBe("my-work");
  });

  it("keeps the shared project view set free of host-only pages", () => {
    expect(collaborationProjectViewIds).toEqual([
      "board",
      "table",
      "files",
      "manage",
    ]);
    expect(collaborationProjectViewIds).not.toContain("members");
    expect(collaborationProjectViewIds).not.toContain("runs");
    expect(collaborationProjectViewIds).not.toContain("automation");
  });

  it("keeps project settings mounted across polling refreshes", () => {
    const host = createHost(false, "home");
    host.location = {
      projectId: "project-1",
      issueId: null,
      view: "manage",
    };
    collaborationAppMocks.useController.mockReturnValue(
      controllerWithProject(createProject(1)),
    );
    const firstShell = findByType(
      renderApp(host),
      CollaborationProjectViewShell,
    );
    const firstSettingsShell = findByType(
      firstShell?.props.slots.manage,
      ProjectSettingsShell,
    );
    const firstSettings = firstSettingsShell?.props.sections.find(
      (section: { id: string }) => section.id === "project",
    )?.content;

    collaborationAppMocks.useController.mockReturnValue(
      controllerWithProject(createProject(2)),
    );
    const refreshedShell = findByType(
      renderApp(host),
      CollaborationProjectViewShell,
    );
    const refreshedSettingsShell = findByType(
      refreshedShell?.props.slots.manage,
      ProjectSettingsShell,
    );
    const refreshedSettings = refreshedSettingsShell?.props.sections.find(
      (section: { id: string }) => section.id === "project",
    )?.content;

    expect(firstSettings?.type).toBe(CollaborationSettings);
    expect(firstSettings?.key).toContain("project-1");
    expect(refreshedSettings?.key).toBe(firstSettings?.key);
    expect(refreshedSettings?.props.project.version).toBe(2);
  });

  it("uses the shared project settings content as the vertical scroller", () => {
    const shell = ProjectSettingsShell({
      ariaLabel: "项目设置",
      sections: [
        {
          id: "dispatch",
          label: "自动处理",
          testId: "project-settings-dispatch",
          content: <div>dispatch</div>,
        },
      ],
    });
    const content = findByTestId(shell, "project-settings-shell-content");

    expect(shell.props.className).toContain("overflow-hidden");
    expect(content?.type).toBe("main");
    expect(content?.props.className).toContain("h-full");
    expect(content?.props.className.split(" ")).not.toContain("h-0");
    expect(content?.props.className).toContain("min-h-0");
    expect(content?.props.className).toContain("overflow-y-auto");
    expect(content?.props.className).toContain("overscroll-y-contain");
    expect(content?.props.className).toContain("[scrollbar-gutter:stable]");
    expect(content?.props.className).not.toContain("overflow-hidden");
  });

  it("keeps project settings limited to the four project-level concerns", () => {
    const host = createHost(false, "home");
    host.location = {
      projectId: "project-1",
      issueId: null,
      view: "manage",
    };
    collaborationAppMocks.useController.mockReturnValue(
      controllerWithProject({
        ...createProject(1),
        access_role: "Owner",
        current_user_id: 1,
        current_user_name: "Project owner",
      }),
    );

    const shell = findByType(renderApp(host), CollaborationProjectViewShell);
    const settingsShell = findByType(
      shell?.props.slots.manage,
      ProjectSettingsShell,
    );
    const sectionIds = settingsShell?.props.sections.map(
      (section: { id: string }) => section.id,
    );
    const participantsSection = settingsShell?.props.sections.find(
      (section: { id: string }) => section.id === "collaboration-participants",
    );
    const automaticProcessingSection = settingsShell?.props.sections.find(
      (section: { id: string }) => section.id === "automatic-processing",
    );

    expect(sectionIds).toEqual([
      "project",
      "collaboration-participants",
      "environments",
      "automatic-processing",
    ]);
    expect(participantsSection?.content.type).toBe(
      ProjectCollaborationParticipants,
    );
    expect(
      findByType(
        participantsSection?.content.props.groupsContent,
        ProjectCollaborationGroups,
      ),
    ).toBeDefined();
    expect(automaticProcessingSection).toBeDefined();
    expect(automaticProcessingSection?.content.type).toBe(
      ProjectAutomaticProcessing,
    );
    expect(participantsSection?.content).not.toBe(
      automaticProcessingSection?.content,
    );
  });

  it("orders collaboration participants as agents, project members and groups", () => {
    const participants = CollaborationParticipantsTabs({
      agentsContent: <div data-testid="agents-content" />,
      agentsLabel: "智能体",
      ariaLabel: "协作成员",
      membersContent: <div data-testid="members-content" />,
      membersLabel: "项目成员",
      groupsContent: <div data-testid="groups-content" />,
      groupsLabel: "协作小组",
    });
    const tabs = descendants(participants).filter(
      (element) => element.props.role === "tab",
    );

    expect(tabs.map((tab) => tab.props["data-testid"])).toEqual([
      "collaboration-participants-tab-agents",
      "collaboration-participants-tab-members",
      "collaboration-participants-tab-groups",
    ]);
    expect(tabs.map((tab) => tab.props.children)).toEqual([
      "智能体",
      "项目成员",
      "协作小组",
    ]);
    expect(tabs.map((tab) => tab.props["aria-selected"])).toEqual([
      true,
      false,
      false,
    ]);
    expect(
      findByTestId(participants, "collaboration-participants-panel-agents"),
    ).toBeDefined();
    expect(findByTestId(participants, "agents-content")).toBeDefined();
    expect(findByTestId(participants, "members-content")).toBeUndefined();
    expect(findByTestId(participants, "groups-content")).toBeUndefined();
  });

  it("mounts files as a top-level project view instead of a settings section", () => {
    const host = createHost(false, "home");
    host.location = {
      projectId: "project-1",
      issueId: null,
      view: "manage",
    };
    collaborationAppMocks.useController.mockReturnValue(
      controllerWithProject(createProject(1)),
    );

    const shell = findByType(renderApp(host), CollaborationProjectViewShell);
    const settingsShell = findByType(
      shell?.props.slots.manage,
      ProjectSettingsShell,
    );
    const filesSection = settingsShell?.props.sections.find(
      (section: { id: string }) => section.id === "files",
    );
    const filesView = findByType(
      shell?.props.slots.files,
      CollaborationFilesAdapter,
    );

    expect(filesSection).toBeUndefined();
    expect(filesView).toBeDefined();
  });

  it("passes runtime bindings and the host card renderer through the shared board", () => {
    const host = createHost(false, "home");
    host.location = {
      projectId: "project-1",
      issueId: null,
      view: "board",
    };
    const project = createProject(1);
    const binding = {
      id: "binding-1",
      projectId: project.id,
      issueId: "issue-1",
      taskUserId: 1,
      deviceId: "device-1",
      taskId: "task-1",
      taskTitle: "Runtime task",
      backendTaskId: null,
      linkedAt: "2026-09-13T00:00:00Z",
    };
    const renderBoardIssueCard = vi.fn();
    const controller = controllerWithProject(project);
    const issue: CollaborationIssue = {
      id: "issue-1",
      cloud_project_id: project.id,
      sequence_number: 1,
      parent_id: null,
      created_by_user_id: 1,
      assignee_user_id: null,
      title: "Issue",
      description: "",
      status: "inbox",
      priority: "none",
      due_at: null,
      tags: [],
      sort_order: 0,
      version: 1,
      created_at: "2026-09-13T00:00:00Z",
      updated_at: "2026-09-13T00:00:00Z",
      completed_at: null,
    };
    collaborationAppMocks.useController.mockReturnValue({
      ...controller,
      state: {
        ...controller.state,
        issues: [issue],
        taskBindings: [binding],
      },
    });

    const app = CollaborationApp({
      api: createApi(),
      host,
      renderBoardIssueCard,
    });
    const shell = findByType(app, CollaborationProjectViewShell);
    const board = findByType(shell?.props.slots.board, ProjectBoardAdapter);
    const renderedBoard = ProjectBoardAdapter(board?.props);
    const boardBody = findByType(renderedBoard, ProjectBoardBody);

    expect(board?.props.taskBindings).toEqual([binding]);
    expect(
      boardBody?.props.getColumnEmptyState({
        key: "inbox",
        label: "收集箱",
        status: "inbox",
      }).action,
    ).toBeDefined();
    expect(
      boardBody?.props.getColumnEmptyState({
        key: "pending",
        label: "待开始",
        status: "pending",
      }).action,
    ).toBeUndefined();
    board?.props.renderIssueCard({ issue, taskBindings: [binding] });
    expect(renderBoardIssueCard).toHaveBeenCalledWith({
      issue,
      taskBindings: [binding],
      onMarkRead: expect.any(Function),
    });
    renderBoardIssueCard.mock.calls[0][0].onMarkRead();
    expect(controller.commands.markIssueRead).toHaveBeenCalledWith(issue);
    expect(board?.props.onOpenBoardSettings).toEqual(expect.any(Function));
  });

  it("passes the selected Issue task bindings to a custom detail renderer", () => {
    const host = createHost(false, "home");
    host.location = {
      projectId: "project-1",
      issueId: "issue-1",
      view: "board",
    };
    const project = createProject(1);
    const issue = {
      id: "issue-1",
      cloud_project_id: project.id,
      sequence_number: 1,
      parent_id: null,
      created_by_user_id: 1,
      assignee_user_id: null,
      title: "Issue",
      description: "",
      status: "inbox",
      priority: "none",
      due_at: null,
      tags: [],
      sort_order: 0,
      version: 1,
      created_at: "2026-09-14T00:00:00Z",
      updated_at: "2026-09-14T00:00:00Z",
      completed_at: null,
    } satisfies CollaborationIssue;
    const selectedBinding = {
      id: "binding-1",
      projectId: project.id,
      issueId: issue.id,
      taskUserId: 1,
      deviceId: "device-1",
      taskId: "task-1",
      taskTitle: "Runtime task",
      backendTaskId: null,
      linkedAt: "2026-09-14T00:00:00Z",
    };
    const otherBinding = {
      ...selectedBinding,
      id: "binding-2",
      issueId: "issue-2",
      taskId: "task-2",
    };
    const controller = controllerWithProject(project);
    collaborationAppMocks.useController.mockReturnValue({
      ...controller,
      state: {
        ...controller.state,
        issues: [issue],
        selectedIssue: issue,
        taskBindings: [selectedBinding, otherBinding],
      },
    });
    const renderIssueDetail = vi.fn(() => null);

    CollaborationApp({
      api: createApi(),
      host,
      renderIssueDetail,
    });

    expect(renderIssueDetail).toHaveBeenCalledWith(
      expect.objectContaining({
        issue,
        taskBindings: [selectedBinding],
      }),
    );
  });

  it("keeps Issue deletion hidden until the host enables it", () => {
    const host = createHost(false, "home");
    host.location = {
      projectId: "project-1",
      issueId: null,
      view: "board",
    };
    collaborationAppMocks.useController.mockReturnValue(
      controllerWithProject(createProject(1)),
    );

    const app = CollaborationApp({
      api: createApi(),
      host,
    });
    const shell = findByType(app, CollaborationProjectViewShell);
    const board = findByType(shell?.props.slots.board, ProjectBoardAdapter);
    const table = findByType(shell?.props.slots.table, ProjectIssueTable);

    expect(board?.props.onDeleteIssue).toBeUndefined();
    expect(table?.props.onDelete).toBeUndefined();
  });

  it("wires Issue deletion into board, table, and detail when enabled", () => {
    const host = createHost(false, "home");
    host.location = {
      projectId: "project-1",
      issueId: "issue-1",
      view: "board",
    };
    const project = createProject(1);
    const issue = {
      id: "issue-1",
      cloud_project_id: project.id,
      sequence_number: 1,
      parent_id: null,
      created_by_user_id: 1,
      assignee_user_id: null,
      title: "Issue",
      description: "",
      status: "inbox",
      priority: "none",
      due_at: null,
      tags: [],
      sort_order: 0,
      can_edit: true,
      version: 1,
      created_at: "2026-09-14T00:00:00Z",
      updated_at: "2026-09-14T00:00:00Z",
      completed_at: null,
    } satisfies CollaborationIssue;
    const controller = controllerWithProject(project);
    collaborationAppMocks.useController.mockReturnValue({
      ...controller,
      state: {
        ...controller.state,
        issues: [issue],
        selectedIssue: issue,
      },
    });
    const renderIssueDetail = vi.fn(() => null);

    const app = CollaborationApp({
      api: createApi(),
      host,
      issueDeleteEnabled: true,
      renderIssueDetail,
    });
    const shell = findByType(app, CollaborationProjectViewShell);
    const board = findByType(shell?.props.slots.board, ProjectBoardAdapter);
    const table = findByType(shell?.props.slots.table, ProjectIssueTable);

    expect(board?.props.onDeleteIssue).toEqual(expect.any(Function));
    expect(table?.props.onDelete).toEqual(expect.any(Function));
    expect(renderIssueDetail).toHaveBeenCalledWith(
      expect.objectContaining({ onDelete: expect.any(Function) }),
    );
  });

  it("keeps detail deletion unavailable for a read-only Issue", () => {
    const host = createHost(false, "home");
    host.location = {
      projectId: "project-1",
      issueId: "issue-1",
      view: "board",
    };
    const project = createProject(1);
    const issue = {
      id: "issue-1",
      cloud_project_id: project.id,
      sequence_number: 1,
      parent_id: null,
      created_by_user_id: 1,
      assignee_user_id: null,
      title: "Issue",
      description: "",
      status: "inbox",
      priority: "none",
      due_at: null,
      tags: [],
      sort_order: 0,
      can_edit: false,
      version: 1,
      created_at: "2026-09-14T00:00:00Z",
      updated_at: "2026-09-14T00:00:00Z",
      completed_at: null,
    } satisfies CollaborationIssue;
    const controller = controllerWithProject(project);
    collaborationAppMocks.useController.mockReturnValue({
      ...controller,
      state: {
        ...controller.state,
        issues: [issue],
        selectedIssue: issue,
      },
    });
    const renderIssueDetail = vi.fn(() => null);

    CollaborationApp({
      api: createApi(),
      host,
      issueDeleteEnabled: true,
      renderIssueDetail,
    });

    expect(renderIssueDetail).toHaveBeenCalledWith(
      expect.objectContaining({ onDelete: undefined }),
    );
  });

  it("centralizes permission filtering and host extension placement", () => {
    const options = buildCollaborationProjectViewOptions({
      project: { access_role: "RestrictedAnalyst" },
      labels: {
        board: "Board",
        table: "Table",
        files: "Files",
        manage: "Manage",
      },
      testIds: {
        board: "board",
        table: "table",
        files: "files",
        manage: "manage",
      },
      extensions: [
        {
          id: "table",
          label: "Table",
          testId: "table",
          content: null,
        },
      ],
    });

    expect(options.map((option) => option.id)).toEqual(["board", "table"]);
  });

  it.each([undefined, false])(
    "keeps My Work unavailable when the host capability is %s",
    (myWork) => {
      const host = createHost(myWork, "my-work");
      const tree = renderApp(host);
      const home = findByType(tree, WorkspaceProjectsHomeAdapter);

      expect(findByType(tree, MyWorkAdapter)).toBeUndefined();
      expect(home).toBeDefined();
      expect(home?.props.myWork).toEqual([]);
      expect(home?.props.onOpenMyWork).toBeUndefined();
      expect(host.navigate).not.toHaveBeenCalled();
      expect(collaborationAppMocks.useController).toHaveBeenCalledWith(
        expect.objectContaining({ myWorkEnabled: false }),
      );
    },
  );

  it("keeps My Work available only when the host explicitly enables it", () => {
    const homeHost = createHost(true, "home");
    const home = findByType(renderApp(homeHost), WorkspaceProjectsHomeAdapter);

    expect(home?.props.myWork).toHaveLength(1);
    expect(home?.props.onOpenMyWork).toEqual(expect.any(Function));
    expect(collaborationAppMocks.useController).toHaveBeenCalledWith(
      expect.objectContaining({ myWorkEnabled: true }),
    );
    home?.props.onOpenMyWork();
    expect(homeHost.navigate).toHaveBeenCalledWith({
      projectId: null,
      issueId: null,
      view: "board",
      rootView: "my-work",
    });

    const myWorkHost = createHost(true, "my-work");
    expect(findByType(renderApp(myWorkHost), MyWorkAdapter)).toBeDefined();
  });

  it("keeps the Wework direct onOpenMyWork integration available", () => {
    const onOpenMyWork = vi.fn();
    const tree = WorkspaceProjectsHome({
      projects: [],
      projectCounts: {},
      projectMembers: {},
      projectItems: {},
      myWork: [],
      searchQuery: "",
      host: createWorkspaceHomeHost(),
      onCreateProject: vi.fn(),
      onSelectProject: vi.fn(),
      onManageProject: vi.fn(),
      onSelectItem: vi.fn(),
      onOpenMyWork,
    });
    const entry = findByTestId(tree, "cloud-projects-home-my-work");

    expect(entry).toBeDefined();
    entry?.props.onClick();
    expect(onOpenMyWork).toHaveBeenCalledOnce();
  });

  it("hides the whole My Work section when no host callback is provided", () => {
    const tree = WorkspaceProjectsHome({
      projects: [],
      projectCounts: {},
      projectMembers: {},
      projectItems: {},
      myWork: [
        {
          id: "my-work-1",
          cloud_project_id: "project-1",
          project_key: "PRJ",
          title: "Hidden Web task",
          status: "pending",
          updated_at: "2026-09-11T00:00:00Z",
        },
      ],
      searchQuery: "",
      host: createWorkspaceHomeHost(),
      onCreateProject: vi.fn(),
      onSelectProject: vi.fn(),
      onManageProject: vi.fn(),
      onSelectItem: vi.fn(),
    });

    expect(findByTestId(tree, "cloud-projects-home-my-work")).toBeUndefined();
    expect(
      findByTestId(tree, "cloud-projects-home-todo-my-work-1"),
    ).toBeUndefined();
  });
});
