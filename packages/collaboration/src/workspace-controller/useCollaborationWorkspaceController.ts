// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { useEffect, useMemo, useReducer, useRef } from "react";

import type {
  SharedWorkspaceApi,
  WorkspaceBoardSnapshot,
  WorkspaceIssueAssignmentInput,
  WorkspaceIssueCreateInput,
  WorkspaceIssueUpdateInput,
  WorkspaceMyWorkItem,
  WorkspaceProjectCreateInput,
  WorkspaceProjectUpdateInput,
} from "../ports/SharedWorkspaceApi";
import type {
  CollaborationAssignment,
  CollaborationAttachment,
  CollaborationAgent,
  CollaborationComment,
  CollaborationExecution,
  CollaborationIssue,
  CollaborationLocation,
  CollaborationMember,
  CollaborationProject,
  CollaborationStatus,
} from "../types";

export interface CollaborationWorkspaceControllerState {
  projects: CollaborationProject[];
  myWork: WorkspaceMyWorkItem[];
  projectItems: Record<string, CollaborationIssue[]>;
  projectMembers: Record<string, CollaborationMember[]>;
  projectAgents: Record<string, CollaborationAgent[]>;
  projectTaskBindings: Record<string, WorkspaceBoardSnapshot["taskBindings"]>;
  project: CollaborationProject | null;
  issues: CollaborationIssue[];
  members: CollaborationMember[];
  agents: CollaborationAgent[];
  taskBindings: WorkspaceBoardSnapshot["taskBindings"];
  externalBoardParentId: string | null;
  externalPageCursors: Record<string, string | null>;
  externalPageLoading: Record<string, boolean>;
  boardLoadRevision: number;
  selectedIssue: CollaborationIssue | null;
  attachments: CollaborationAttachment[];
  comments: CollaborationComment[];
  assignments: CollaborationAssignment[];
  executions: CollaborationExecution[];
  loading: boolean;
  error: string | null;
  errorSource: "load" | "save" | "conflict" | null;
}

export interface CollaborationWorkspaceControllerMessages {
  loadFailed: string;
  saveFailed: string;
  conflict: string;
}

export interface CollaborationWorkspaceControllerOptions {
  api: SharedWorkspaceApi | null | undefined;
  location: CollaborationLocation;
  messages: CollaborationWorkspaceControllerMessages;
  myWorkEnabled?: boolean;
  pollIntervalMs?: number;
  loadProjectOnLocation?: boolean;
  preloadHomeSnapshots?: boolean;
  externalBoard?: {
    parentId: string | null;
    pageSize: number;
    eager: boolean;
  };
  notify?(message: string, kind: "success" | "error"): void;
}

export interface CollaborationWorkspaceControllerCommands {
  loadProjects(): Promise<void>;
  loadProjectCatalog(options?: { isCurrent?(): boolean }): Promise<void>;
  loadMyWork(): Promise<void>;
  loadProject(projectId: string, showLoading?: boolean): Promise<void>;
  loadProjectSnapshot(
    projectId: string,
  ): Promise<WorkspaceBoardSnapshot | null>;
  loadMoreExternalColumn(status: string): Promise<void>;
  getIssue(issueId: string): Promise<CollaborationIssue | null>;
  loadSelectedIssue(issueId: string): Promise<CollaborationIssue | null>;
  clearProject(): void;
  clearSelectedIssue(): void;
  createProject(
    input: WorkspaceProjectCreateInput,
  ): Promise<CollaborationProject | null>;
  updateProject(
    projectId: string,
    input: WorkspaceProjectUpdateInput,
  ): Promise<CollaborationProject | null>;
  archiveProject(projectId: string, version: number): Promise<boolean>;
  createIssue(
    projectId: string,
    input: WorkspaceIssueCreateInput,
    options?: { throwOnError?: boolean },
  ): Promise<CollaborationIssue | null>;
  updateIssue(
    issueId: string,
    input: WorkspaceIssueUpdateInput,
    options?: { throwOnError?: boolean },
  ): Promise<CollaborationIssue | null>;
  assignIssue(
    projectId: string,
    issueId: string,
    input: WorkspaceIssueAssignmentInput,
  ): Promise<CollaborationIssue | null>;
  archiveIssue(issueId: string): Promise<boolean>;
  reorderIssue(input: {
    issue: CollaborationIssue;
    status: string;
    laneIds: string[];
    optimisticItems: CollaborationIssue[];
  }): Promise<void>;
  changeProjectGroup(input: {
    project: CollaborationProject;
    groupBy: "status" | "priority" | "assignee" | "tag";
    defaultStatuses: CollaborationStatus[];
  }): Promise<void>;
  refreshSelectedIssue(): Promise<void>;
  replaceProject(project: CollaborationProject): void;
  appendIssue(issue: CollaborationIssue): void;
  replaceIssue(issue: CollaborationIssue): void;
  replaceAttachments(attachments: CollaborationAttachment[]): void;
  replaceComments(comments: CollaborationComment[]): void;
  replaceAssignments(assignments: CollaborationAssignment[]): void;
  reportError(message: string): void;
}

export interface CollaborationWorkspaceController {
  state: CollaborationWorkspaceControllerState;
  commands: CollaborationWorkspaceControllerCommands;
}

