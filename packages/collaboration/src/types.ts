// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import type { ReactNode } from "react";
import type { ProjectAgentConfigurationHost } from "./project-agent-config/types";
import type { ProjectCreateHostAdapter } from "./project-create/types";

export type CollaborationProjectId = string;

export type CollaborationRole = "Owner" | "Maintainer" | "Developer" | "Viewer";
export type CollaborationWorkspaceRole =
  | CollaborationRole
  | "Reporter"
  | "RestrictedAnalyst";

export type CollaborationProjectVisibility = "private" | "public";

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
  workspace_context?: Omit<
    CollaborationWorkspaceNavigationContext,
    "location"
  > | null;
  public_id: string;
  project_key: string;
  name: string;
  description: string;
  project_store: "local" | "backend";
  task_provider: string;
  provider_config: Record<string, unknown>;
  execution_environment?: CollaborationExecutionEnvironmentConfig;
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
  collaboration_groups?: CollaborationGroup[];
  automatic_processing_rules?: import("./ports/SharedWorkspaceApi").WorkspaceAutomationRule[];
  created_by_user_id: number;
  current_user_id?: number;
  current_user_name?: string;
  access_role?: CollaborationRole;
  public_access?: { role: "Developer" | "Viewer" } | null;
  default_issue_security?: "open" | "related";
  visibility?: CollaborationProjectVisibility;
  status: string;
  tags: string[];
  version: number;
  created_at: string;
  updated_at: string;
  metadata?: Record<string, unknown>;
}

export type LocalCollaborationProject = CollaborationProject & {
  project_store: "local";
};

export type BackendCollaborationProject = CollaborationProject & {
  project_store: "backend";
  access_role: CollaborationRole;
};

export interface CollaborationIssue {
  id: string;
  cloud_project_id: CollaborationProjectId;
  sequence_number: number;
  parent_id: string | null;
  created_by_user_id: number;
  created_by_user_name?: string | null;
  assignee_user_id: number | null;
  assignee_group_id?: string | null;
  assignee_group_name?: string | null;
  assignee_name?: string | null;
  assignee_agent_id?: string | null;
  assignee_agent_name?: string | null;
  assignee_team_id?: number | null;
  assignee_team_name?: string | null;
  execution_id?: number | null;
  execution_state?: string | null;
  execution_note?: string | null;
  can_approve?: boolean;
  ai_state?: { status?: string | null; last_error?: string | null } | null;
  title: string;
  description: string;
  status: string;
  priority: CollaborationPriority;
  due_at: string | null;
  tags: string[];
  sort_order: number;
  current_delivery_id?: string | null;
  content_revision?: number;
  activity_read_sequence?: number;
  is_unread?: boolean;
  version: number;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
  can_view_detail?: boolean;
  can_edit?: boolean;
  security_level?: "open" | "related";
  assignment_history?: SharedIssueAssignmentHistoryEntry[];
  status_history?: SharedIssueStatusHistoryEntry[];
  automation?: { trigger?: string; [key: string]: unknown } | null;
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
  body: string;
  comment_id: string | null;
  created_by_user_id: number;
  created_by_user_name: string | null;
  status: "active" | "completed" | "cancelled";
  created_at: string;
  updated_at: string;
}

export interface CollaborationWorkspace {
  id: string;
  location: "local" | "cloud";
  name: string;
  description: string;
  namespace: string;
  access_role: CollaborationWorkspaceRole | "Member";
  member_count: number;
  agent_count: number;
  execution_environment_count: number;
  execution_environment?: CollaborationExecutionEnvironmentConfig;
  project_count: number;
  created_by_user_id: number;
  version: number;
  created_at: string;
  updated_at: string;
}

export interface CollaborationExecutionEnvironmentDeviceState {
  status?: "preparing" | "ready" | "error";
  workspace_path?: string;
  prepared_at?: string | null;
  error?: string;
}

export interface CollaborationExecutionEnvironmentConfig {
  repositories: CollaborationExecutionEnvironmentRepository[];
  setup_steps: CollaborationExecutionEnvironmentSetupStep[];
  fingerprint?: string;
  // Preparation state is per device, keyed by the device's route id
  // (`device_key` on the environment row), so preparing on one device never
  // overwrites another device's record.
  devices?: Record<string, CollaborationExecutionEnvironmentDeviceState>;
}

