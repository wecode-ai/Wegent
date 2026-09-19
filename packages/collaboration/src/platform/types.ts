// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import type { ReactNode } from "react";

import type { CollaborationView } from "../types";
import type { ProjectAgentConfigurationHost } from "../project-agent-config/types";

export type CollaborationPlatformView = "spaces" | "resources";
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
  rootView?: CollaborationPlatformRootView;
  workspaceId: string | null;
  workspaceView: CollaborationWorkspaceView;
  projectId: string | null;
  projectView: CollaborationView;
  issueId: string | null;
}

export interface CollaborationPlatformHostAdapter {
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
  notify?(message: string, kind: "success" | "error"): void;
  openExternal?(url: string): void;
  workspaceOwnerOptions?: Array<{
    label: string;
    namespace: string;
  }>;
  projectAgentConfiguration?: ProjectAgentConfigurationHost;
}