const unavailableCollaborationWorkspaceControllerCommands: CollaborationWorkspaceControllerCommands =
  {
    loadProjects: async () => undefined,
    loadProjectCatalog: async () => undefined,
    loadMyWork: async () => undefined,
    loadProject: async () => undefined,
    loadProjectSnapshot: async () => null,
    loadMoreExternalColumn: async () => undefined,
    getIssue: async () => null,
    loadSelectedIssue: async () => null,
    clearProject: () => undefined,
    clearSelectedIssue: () => undefined,
    createProject: async () => null,
    updateProject: async () => null,
    archiveProject: async () => false,
    createIssue: async () => null,
    updateIssue: async () => null,
    assignIssue: async () => null,
    archiveIssue: async () => false,
    reorderIssue: async () => undefined,
    changeProjectGroup: async () => undefined,
    refreshSelectedIssue: async () => undefined,
    replaceProject: () => undefined,
    appendIssue: () => undefined,
    replaceIssue: () => undefined,
    replaceAttachments: () => undefined,
    replaceComments: () => undefined,
    replaceAssignments: () => undefined,
    reportError: () => undefined,
  };

export type CollaborationWorkspaceControllerAction =
  | { type: "loading"; value: boolean }
  | {
      type: "error";
      value: string | null;
      source?: CollaborationWorkspaceControllerState["errorSource"];
    }
  | {
      type: "home-loaded";
      projects: CollaborationProject[];
      projectItems: Record<string, CollaborationIssue[]>;
      projectMembers: Record<string, CollaborationMember[]>;
      projectAgents: Record<string, CollaborationAgent[]>;
      projectTaskBindings: Record<
        string,
        WorkspaceBoardSnapshot["taskBindings"]
      >;
      myWork: WorkspaceMyWorkItem[];
    }
  | { type: "project-catalog-loaded"; projects: CollaborationProject[] }
  | {
      type: "project-snapshot-loaded";
      projectId: string;
      snapshot: WorkspaceBoardSnapshot;
    }
  | { type: "my-work-loaded"; items: WorkspaceMyWorkItem[] }
  | {
      type: "project-loaded";
      project: CollaborationProject;
      snapshot: WorkspaceBoardSnapshot;
      externalBoard?: {
        parentId: string | null;
        pageCursors: Record<string, string | null>;
      };
    }
  | {
      type: "external-column-loading";
      status: string;
      value: boolean;
    }
  | {
      type: "external-column-appended";
      projectId: string;
      status: string;
      items: CollaborationIssue[];
      taskBindings: WorkspaceBoardSnapshot["taskBindings"];
      nextCursor: string | null;
    }
  | {
      type: "issue-loaded";
      issue: CollaborationIssue;
      attachments: CollaborationAttachment[];
      comments: CollaborationComment[];
      assignments: CollaborationAssignment[];
      executions: CollaborationExecution[];
    }
  | { type: "clear-project" }
  | { type: "clear-selected-issue" }
  | { type: "replace-project"; project: CollaborationProject }
  | { type: "remove-project"; projectId: string }
  | { type: "replace-issues"; issues: CollaborationIssue[] }
  | { type: "append-issue"; issue: CollaborationIssue }
  | { type: "replace-issue"; issue: CollaborationIssue }
  | { type: "remove-issue"; issueId: string }
  | { type: "replace-attachments"; attachments: CollaborationAttachment[] }
  | { type: "replace-comments"; comments: CollaborationComment[] }
  | {
      type: "replace-assignments";
      assignments: CollaborationAssignment[];
    };

export const initialCollaborationWorkspaceControllerState: CollaborationWorkspaceControllerState =
  {
    projects: [],
    myWork: [],
    projectItems: {},
    projectMembers: {},
    projectAgents: {},
    projectTaskBindings: {},
    project: null,
    issues: [],
    members: [],
    agents: [],
    taskBindings: [],
    externalBoardParentId: null,
    externalPageCursors: {},
    externalPageLoading: {},
    boardLoadRevision: 0,
    selectedIssue: null,
    attachments: [],
    comments: [],
    assignments: [],
    executions: [],
    loading: true,
    error: null,
    errorSource: null,
  };

