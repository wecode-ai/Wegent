// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import type { CollaborationView } from "../types";

export type CollaborationPlatformView = "spaces" | "resources";

export type CollaborationWorkspaceView =
  | "home"
  | "projects"
  | "members"
  | "agents"
  | "execution-environments"
  | "settings";

export interface CollaborationPlatformLocation {
  platformView: CollaborationPlatformView;
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
  };
  navigate(location: CollaborationPlatformLocation): void;
  notify?(message: string, kind: "success" | "error"): void;
  openExternal?(url: string): void;
}
