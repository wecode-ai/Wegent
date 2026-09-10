// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import type { ReactNode } from 'react'

export type CollaborationProjectId = string

export type CollaborationRole = 'Owner' | 'Maintainer' | 'Developer' | 'Reporter'

export type CollaborationPriority = 'none' | 'low' | 'medium' | 'high' | 'urgent'

export type CollaborationStatusColor = 'gray' | 'blue' | 'orange' | 'purple' | 'green' | 'red'

export interface CollaborationStatus {
  id: string
  name: string
  color: CollaborationStatusColor
}

export interface CollaborationProject {
  id: CollaborationProjectId
  public_id: string
  project_key: string
  name: string
  description: string
  project_store: 'local' | 'backend'
  task_provider: string
  provider_config: Record<string, unknown>
  board_config?: {
    group_by: 'status' | 'priority' | 'assignee' | 'tag'
    processing_start_status_id: string | null
    statuses: CollaborationStatus[]
  }
  card_display?: {
    show_assignee: boolean
    show_priority: boolean
    show_tags: boolean
    show_date: boolean
  }
  created_by_user_id: number
  current_user_id?: number
  current_user_name?: string
  access_role?: CollaborationRole | 'RestrictedAnalyst'
  visibility?: 'private' | 'public'
  status: string
  tags: string[]
  version: number
  created_at: string
  updated_at: string
}

export interface CollaborationIssue {
  id: string
  cloud_project_id: CollaborationProjectId
  sequence_number: number
  parent_id: string | null
  created_by_user_id: number
  created_by_user_name?: string | null
  assignee_user_id: number | null
  assignee_name?: string | null
  assignee_agent_id?: string | null
  assignee_agent_name?: string | null
  assignee_team_id?: number | null
  assignee_team_name?: string | null
  execution_id?: number | null
  execution_state?: string | null
  title: string
  description: string
  status: string
  priority: CollaborationPriority
  due_at: string | null
  tags: string[]
  sort_order: number
  version: number
  created_at: string
  updated_at: string
  completed_at: string | null
  can_view_detail?: boolean
  can_edit?: boolean
}

export interface CollaborationMember {
  id: number
  user_id: number
  user_name: string
  email: string | null
  role: CollaborationRole
  capability_description?: string
}

export interface CollaborationUser {
  id: number
  user_name: string
  email: string | null
}

export interface CollaborationAgent {
  id: string
  name: string
  agent_id?: string
  team_id?: number
  projectId?: string
  runtime?: 'codex' | 'wegent'
  model?: string | null
  systemPrompt?: string
  capabilityDescription?: string
  status?: 'active' | 'archived'
  visibility?: 'private' | 'creator_admin' | 'public'
  executionEnvironment?: 'local' | 'cloud'
  executionMode?: 'auto' | 'manual_approval'
  executionDeviceId?: string | null
  maxConcurrentExecutions?: number
  workspacePolicy?: 'project' | 'git_worktree'
  version?: number
}

export interface CollaborationAgentInput {
  name: string
  runtime: 'codex' | 'wegent'
  wegentTeamId?: number | null
  model?: string | null
  modelType?: 'public' | 'user' | 'group' | 'runtime' | null
  modelOptions?: Record<string, string>
  systemPrompt?: string
  capabilityDescription?: string
  visibility?: 'private' | 'creator_admin' | 'public'
  executionEnvironment?: 'local' | 'cloud'
  executionMode?: 'auto' | 'manual_approval'
  executionDeviceId?: string | null
  workspaceBinding?: { type: 'standalone' } | null
  maxConcurrentExecutions?: number
  workspacePolicy?: 'project' | 'git_worktree'
  defaultRuntimeProfileId?: string | null
  plugins?: Array<Record<string, unknown>>
}

export interface CollaborationAttachment {
  id: string
  loop_item_id: string
  display_name: string
  content_type: string | null
  size_bytes: number
  created_by_user_id: number
  created_at: string
  markdown_url: string
  markdown?: string | null
}

export interface CollaborationComment {
  id: string
  body: string
  author: string
  web_url: string | null
  created_at: string
  updated_at: string
}

export interface CollaborationFile {
  id: string
  cloud_project_id: CollaborationProjectId
  path: string
  name: string
  kind: 'file' | 'folder'
  content_type: string | null
  size_bytes: number
  description: string
  version: number
  created_at: string
  updated_at: string
}

export interface CollaborationExecution {
  id: number
  loop_item_id: string
  task_title: string
  executor_type: string
  status: string
  display_state: string
  observed_state: string
  sync_state: string
  started_at?: string | null
  completed_at?: string | null
  error_message?: string | null
}

export type CollaborationAutomationRunStatus =
  | 'pending'
  | 'queued'
  | 'waiting_runtime'
  | 'waiting_device'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'skipped'
  | 'cancelled'

