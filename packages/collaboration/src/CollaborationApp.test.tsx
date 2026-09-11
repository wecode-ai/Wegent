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
    useEffect: vi.fn(),
    useMemo: <T,>(factory: () => T) => factory(),
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

import { CollaborationApp } from "./CollaborationApp";
import { CollaborationSettings } from "./CollaborationSettings";
import { MyWorkAdapter } from "./web-adapter/MyWorkAdapter";
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

function renderApp(host: CollaborationHostAdapter) {
  return CollaborationApp({
    api: {} as SharedWorkspaceApi,
    host,
  });
}

function createProject(version: number): CollaborationProject {
  return {
    id: "project-1",
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
      loading: false,
      error: null,
    },
    commands: {
      reportError: vi.fn(),
      replaceProject: vi.fn(),
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
      "automation",
      "manage",
    ]);
    expect(collaborationProjectViewIds).not.toContain("members");
    expect(collaborationProjectViewIds).not.toContain("runs");
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
    const firstSettings = findByType(
      firstShell?.props.slots.manage,
      CollaborationSettings,
    );

    collaborationAppMocks.useController.mockReturnValue(
      controllerWithProject(createProject(2)),
    );
    const refreshedShell = findByType(
      renderApp(host),
      CollaborationProjectViewShell,
    );
    const refreshedSettings = findByType(
      refreshedShell?.props.slots.manage,
      CollaborationSettings,
    );

    expect(firstSettings?.key).toContain("project-1");
    expect(refreshedSettings?.key).toBe(firstSettings?.key);
    expect(refreshedSettings?.props.project.version).toBe(2);
  });

  it("centralizes permission filtering and host extension placement", () => {
    const options = buildCollaborationProjectViewOptions({
      project: { access_role: "RestrictedAnalyst" },
      labels: {
        board: "Board",
        files: "Files",
        automation: "Automation",
        manage: "Manage",
      },
      testIds: {
        board: "board",
        files: "files",
        automation: "automation",
        manage: "manage",
      },
      automationSupported: true,
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