export interface CollaborationExecutionEnvironmentRepository {
  name: string;
  url: string;
  ref: string;
  path: string;
  primary: boolean;
}

export interface CollaborationExecutionEnvironmentSetupStep {
  command: string;
  working_directory: string;
}

export interface CollaborationWorkspaceNavigationContext {
  id: string;
  public_id: string;
  location: "cloud";
  name: string;
}

export interface CollaborationExecutionEnvironment {
  id: string;
  device_id?: number;
  device_key?: string;
  is_current_device?: boolean;
  name: string;
  kind: "local_device" | "cloud_host";
  coding_tools: string[];
  owner_type: "user" | "workspace";
  owner_id: string;
  owner_name: string;
  status: "online" | "offline" | "provisioning" | "error";
  updated_at: string;
}

export interface CollaborationOwnedAgent extends CollaborationAgent {
  location?: "local" | "cloud";
  version?: number;
  owner_type: "user" | "workspace";
  owner_id: string;
  owner_name: string;
  status: "available" | "unavailable";
  execution_environment_ids: string[];
  project_binding_input?: Record<string, unknown>;
}

export interface CollaborationPlatformResources {
  agents: CollaborationOwnedAgent[];
  execution_environments: CollaborationExecutionEnvironment[];
}

export interface CollaborationGroupMember {
  kind: "human" | "agent";
  id: string;
  responsibility: string;
}

export interface CollaborationGroupStage {
  id: string;
  name: string;
  description: string;
  assignee: CollaborationGroupMember | null;
}

export interface CollaborationGroup {
  id: string;
  workspace_id: string;
  owner_type: "workspace" | "project";
  owner_id: string;
  name: string;
  description: string;
  instructions?: string;
  leader: CollaborationGroupMember;
  members: CollaborationGroupMember[];
  coordination_mode: "manager";
  stages: CollaborationGroupStage[];
  execution_requirements?: {
    required_tags: string[];
  };
  version: number;
  created_by_user_id: number;
  created_at: string;
  updated_at: string;
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

export interface CollaborationWorkspaceMember extends Omit<
  CollaborationMember,
  "role"
> {
  role: CollaborationWorkspaceRole;
}

export interface CollaborationUser {
  id: number;
  user_name: string;
  email: string | null;
}

export interface CollaborationAgent {
  createdByUserId?: number | null;
  createdByUserName?: string | null;
  deletable?: boolean;
  runtime?: string;
  status?: string;
  systemPrompt?: string;
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
  backend_task_id?: number | null;
  execution_environment?: string | null;
  execution_device_id?: string | null;
  runtime_instance_id?: string | null;
  runtime_device_id?: string | null;
  runtime_task_id?: string | null;
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
  projectLocation?: "cloud" | "local";
}

export interface CollaborationDefaultAssistant {
  name: string;
  description: string;
  capabilitySummary?: string;
}

export type CollaborationView = "board" | "table" | "files" | "manage";
export type CollaborationRootView = "home" | "my-work";
export type ProjectSettingsSectionId =
  | "project"
  | "collaboration-participants"
  | "environments"
  | "automatic-processing";

export interface CollaborationLocation {
  projectId: string | null;
  issueId: string | null;
  view: CollaborationView;
  rootView?: CollaborationRootView;
  projectSettingsSection?: ProjectSettingsSectionId | null;
}

export interface CollaborationHostAdapter {
  capabilities: CollaborationCapabilities;
  defaultAssistant?: CollaborationDefaultAssistant;
  location: CollaborationLocation;
  navigate(location: CollaborationLocation): void;
  manageResource?(kind: "agents" | "environments", resourceId?: string): void;
  onProjectsChange?(projects: CollaborationProject[]): void;
  openExternal?(url: string): void;
  notify?(message: string, kind?: "success" | "error"): void;
  projectAgentConfiguration?: ProjectAgentConfigurationHost;
  projectAgentResourceContext?: {
    name: string;
    namespace: string;
  };
  projectCreate?: ProjectCreateHostAdapter;
  projectActions?: Array<{
    id: string;
    label: string;
    testId: string;
    renderIcon?: () => ReactNode;
    invoke(project: CollaborationProject): void;
  }>;
}