export function collaborationWorkspaceControllerReducer(
  state: CollaborationWorkspaceControllerState,
  action: CollaborationWorkspaceControllerAction,
): CollaborationWorkspaceControllerState {
  switch (action.type) {
    case "loading":
      return { ...state, loading: action.value };
    case "error":
      return {
        ...state,
        error: action.value,
        errorSource: action.value ? (action.source ?? null) : null,
      };
    case "home-loaded":
      return {
        ...state,
        projects: action.projects,
        projectItems: action.projectItems,
        projectMembers: action.projectMembers,
        projectAgents: action.projectAgents,
        projectTaskBindings: action.projectTaskBindings,
        myWork: action.myWork,
        error: null,
        errorSource: null,
      };
    case "project-catalog-loaded":
      return {
        ...state,
        projects: action.projects,
        error: null,
        errorSource: null,
      };
    case "project-snapshot-loaded":
      return {
        ...state,
        issues:
          state.project?.id === action.projectId
            ? action.snapshot.items
            : state.issues,
        members:
          state.project?.id === action.projectId
            ? action.snapshot.members
            : state.members,
        agents:
          state.project?.id === action.projectId
            ? action.snapshot.agents
            : state.agents,
        taskBindings:
          state.project?.id === action.projectId
            ? action.snapshot.taskBindings
            : state.taskBindings,
        projectItems: {
          ...state.projectItems,
          [action.projectId]: action.snapshot.items,
        },
        projectMembers: {
          ...state.projectMembers,
          [action.projectId]: action.snapshot.members,
        },
        projectAgents: {
          ...state.projectAgents,
          [action.projectId]: action.snapshot.agents,
        },
        projectTaskBindings: {
          ...state.projectTaskBindings,
          [action.projectId]: action.snapshot.taskBindings,
        },
        error: null,
        errorSource: null,
      };
    case "my-work-loaded":
      return {
        ...state,
        myWork: action.items,
        error: null,
        errorSource: null,
      };
    case "project-loaded":
      return {
        ...state,
        projects: state.projects.some((item) => item.id === action.project.id)
          ? state.projects.map((item) =>
              item.id === action.project.id ? action.project : item,
            )
          : [action.project, ...state.projects],
        projectItems: {
          ...state.projectItems,
          [action.project.id]: action.snapshot.items,
        },
        projectMembers: {
          ...state.projectMembers,
          [action.project.id]: action.snapshot.members,
        },
        projectAgents: {
          ...state.projectAgents,
          [action.project.id]: action.snapshot.agents,
        },
        projectTaskBindings: {
          ...state.projectTaskBindings,
          [action.project.id]: action.snapshot.taskBindings,
        },
        project: action.project,
        issues: action.snapshot.items,
        members: action.snapshot.members,
        agents: action.snapshot.agents,
        taskBindings: action.snapshot.taskBindings,
        externalBoardParentId: action.externalBoard?.parentId ?? null,
        externalPageCursors: action.externalBoard?.pageCursors ?? {},
        externalPageLoading: {},
        boardLoadRevision: state.boardLoadRevision + 1,
        error: null,
        errorSource: null,
      };
    case "external-column-loading":
      return {
        ...state,
        externalPageLoading: {
          ...state.externalPageLoading,
          [action.status]: action.value,
        },
      };
    case "external-column-appended": {
      if (state.project?.id !== action.projectId) return state;
      const issues = [
        ...new Map(
          [...state.issues, ...action.items].map((item) => [item.id, item]),
        ).values(),
      ];
      const taskBindings = [
        ...new Map(
          [...state.taskBindings, ...action.taskBindings].map((binding) => [
            binding.id,
            binding,
          ]),
        ).values(),
      ];
      return {
        ...state,
        issues,
        taskBindings,
        projectItems: {
          ...state.projectItems,
          [action.projectId]: issues,
        },
        projectTaskBindings: {
          ...state.projectTaskBindings,
          [action.projectId]: taskBindings,
        },
        externalPageCursors: {
          ...state.externalPageCursors,
          [action.status]: action.nextCursor,
        },
      };
    }
    case "issue-loaded":
      return {
        ...state,
        selectedIssue: action.issue,
        attachments: action.attachments,
        comments: action.comments,
        assignments: action.assignments,
        executions: action.executions,
      };
    case "clear-project":
      return {
        ...state,
        project: null,
        issues: [],
        members: [],
        agents: [],
        taskBindings: [],
        externalBoardParentId: null,
        externalPageCursors: {},
        externalPageLoading: {},
        selectedIssue: null,
        attachments: [],
        comments: [],
        assignments: [],
        executions: [],
      };
    case "clear-selected-issue":
      return {
        ...state,
        selectedIssue: null,
        attachments: [],
        comments: [],
        assignments: [],
        executions: [],
      };
    case "replace-project":
      return {
        ...state,
        project:
          state.project?.id === action.project.id
            ? action.project
            : state.project,
        projects: state.projects.some((item) => item.id === action.project.id)
          ? state.projects.map((item) =>
              item.id === action.project.id ? action.project : item,
            )
          : [action.project, ...state.projects],
      };
    case "remove-project": {
      const current = state.project?.id === action.projectId;
      return {
        ...state,
        projects: state.projects.filter((item) => item.id !== action.projectId),
        project: current ? null : state.project,
        issues: current ? [] : state.issues,
      };
    }
    case "replace-issues":
      return {
        ...state,
        issues: action.issues,
        projectItems: state.project
          ? { ...state.projectItems, [state.project.id]: action.issues }
          : state.projectItems,
      };
    case "append-issue":
      return {
        ...state,
        issues: [...state.issues, action.issue],
        projectItems: {
          ...state.projectItems,
          [action.issue.cloud_project_id]: [
            ...(state.projectItems[action.issue.cloud_project_id] ?? []),
            action.issue,
          ],
        },
      };
    case "replace-issue":
      return {
        ...state,
        selectedIssue:
          state.selectedIssue?.id === action.issue.id
            ? action.issue
            : state.selectedIssue,
        issues: state.issues.map((item) =>
          item.id === action.issue.id ? action.issue : item,
        ),
        projectItems: {
          ...state.projectItems,
          [action.issue.cloud_project_id]: (
            state.projectItems[action.issue.cloud_project_id] ?? []
          ).map((item) => (item.id === action.issue.id ? action.issue : item)),
        },
      };
    case "remove-issue":
      return {
        ...state,
        selectedIssue:
          state.selectedIssue?.id === action.issueId
            ? null
            : state.selectedIssue,
        issues: state.issues.filter((item) => item.id !== action.issueId),
        projectItems: Object.fromEntries(
          Object.entries(state.projectItems).map(([projectId, items]) => [
            projectId,
            items.filter((item) => item.id !== action.issueId),
          ]),
        ),
      };
    case "replace-attachments":
      return { ...state, attachments: action.attachments };
    case "replace-comments":
      return { ...state, comments: action.comments };
    case "replace-assignments":
      return { ...state, assignments: action.assignments };
  }
}

