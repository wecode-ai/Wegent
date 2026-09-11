// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import type { ReactNode } from "react";
import type { ProjectCreateHostAdapter } from "./project-create/types";

export type CollaborationProjectId = string;

export type CollaborationRole =
  | "Owner"
  | "Maintainer"
  | "Developer"
  | "Reporter";

export type CollaborationPriority =
  | "none"
  | "low"
  | "medium"
  | "high"
  | "urgent";

export type CollaborationStatusColor =
  | "gray"
  | "blue"
  | "orange"
  | "purple"
  | "green"
  | "red";

export interface CollaborationStatus {
  id: string;
  name: string;
  color: CollaborationStatusColor;
}

export interface CollaborationProject {
  id: CollaborationProjectId;
  workspace_id?: string | null;
  public_id: string;
  project_key: string;
  name: string;
  description: string;
  project_store: "local" | "backend";
  task_provider: string;
  provider_config: Record<string, unknown>;
  board_config?: {
    group_by: "status" | "priority" | "assignee" | "tag";
    processing_start_status_id: string | null;
    statuses: CollaborationStatus[];
  };
  card_display?: {
    show_assignee: boolean;
    show_priority: boolean;
    show_tags: boolean;
    show_date: boolean;
  };
  created_by_user_id: number;
  current_user_id?: number;
  current_user_name?: string;
  access_role?: CollaborationRole | "RestrictedAnalyst";
  visibility?: "private" | "public";
  status: string;
  tags: string[];
  version: number;
  created_at: string;
  updated_at: string;
}

export type LocalCollaborationProject = CollaborationProject & {
  project_store: "local";
};

export type BackendCollaborationProject = CollaborationProject & {
  project_store: "backend";
  access_role: CollaborationRole | "RestrictedAnalyst";
};

export interface CollaborationIssue {
  id: string;
  cloud_project_id: CollaborationProjectId;
  sequence_number: number;
  parent_id: string | null;
  created_by_user_id: number;
  created_by_user_name?: string | null;
  assignee_user_id: number | null;
  assignee_name?: string | null;
  assignee_agent_id?: string | null;
  assignee_agent_name?: string | null;
  assignee_team_id?: number | null;
  assignee_team_name?: string | null;
  execution_id?: number | null;
  execution_state?: string | null;
  title: string;
  description: string;
  status: string;
  priority: CollaborationPriority;
  due_at: string | null;
  tags: string[];
  sort_order: number;
  version: number;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
  can_view_detail?: boolean;
  can_edit?: boolean;
  assignment_history?: SharedIssueAssignmentHistoryEntry[];
  status_history?: SharedIssueStatusHistoryEntry[];
  automation?: { trigger?: string; [key: string]: unknown } | null;
  workflow?: {
    advancement_policy?: "manual" | "ai";
    orchestration_status?:
      | "idle"
      | "planning"
      | "awaiting_approval"
      | "dispatching"
      | "running"
      | "awaiting_review"
      | "paused"
      | "completed"
      | "failed";
    nodes?: unknown[];
  } | null;
  execution_error?: string | null;
  source_record_id?: string | null;
  source_cells?: Record<string, unknown>;
}

export type CollaborationAssignmentTargetType = "human" | "agent";

export interface CollaborationAssignment {
  id: string;
  issue_id: string;
  target_type: CollaborationAssignmentTargetType;
  target_id: string;
  target_name: string;
  workflow_step: string | null;
  comment_id: string | null;
  created_by_user_id: number;
  created_by_user_name: string | null;
  status: "active" | "completed" | "cancelled";
  created_at: string;
  updated_at: string;
}

export interface CollaborationWorkspace {
  id: string;
  name: string;
  description: string;
  access_role: CollaborationRole | "Member";
  member_count: number;
  agent_count: number;
  execution_environment_count: number;
  project_count: number;
  created_by_user_id: number;
  version: number;
  created_at: string;
  updated_at: string;
}

export interface CollaborationExecutionEnvironment {
  id: string;
  device_id?: number;
  device_key?: string;
  name: string;
  kind: "local_device" | "cloud_host";
  owner_type: "user" | "workspace";
  owner_id: string;
  owner_name: string;
  status: "online" | "offline" | "provisioning" | "error";
  workspace_ids: string[];
  updated_at: string;
}