export type CollaborationAutomationEventType =
  | 'task.created'
  | 'task.status_changed'
  | 'change_request.checks_failed'
  | 'change_request.merge_conflict'
  | 'change_request.review_submitted'
  | 'change_request.comment_created'
  | 'document.changed'

export type CollaborationEventSourceType = 'github' | 'gitlab' | 'wework' | 'generic'

export type CollaborationEventCollectionMode = 'webhook' | 'poll' | 'internal' | 'hybrid'

export interface CollaborationObservedResource {
  resourceType?: string
  instanceUrl?: string | null
  externalId?: string | null
  path?: string | null
  url?: string | null
  displayName?: string | null
}

export interface CollaborationIncomingHook {
  id: string
  projectId: string
  name: string
  status: 'active' | 'disabled'
  sourceType: CollaborationEventSourceType
  collectionMode: CollaborationEventCollectionMode
  resource: CollaborationObservedResource
  webhookUrl: string | null
  pollIntervalSeconds: number | null
  credentialRef: string | null
  health: Record<string, unknown>
  lastEventAt: string | null
  nextPollAt: string | null
  version: number
  createdAt: string
  updatedAt: string
}

export interface CollaborationIncomingHookInput {
  name: string
  sourceType: CollaborationEventSourceType
  collectionMode: CollaborationEventCollectionMode
  resource: CollaborationObservedResource
  pollIntervalSeconds?: number | null
  credentialRef?: string | null
}

export interface CollaborationAutomationRule {
  id: string
  projectId: string
  name: string
  prompt: string
  triggerType: 'schedule' | 'event' | 'workflow'
  eventType: CollaborationAutomationEventType | null
  eventConfig: Record<string, unknown>
  cronExpression: string | null
  timezone: string
  agentName: string
  enabled: boolean
  nextRunAt: string | null
  lastRunAt: string | null
  lastRunStatus: CollaborationAutomationRunStatus | null
  version: number
  createdAt: string
  updatedAt: string
  assignmentMode: 'manual' | 'ai_managed'
  managerType: 'custom' | 'wegent' | null
  agentId: string | null
  wegentTeamId: number | null
  model: string | null
  executionEnvironment: 'local' | 'cloud' | 'managed'
  executionDeviceId: string | null
  roleSource?: 'generic' | 'agent'
  runtimeSource?: 'agent_default' | 'fixed_profile' | 'issue_creator' | 'runtime_user'
  runtimeProfileId?: string | null
  runtimeUserId?: number | null
}

export interface CollaborationAutomationInput {
  name: string
  prompt: string
  triggerType: 'schedule' | 'event' | 'workflow'
  eventType: CollaborationAutomationEventType | null
  eventConfig: Record<string, unknown>
  cronExpression: string | null
  timezone: string
  enabled: boolean
  assignmentMode: 'manual' | 'ai_managed'
  managerType: 'custom' | 'wegent' | null
  agentId: string | null
  wegentTeamId: number | null
  model: string | null
  executionEnvironment: 'local' | 'cloud' | null
  executionDeviceId: string | null
  roleSource?: 'generic' | 'agent'
  runtimeSource?: 'agent_default' | 'fixed_profile' | 'issue_creator' | 'runtime_user'
  runtimeProfileId?: string | null
  runtimeUserId?: number | null
}

export interface CollaborationAutomationRun {
  id: string
  automationId: string
  projectId: string
  trigger: 'scheduled' | 'manual' | 'event'
  status: CollaborationAutomationRunStatus
  timezone: string
  scheduledFor: string
  expiresAt: string | null
  taskId: string | null
  taskTitle?: string | null
  backendTaskId: number | null
  deviceId: string | null
  error: string | null
  createdAt: string
  updatedAt: string
  completedAt: string | null
  retryable?: boolean
}

export interface CollaborationBoardSnapshot {
  items: CollaborationIssue[]
  members: CollaborationMember[]
  agents: CollaborationAgent[]
}

export interface CollaborationCapabilities {
  cloudProjects: boolean
  localProjects: boolean
  aiAssignment: boolean
  automation: boolean
  terminal: boolean
  dingtalkAitable: boolean
}

export type CollaborationView = 'board' | 'files' | 'members' | 'automation' | 'runs' | 'manage'

export interface CollaborationLocation {
  projectId: string | null
  issueId: string | null
  view: CollaborationView
}

export interface CollaborationHostAdapter {
  capabilities: CollaborationCapabilities
  location: CollaborationLocation
  navigate(location: CollaborationLocation): void
  openExternal?(url: string): void
  notify?(message: string, kind?: 'success' | 'error'): void
  projectActions?: Array<{
    id: string
    label: string
    testId: string
    renderIcon?: () => ReactNode
    invoke(project: CollaborationProject): void
  }>
}