interface CommandEnvironment {
  api: SharedWorkspaceApi;
  messages: CollaborationWorkspaceControllerMessages;
  myWorkEnabled: boolean;
  preloadHomeSnapshots: boolean;
  dispatch(action: CollaborationWorkspaceControllerAction): void;
  getProjects(): CollaborationProject[];
  getProjectSnapshot(projectId: string): WorkspaceBoardSnapshot | null;
  getSelectedIssue(): CollaborationIssue | null;
  getExternalBoardState(): Pick<
    CollaborationWorkspaceControllerState,
    | "project"
    | "issues"
    | "taskBindings"
    | "externalBoardParentId"
    | "externalPageCursors"
    | "externalPageLoading"
  >;
  getExternalBoardOptions(): {
    parentId: string | null;
    pageSize: number;
    eager: boolean;
  };
  notify?(message: string, kind: "success" | "error"): void;
}

function errorStatus(error: unknown): number | null {
  if (!error || typeof error !== "object" || !("status" in error)) return null;
  return typeof error.status === "number" ? error.status : null;
}

const externalGitBoardStatuses = [
  "inbox",
  "pending",
  "in_progress",
  "in_review",
  "completed",
] as const;
const defaultExternalGitBoardPageSize = 100;

function isExternalGitProject(project: CollaborationProject): boolean {
  return (
    project.task_provider === "github" || project.task_provider === "gitlab"
  );
}

function canPreloadHomeSnapshot(project: CollaborationProject): boolean {
  return project.task_provider !== "dingtalk_aitable";
}

async function loadExternalGitStatusPages(
  api: SharedWorkspaceApi,
  projectId: string,
  status: string,
  options: {
    parentId: string | null;
    pageSize: number;
    eager: boolean;
  },
): Promise<{
  items: CollaborationIssue[];
  taskBindings: WorkspaceBoardSnapshot["taskBindings"];
  nextCursor: string | null;
}> {
  const items: CollaborationIssue[] = [];
  const taskBindings: WorkspaceBoardSnapshot["taskBindings"] = [];
  const seenCursors = new Set<string>();
  let cursor: string | null = null;

  do {
    const page = await api.issues.listPage(projectId, {
      status,
      parentId: options.parentId,
      cursor,
      limit: options.pageSize,
    });
    items.push(...page.items);
    taskBindings.push(...page.taskBindings);

    const nextCursor = page.nextCursor;
    if (!options.eager || !nextCursor || seenCursors.has(nextCursor)) {
      return { items, taskBindings, nextCursor };
    }
    seenCursors.add(nextCursor);
    cursor = nextCursor;
  } while (cursor);

  return { items, taskBindings, nextCursor: null };
}

async function loadExternalGitBoardSnapshot(
  api: SharedWorkspaceApi,
  projectId: string,
  options: {
    parentId: string | null;
    pageSize: number;
    eager: boolean;
  },
  previousSnapshot?: WorkspaceBoardSnapshot | null,
): Promise<{
  snapshot: WorkspaceBoardSnapshot;
  pageCursors: Record<string, string | null>;
}> {
  const [pages, members, agents] = await Promise.all([
    Promise.all(
      externalGitBoardStatuses.map((status) =>
        loadExternalGitStatusPages(api, projectId, status, options),
      ),
    ),
    api.members.list(projectId),
    api.agents.list(projectId),
  ]);

  const retainedItems = (previousSnapshot?.items ?? []).filter(
    (item) => item.parent_id !== options.parentId,
  );
  const retainedItemIds = new Set(retainedItems.map((item) => item.id));
  const retainedBindings = (previousSnapshot?.taskBindings ?? []).filter(
    (binding) => binding.issueId && retainedItemIds.has(binding.issueId),
  );
  return {
    snapshot: {
      items: [...retainedItems, ...pages.flatMap((page) => page.items)],
      members,
      agents,
      taskBindings: [
        ...retainedBindings,
        ...pages.flatMap((page) => page.taskBindings),
      ],
    },
    pageCursors: Object.fromEntries(
      pages.map((page, index) => [
        externalGitBoardStatuses[index],
        page.nextCursor,
      ]),
    ),
  };
}

