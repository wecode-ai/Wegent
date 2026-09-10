// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import type { ReactNode } from 'react'

export type CollaborationProjectId = string

export type CollaborationRole = 'Owner' | 'Maintainer' | 'Developer' | 'Reporter'

export type CollaborationPriority = 'none' | 'low' | 'medium' | 'high' | 'urgent'

export interface CollaborationStatus {
  id: string
  name: string
  color: 'gray' | 'blue' | 'orange' | 'purple' | 'green' | 'red'
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