export interface CollaborationOwnedAgent extends CollaborationAgent {
  owner_type: "user" | "workspace";
  owner_id: string;
  owner_name: string;
  status: "available" | "unavailable";
  execution_environment_ids: string[];
  workspace_ids: string[];
}

export interface CollaborationPlatformResources {
  agents: CollaborationOwnedAgent[];
  execution_environments: CollaborationExecutionEnvironment[];
}

export type EditableLocalCollaborationIssue = CollaborationIssue & {
  can_edit: true;
};

export type BackendCollaborationIssue = CollaborationIssue & {
  can_edit: boolean;
};

export interface SharedIssueAssignmentHistoryEntry {
  by_user_id: number;
  to_type: "user" | "agent" | "team" | null;
  to_id: string | null;
  to_name?: string | null;
  action: "assign" | "reassign" | "unassign";
  at: string;
}

export interface SharedIssueStatusHistoryEntry {
  from_status: string;
  from_status_name?: string | null;
  to_status: string;
  to_status_name?: string | null;
  trigger: string;
  by_user_id: number | null;
  at: string;
}

export interface CollaborationMember {
  id: number;
  user_id: number;
  user_name: string;
  email: string | null;
  role: CollaborationRole;
  capability_description?: string;
}

export interface CollaborationUser {
  id: number;
  user_name: string;
  email: string | null;
}

export interface CollaborationAgent {
  id: string;
  name: string;
  agent_id?: string;
  team_id?: number;
}

export interface CollaborationAttachment {
  id: string;
  loop_item_id: string;
  display_name: string;
  content_type: string | null;
  size_bytes: number;
  created_by_user_id: number;
  created_at: string;
  markdown_url: string;
  markdown?: string | null;
}

export interface CollaborationComment {
  id: string;
  body: string;
  author: string;
  web_url: string | null;
  created_at: string;
  updated_at: string;
}

export interface CollaborationFile {
  id: string;
  cloud_project_id: CollaborationProjectId;
  path: string;
  name: string;
  kind: "file" | "folder";
  content_type: string | null;
  size_bytes: number;
  description: string;
  version: number;
  created_at: string;
  updated_at: string;
}

export interface CollaborationExecution {
  id: number;
  loop_item_id: string;
  cloud_project_id: CollaborationProjectId;
  task_title: string;
  task_status: string | null;
  task_priority: string | null;
  executor_type: string;
  agent_id: string | null;
  team_id?: number | null;
  assigner_user_id: number;
  executor_owner_user_id: number | null;
  status: string;
  display_state: string;
  observed_state: string;
  sync_state: string;
  queued_at: string | null;
  started_at?: string | null;
  completed_at?: string | null;
  error_message?: string | null;
  execution_note: string | null;
  runtime_profile_id: string | null;
  runtime_source: string | null;
  can_select_runtime: boolean;
  waiting_runtime_reason: string | null;
  version: number;
  created_at: string;
  updated_at: string;
}

export interface CollaborationBoardSnapshot {
  items: CollaborationIssue[];
  members: CollaborationMember[];
  agents: CollaborationAgent[];
}

export interface CollaborationCapabilities {
  myWork?: boolean;
  automation: boolean;
  dingtalkAitable: boolean;
}

export type CollaborationView =
  | "board"
  | "table"
  | "files"
  | "automation"
  | "manage";
export type CollaborationRootView = "home" | "my-work";

export interface CollaborationLocation {
  projectId: string | null;
  issueId: string | null;
  view: CollaborationView;
  rootView?: CollaborationRootView;
}

export interface CollaborationHostAdapter {
  capabilities: CollaborationCapabilities;
  location: CollaborationLocation;
  navigate(location: CollaborationLocation): void;
  onProjectsChange?(projects: CollaborationProject[]): void;
  openExternal?(url: string): void;
  notify?(message: string, kind?: "success" | "error"): void;
  projectCreate?: ProjectCreateHostAdapter;
  projectActions?: Array<{
    id: string;
    label: string;
    testId: string;
    renderIcon?: () => ReactNode;
    invoke(project: CollaborationProject): void;
  }>;
}