export function createCollaborationWorkspaceControllerCommands({
  api,
  messages,
  myWorkEnabled,
  preloadHomeSnapshots = true,
  dispatch,
  getProjects,
  getProjectSnapshot,
  getSelectedIssue,
  getExternalBoardState,
  getExternalBoardOptions,
  notify,
}: CommandEnvironment): CollaborationWorkspaceControllerCommands {
  let catalogProjects = getProjects();
  let projectLoadRevision = 0;
  let selectedIssueLoadRevision = 0;
  const projectMutationGenerations = new Map<string, number>();
  const externalColumnLoads = new Set<string>();
  const standardSnapshotLoads = new Map<
    string,
    Promise<WorkspaceBoardSnapshot>
  >();
  const homeSnapshotLoads = new Map<
    string,
    Promise<WorkspaceBoardSnapshot | null>
  >();
  const homeSnapshotResults = new Map<string, WorkspaceBoardSnapshot | null>();
  let homeMyWorkLoad: Promise<WorkspaceMyWorkItem[]> | null = null;
  const loadStandardSnapshot = (projectId: string) => {
    const active = standardSnapshotLoads.get(projectId);
    if (active) return active;
    const pending = api.issues.getBoardSnapshot(projectId).finally(() => {
      if (standardSnapshotLoads.get(projectId) === pending)
        standardSnapshotLoads.delete(projectId);
    });
    standardSnapshotLoads.set(projectId, pending);
    return pending;
  };
  const loadHomeSnapshot = (projectId: string) => {
    const active = homeSnapshotLoads.get(projectId);
    if (active) return active;
    const pending = loadStandardSnapshot(projectId)
      .catch(() => null)
      .then((snapshot) => {
        homeSnapshotResults.set(projectId, snapshot);
        return snapshot;
      })
      .finally(() => {
        if (homeSnapshotLoads.get(projectId) === pending)
          homeSnapshotLoads.delete(projectId);
      });
    homeSnapshotLoads.set(projectId, pending);
    return pending;
  };
  const reportError = (
    message: string,
    source: NonNullable<
      CollaborationWorkspaceControllerState["errorSource"]
    > = "save",
  ) => {
    dispatch({ type: "error", value: message, source });
    notify?.(message, "error");
  };
  const projectMutationGeneration = (projectId: string) =>
    projectMutationGenerations.get(projectId) ?? 0;
  const markProjectMutated = (projectId: string) => {
    projectMutationGenerations.set(
      projectId,
      projectMutationGeneration(projectId) + 1,
    );
    standardSnapshotLoads.delete(projectId);
    homeSnapshotLoads.delete(projectId);
    homeSnapshotResults.delete(projectId);
  };
  const loadProject = async (projectId: string, showLoading = true) => {
    const revision = ++projectLoadRevision;
    const mutationGeneration = projectMutationGeneration(projectId);
    if (showLoading) dispatch({ type: "loading", value: true });
    try {
      const project =
        catalogProjects.find((item) => item.id === projectId) ??
        (await api.projects.get(projectId));
      if (
        revision !== projectLoadRevision ||
        mutationGeneration !== projectMutationGeneration(projectId)
      )
        return;
      if (!catalogProjects.some((item) => item.id === project.id)) {
        catalogProjects = [...catalogProjects, project];
      }
      const externalBoardOptions = getExternalBoardOptions();
      const externalBoard = isExternalGitProject(project)
        ? await loadExternalGitBoardSnapshot(
            api,
            projectId,
            externalBoardOptions,
            getProjectSnapshot(projectId),
          )
        : null;
      const homeSnapshotLoad = homeSnapshotLoads.get(projectId);
      const homeSnapshot = homeSnapshotLoad
        ? await homeSnapshotLoad
        : (homeSnapshotResults.get(projectId) ?? null);
      homeSnapshotLoads.delete(projectId);
      homeSnapshotResults.delete(projectId);
      const snapshot =
        externalBoard?.snapshot ??
        homeSnapshot ??
        (await loadStandardSnapshot(projectId));
      if (
        revision !== projectLoadRevision ||
        mutationGeneration !== projectMutationGeneration(projectId)
      )
        return;
      dispatch({
        type: "project-loaded",
        project,
        snapshot,
        externalBoard: externalBoard
          ? {
              parentId: externalBoardOptions.parentId,
              pageCursors: externalBoard.pageCursors,
            }
          : undefined,
      });
    } catch {
      if (revision !== projectLoadRevision) return;
      reportError(messages.loadFailed, "load");
    } finally {
      if (showLoading && revision === projectLoadRevision) {
        dispatch({ type: "loading", value: false });
      }
    }
  };
  return {
    async loadProjectCatalog(options) {
      const isCurrent = options?.isCurrent ?? (() => true);
      dispatch({ type: "loading", value: true });
      try {
        const projects = await api.projects.list();
        if (!isCurrent()) return;
        catalogProjects = projects;
        dispatch({ type: "project-catalog-loaded", projects: catalogProjects });
      } catch {
        if (!isCurrent()) return;
        reportError(messages.loadFailed, "load");
      } finally {
        if (isCurrent()) dispatch({ type: "loading", value: false });
      }
    },
    async loadProjects() {
      dispatch({ type: "loading", value: true });
      dispatch({ type: "error", value: null });
      try {
        homeMyWorkLoad =
          myWorkEnabled && api.myWork ? api.myWork.list() : Promise.resolve([]);
        const myWorkResult = homeMyWorkLoad.then(
          (items) => ({ status: "fulfilled" as const, items }),
          (error: unknown) => ({ status: "rejected" as const, error }),
        );
        const projects = await api.projects.list();
        catalogProjects = projects;
        dispatch({ type: "project-catalog-loaded", projects });
        const myWorkOutcome = await myWorkResult;
        if (myWorkOutcome.status === "rejected") throw myWorkOutcome.error;
        const myWork = myWorkOutcome.items;
        const snapshots = preloadHomeSnapshots
          ? await Promise.all(
              projects.map(async (project) => ({
                projectId: project.id,
                snapshot: !canPreloadHomeSnapshot(project)
                  ? null
                  : isExternalGitProject(project)
                    ? await loadExternalGitBoardSnapshot(
                        api,
                        project.id,
                        {
                          parentId: null,
                          pageSize: defaultExternalGitBoardPageSize,
                          eager: true,
                        },
                        getProjectSnapshot(project.id),
                      )
                        .then((result) => result.snapshot)
                        .catch(() => null)
                    : await loadHomeSnapshot(project.id),
              })),
            )
          : [];
        dispatch({
          type: "home-loaded",
          projects,
          projectItems: Object.fromEntries(
            snapshots.flatMap(({ projectId, snapshot }) =>
              snapshot ? [[projectId, snapshot.items]] : [],
            ),
          ),
          projectMembers: Object.fromEntries(
            snapshots.flatMap(({ projectId, snapshot }) =>
              snapshot ? [[projectId, snapshot.members]] : [],
            ),
          ),
          projectAgents: Object.fromEntries(
            snapshots.flatMap(({ projectId, snapshot }) =>
              snapshot ? [[projectId, snapshot.agents]] : [],
            ),
          ),
          projectTaskBindings: Object.fromEntries(
            snapshots.flatMap(({ projectId, snapshot }) =>
              snapshot ? [[projectId, snapshot.taskBindings]] : [],
            ),
          ),
          myWork,
        });
      } catch {
        reportError(messages.loadFailed, "load");
      } finally {
        dispatch({ type: "loading", value: false });
      }
    },
    async loadMyWork() {
      if (!myWorkEnabled || !api.myWork) {
        homeMyWorkLoad = null;
        dispatch({ type: "my-work-loaded", items: [] });
        return;
      }
      dispatch({ type: "loading", value: true });
      dispatch({ type: "error", value: null });
      try {
        const pending = homeMyWorkLoad;
        homeMyWorkLoad = null;
        dispatch({
          type: "my-work-loaded",
          items: await (pending ?? api.myWork.list()),
        });
      } catch {
        reportError(messages.loadFailed, "load");
      } finally {
        dispatch({ type: "loading", value: false });
      }
    },
    loadProject,
    async loadProjectSnapshot(projectId) {
      const mutationGeneration = projectMutationGeneration(projectId);
      try {
        const project = catalogProjects.find(
          (candidate) => candidate.id === projectId,
        );
        const snapshot =
          project && isExternalGitProject(project)
            ? (
                await loadExternalGitBoardSnapshot(
                  api,
                  projectId,
                  {
                    parentId: null,
                    pageSize: defaultExternalGitBoardPageSize,
                    eager: true,
                  },
                  getProjectSnapshot(projectId),
                )
              ).snapshot
            : await api.issues.getBoardSnapshot(projectId);
        if (mutationGeneration !== projectMutationGeneration(projectId))
          return null;
        dispatch({ type: "project-snapshot-loaded", projectId, snapshot });
        return snapshot;
      } catch {
        reportError(messages.loadFailed, "load");
        return null;
      }
    },
    async loadMoreExternalColumn(status) {
      const externalState = getExternalBoardState();
      const project = externalState.project;
      const cursor = externalState.externalPageCursors[status];
      if (
        !project ||
        !isExternalGitProject(project) ||
        !cursor ||
        externalState.externalPageLoading[status]
      ) {
        return;
      }
      const parentId = externalState.externalBoardParentId;
      const requestKey = `${project.id}\0${parentId ?? ""}\0${status}\0${cursor}`;
      if (externalColumnLoads.has(requestKey)) return;
      externalColumnLoads.add(requestKey);
      dispatch({ type: "external-column-loading", status, value: true });
      try {
        const page = await api.issues.listPage(project.id, {
          status,
          parentId,
          cursor,
          limit: getExternalBoardOptions().pageSize,
        });
        const currentState = getExternalBoardState();
        if (
          currentState.project?.id !== project.id ||
          currentState.externalBoardParentId !== parentId ||
          currentState.externalPageCursors[status] !== cursor
        ) {
          return;
        }
        dispatch({
          type: "external-column-appended",
          projectId: project.id,
          status,
          items: page.items,
          taskBindings: page.taskBindings,
          nextCursor: page.nextCursor,
        });
      } catch {
        reportError(messages.loadFailed, "load");
      } finally {
        externalColumnLoads.delete(requestKey);
        dispatch({ type: "external-column-loading", status, value: false });
      }
    },
    async getIssue(issueId) {
      try {
        const issue = await api.issues.get(issueId);
        dispatch({ type: "replace-issue", issue });
        return issue;
      } catch {
        reportError(messages.loadFailed, "load");
        return null;
      }
    },
    async loadSelectedIssue(issueId) {
      const revision = ++selectedIssueLoadRevision;
      try {
        const [issue, attachments, comments] = await Promise.all([
          api.issues.get(issueId),
          api.attachments.list(issueId),
          api.comments.list(issueId),
        ]);
        const [loadedAssignments, executions] = await Promise.all([
          api.assignments ? api.assignments.list(issueId) : Promise.resolve([]),
          api.executions?.list
            ? api.executions
                .list(issue.cloud_project_id, { includeTerminal: true })
                .then((items) =>
                  items.filter(
                    (execution) => execution.loop_item_id === issueId,
                  ),
                )
            : Promise.resolve([]),
        ]);
        if (revision !== selectedIssueLoadRevision) return null;
        dispatch({
          type: "issue-loaded",
          issue,
          attachments,
          comments,
          assignments: loadedAssignments,
          executions,
        });
        return issue;
      } catch {
        if (revision !== selectedIssueLoadRevision) return null;
        reportError(messages.loadFailed, "load");
        return null;
      }
    },
    clearProject: () => {
      projectLoadRevision += 1;
      dispatch({ type: "clear-project" });
    },
    clearSelectedIssue: () => {
      selectedIssueLoadRevision += 1;
      dispatch({ type: "clear-selected-issue" });
    },
    async createProject(input) {
      try {
        const project = await api.projects.create(input);
        catalogProjects = [project, ...catalogProjects];
        dispatch({ type: "replace-project", project });
        return project;
      } catch {
        reportError(messages.saveFailed);
        return null;
      }
    },
    async updateProject(projectId, input) {
      try {
        const project = await api.projects.update(projectId, input);
        markProjectMutated(projectId);
        catalogProjects = catalogProjects.map((item) =>
          item.id === project.id ? project : item,
        );
        dispatch({ type: "replace-project", project });
        return project;
      } catch {
        reportError(messages.saveFailed);
        return null;
      }
    },
    async archiveProject(projectId, version) {
      try {
        await api.projects.archive(projectId, version);
        markProjectMutated(projectId);
        catalogProjects = catalogProjects.filter(
          (project) => project.id !== projectId,
        );
        dispatch({ type: "remove-project", projectId });
        return true;
      } catch {
        reportError(messages.saveFailed);
        return false;
      }
    },
    async createIssue(projectId, input, options) {
      try {
        const issue = await api.issues.create(projectId, input);
        markProjectMutated(projectId);
        dispatch({ type: "append-issue", issue });
        return issue;
      } catch (error) {
        reportError(messages.saveFailed);
        if (options?.throwOnError) throw error;
        return null;
      }
    },
    async updateIssue(issueId, input, options) {
      try {
        const issue = await api.issues.update(issueId, input);
        markProjectMutated(issue.cloud_project_id);
        dispatch({ type: "replace-issue", issue });
        return issue;
      } catch (error) {
        reportError(messages.saveFailed);
        if (options?.throwOnError) throw error;
        return null;
      }
    },
    async assignIssue(projectId, issueId, input) {
      try {
        const issue = await api.issues.assign(projectId, issueId, input);
        markProjectMutated(projectId);
        dispatch({ type: "replace-issue", issue });
        return issue;
      } catch {
        reportError(messages.saveFailed);
        return null;
      }
    },
    async archiveIssue(issueId) {
      try {
        const archivedIssue = getExternalBoardState().issues.find(
          (candidate) => candidate.id === issueId,
        );
        await api.issues.archive(issueId);
        if (archivedIssue) markProjectMutated(archivedIssue.cloud_project_id);
        dispatch({ type: "remove-issue", issueId });
        return true;
      } catch {
        reportError(messages.saveFailed);
        return false;
      }
    },
    async reorderIssue({ issue, status, laneIds, optimisticItems }) {
      dispatch({ type: "replace-issues", issues: optimisticItems });
      try {
        if (issue.status !== status) {
          const movedIssue = await api.issues.update(issue.id, {
            version: issue.version,
            status,
          });
          markProjectMutated(issue.cloud_project_id);
          dispatch({
            type: "replace-issue",
            issue: movedIssue,
          });
        }
        const updated = await api.issues.reorder(issue.cloud_project_id, {
          parentId: issue.parent_id,
          status,
          issueIds: laneIds,
        });
        markProjectMutated(issue.cloud_project_id);
        const byId = new Map(updated.map((item) => [item.id, item]));
        dispatch({
          type: "replace-issues",
          issues: optimisticItems.map((item) => {
            const reordered = byId.get(item.id);
            if (!reordered) return item;
            return reordered.version < item.version ? item : reordered;
          }),
        });
      } catch (error) {
        if (errorStatus(error) === 409) {
          await loadProject(issue.cloud_project_id, false);
          reportError(messages.conflict, "conflict");
        } else {
          reportError(messages.saveFailed);
        }
      }
    },
    async changeProjectGroup({ project, groupBy, defaultStatuses }) {
      const config = project.board_config ?? {
        group_by: "status" as const,
        processing_start_status_id: defaultStatuses[1]?.id ?? null,
        statuses: defaultStatuses,
      };
      dispatch({
        type: "replace-project",
        project: { ...project, board_config: { ...config, group_by: groupBy } },
      });
      try {
        const updated = await api.projects.update(project.id, {
          version: project.version,
          boardConfig: { ...config, group_by: groupBy },
        });
        markProjectMutated(project.id);
        catalogProjects = catalogProjects.map((item) =>
          item.id === updated.id ? updated : item,
        );
        dispatch({ type: "replace-project", project: updated });
      } catch (error) {
        if (errorStatus(error) === 409) await loadProject(project.id, false);
        else dispatch({ type: "replace-project", project });
        reportError(messages.saveFailed);
      }
    },
    async refreshSelectedIssue() {
      const issue = getSelectedIssue();
      if (!issue) return;
      try {
        dispatch({
          type: "replace-issue",
          issue: await api.issues.get(issue.id),
        });
        reportError(messages.conflict, "conflict");
      } catch {
        reportError(messages.loadFailed, "load");
      }
    },
    replaceProject: (project) => {
      markProjectMutated(project.id);
      catalogProjects = catalogProjects.map((item) =>
        item.id === project.id ? project : item,
      );
      dispatch({ type: "replace-project", project });
    },
    appendIssue: (issue) => {
      markProjectMutated(issue.cloud_project_id);
      dispatch({ type: "append-issue", issue });
    },
    replaceIssue: (issue) => {
      markProjectMutated(issue.cloud_project_id);
      dispatch({ type: "replace-issue", issue });
    },
    replaceAttachments: (attachments) =>
      dispatch({ type: "replace-attachments", attachments }),
    replaceComments: (comments) =>
      dispatch({ type: "replace-comments", comments }),
    replaceAssignments: (assignments) =>
      dispatch({ type: "replace-assignments", assignments }),
    reportError,
  };
}

