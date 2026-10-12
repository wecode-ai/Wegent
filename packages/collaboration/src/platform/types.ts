// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import type { ReactNode } from "react";

import type {
  CollaborationDefaultAssistant,
  CollaborationProject,
  CollaborationView,
  ProjectSettingsSectionId,
  CollaborationWorkspace,
} from "../types";
import type { ProjectAgentConfigurationHost } from "../project-agent-config/types";
import type {
  ProjectCreateCollaborationGroupDraft,
  ProjectCreateCollaborationGroupDraftInput,
  ProjectCreateCollaborationGroupGenerationEvent,
  ProjectCreateGenerationModelCatalog,
  ProjectCreateGenerationProgressPhase,
} from "../project-create/types";

export type CollaborationPlatformView = "spaces" | "resources";
export type CollaborationDomain = "local" | "cloud";
export type CollaborationPlatformRootView =
  | "home"
  | "agents"
  | "teams"
  | "devices"
  | "my-work"
  | "inbox"
  | "runs";

export type CollaborationWorkspaceView =
  | "home"
  | "projects"
  | "members"
  | "agents"
  | "collaboration-participants"
  | "collaboration-groups"
  | "execution-environments"
  | "settings";

export interface CollaborationPlatformLocation {
  platformView: CollaborationPlatformView;
  collaborationDomain?: CollaborationDomain;
  rootView?: CollaborationPlatformRootView;
  workspaceId: string | null;
  workspaceView: CollaborationWorkspaceView;
  projectId: string | null;
  projectView: CollaborationView;
  projectSettingsSection?: ProjectSettingsSectionId | null;
  issueId: string | null;
}

export interface CollaborationPlatformHostAdapter {
  currentUser?: {
    id: number;
    name: string;
  };
  cloudAccess?: {
    authenticated: boolean;
    requestLogin(): void;
  };
  renderIssueComposer?(
    props: import("./IssueHomeComposer").IssueHomeTaskComposerProps,
  ): ReactNode;
  location: CollaborationPlatformLocation;
  capabilities: {
    automation: boolean;
    dingtalkAitable: boolean;
    projectLocation?: "cloud" | "local";
    workspaceLocations?: readonly ("local" | "cloud")[];
    sidebarPresentation?: "full" | "context";
  };
  defaultAssistant?: CollaborationDefaultAssistant;
  navigate(location: CollaborationPlatformLocation): void;
  manageResource?(
    kind: "agents" | "environments",
    resourceId?: string,
    source?: "local" | "cloud",
  ): void;
  renderDeviceCreator?(input: {
    source: "local" | "cloud";
    workspaceId?: string;
    hasCloudDevice: boolean;
    onClose(): void;
    onCreated(deviceId?: number): Promise<void>;
  }): ReactNode;
  renderProjectImporter?(input: {
    workspace: CollaborationWorkspace;
    mode: "folder" | "existing";
    projects: CollaborationProject[];
    onClose(): void;
    onImported(project: CollaborationProject): Promise<void>;
  }): ReactNode;
  notify?(message: string, kind: "success" | "error"): void;
  openExternal?(url: string): void;
  workspaceOwnerOptions?: Array<{
    label: string;
    namespace: string;
  }>;
  projectAgentConfiguration?: ProjectAgentConfigurationHost;
  generateProjectCollaborationGroupDraft?(
    input: ProjectCreateCollaborationGroupDraftInput,
    onProgress?: (phase: ProjectCreateGenerationProgressPhase) => void,
    onEvent?: (event: ProjectCreateCollaborationGroupGenerationEvent) => void,
  ): Promise<ProjectCreateCollaborationGroupDraft>;
  loadProjectCollaborationGroupGenerationModels?(): Promise<ProjectCreateGenerationModelCatalog>;
}
