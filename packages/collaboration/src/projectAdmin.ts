// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

export type { ProjectBoardViews } from './project-board/projectBoardViews'

export interface ProjectCollaborationPolicy {
  content: string
  revision?: number
}

export interface ProjectTagChange {
  source: string
  target: string | null
}

export interface ProjectMemberChange {
  operation: 'add' | 'update' | 'remove_direct'
  user_id: number
  permission_role?: 'Maintainer' | 'Developer' | 'Viewer' | null
  capability_description?: string | null
}

export interface ProjectAssistantRosterChange {
  agent_id: string
  agent_version: number
  status?: 'active' | 'archived' | null
  capability_description?: string | null
  wegent_team_id?: number | null
  execution_device_id?: string | null
  default_runtime_profile_id?: string | null
}

export interface ProjectAdminWriteResult {
  projectVersion: number
  revision: number
  before: Record<string, unknown>
  after: Record<string, unknown>
  diff: Array<{ path: string; before: unknown; after: unknown }>
  actor: { userId: number }
  operationId: string
  appliedAt: string | null
  auditId: string | null
  dryRun: boolean
  effectScope?: 'future_issues' | null
  runningIssueSnapshotRule?: 'preserved' | null
}