export function useCollaborationWorkspaceController({
  api,
  location,
  messages,
  myWorkEnabled = api?.myWork !== undefined,
  pollIntervalMs = 15_000,
  loadProjectOnLocation = true,
  preloadHomeSnapshots = true,
  externalBoard = {
    parentId: null,
    pageSize: defaultExternalGitBoardPageSize,
    eager: true,
  },
  notify,
}: CollaborationWorkspaceControllerOptions): CollaborationWorkspaceController {
  const [state, dispatch] = useReducer(
    collaborationWorkspaceControllerReducer,
    initialCollaborationWorkspaceControllerState,
  );
  const selectedIssueRef = useRef(state.selectedIssue);
  const projectsRef = useRef(state.projects);
  const projectItemsRef = useRef(state.projectItems);
  const projectMembersRef = useRef(state.projectMembers);
  const projectAgentsRef = useRef(state.projectAgents);
  const projectTaskBindingsRef = useRef(state.projectTaskBindings);
  const stateRef = useRef(state);
  const externalBoardRef = useRef(externalBoard);
  const notifyRef = useRef(notify);
  const locationLoadRevisionRef = useRef(0);
  selectedIssueRef.current = state.selectedIssue;
  projectsRef.current = state.projects;
  projectItemsRef.current = state.projectItems;
  projectMembersRef.current = state.projectMembers;
  projectAgentsRef.current = state.projectAgents;
  projectTaskBindingsRef.current = state.projectTaskBindings;
  stateRef.current = state;
  externalBoardRef.current = externalBoard;
  notifyRef.current = notify;
  const commands = useMemo(() => {
    if (!api) return null;
    return createCollaborationWorkspaceControllerCommands({
      api,
      messages,
      myWorkEnabled,
      preloadHomeSnapshots,
      dispatch,
      getProjects: () => projectsRef.current,
      getProjectSnapshot: (projectId) => {
        const items = projectItemsRef.current[projectId];
        const members = projectMembersRef.current[projectId];
        const agents = projectAgentsRef.current[projectId];
        const taskBindings = projectTaskBindingsRef.current[projectId];
        if (!items || !members || !agents || !taskBindings) return null;
        return { items, members, agents, taskBindings };
      },
      getSelectedIssue: () => selectedIssueRef.current,
      getExternalBoardState: () => stateRef.current,
      getExternalBoardOptions: () => externalBoardRef.current,
      notify: (message, kind) => notifyRef.current?.(message, kind),
    });
  }, [api, messages, myWorkEnabled, preloadHomeSnapshots]);

  useEffect(() => {
    if (!commands) return;
    const revision = ++locationLoadRevisionRef.current;
    const isCurrent = () => locationLoadRevisionRef.current === revision;
    if (location.projectId) {
      const projectId = location.projectId;
      void commands.loadProjectCatalog({ isCurrent }).then(() => {
        if (!isCurrent() || !loadProjectOnLocation) return;
        return commands.loadProject(projectId);
      });
      if (myWorkEnabled && location.rootView === "my-work")
        void commands.loadMyWork();
    } else if (myWorkEnabled && location.rootView === "my-work") {
      commands.clearProject();
      void commands.loadMyWork();
    } else {
      commands.clearProject();
      void commands.loadProjects();
    }
    return () => {
      if (isCurrent()) locationLoadRevisionRef.current += 1;
    };
  }, [
    commands,
    loadProjectOnLocation,
    location.projectId,
    location.rootView,
    myWorkEnabled,
  ]);

  useEffect(() => {
    if (!commands) return;
    const projectId = location.projectId;
    if (!projectId || pollIntervalMs <= 0) return;
    const timer = window.setInterval(
      () => void commands.loadProject(projectId, false),
      pollIntervalMs,
    );
    return () => window.clearInterval(timer);
  }, [commands, location.projectId, pollIntervalMs]);

  useEffect(() => {
    if (!commands) return;
    commands.clearSelectedIssue();
    if (location.issueId) void commands.loadSelectedIssue(location.issueId);
  }, [commands, location.issueId]);

  const locationState =
    state.selectedIssue?.id === location.issueId
      ? state
      : {
          ...state,
          selectedIssue: null,
          attachments: [],
          comments: [],
          assignments: [],
          executions: [],
        };

  return {
    state: locationState,
    commands: commands ?? unavailableCollaborationWorkspaceControllerCommands,
  };
}
