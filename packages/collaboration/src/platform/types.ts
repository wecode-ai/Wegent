// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import type { CollaborationView } from "../types";
import type { ProjectAgentConfigurationHost } from "../project-agent-config/types";

export type CollaborationPlatformView = "spaces" | "resources";
export type CollaborationPlatformRootView =
  | "home"
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
  location: CollaborationPlatformLocation;
  capabilities: {
    automation: boolean;
    dingtalkAitable: boolean;
    projectLocation?: "cloud" | "local";
    workspaceLocations?: readonly ("local" | "cloud")[];
    sidebarPresentation?: "full" | "context";
  };
  navigate(location: CollaborationPlatformLocation): void;
  manageResource?(kind: "agents" | "environments", resourceId?: string): void;
  notify?(message: string, kind: "success" | "error"): void;
  openExternal?(url: string): void;
  workspaceOwnerOptions?: Array<{
    label: string;
    namespace: string;
  }>;
  projectAgentConfiguration?: ProjectAgentConfigurationHost;
}
