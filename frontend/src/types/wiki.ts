// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

export interface WikiProject {
  id: number
  project_name: string
  project_type: string
  source_type: string
  source_url: string
  source_id: string
  source_domain: string
  description: string | null
  ext: Record<string, unknown> | null
  is_active: boolean
  created_at: string
  updated_at: string
}

export interface WikiProjectsResponse {
  total: number
  items: WikiProject[]
}

export interface WikiSourceSnapshot {
  url: string | null
  path: string | null
  type: string
  version: string | null
  commit_id: string
  file_count: number | null
  branch_name: string
  commit_time: string
  commit_author: string | null
  snapshot_time: string | null
  commit_message: string | null
}

export interface WikiContentWriteSummary {
  model: string
  status: string
  tokens_used: number
  structure_order: string[]
  error_message?: string
}

export interface WikiContentWrite {
  model: string
  summary: WikiContentWriteSummary
  auth_token: string
  tokens_used: number
  generation_id: number
  last_write_at: string
  content_server?: string
  total_sections: number
  created_sections: number
  updated_sections: number
  last_write_titles: string[]
  status_after_write: string
  status_before_write: string
  content_endpoint_url?: string
  content_endpoint_path?: string
  default_section_types: string[]
}

export interface WikiGenerationExt {
  content_write: WikiContentWrite
}

export interface WikiGeneration {
  id: number
  project_id: number
  user_id: number
  task_id: number
  team_id: number
  generation_type: string
  source_snapshot: WikiSourceSnapshot
  status: string
  ext: WikiGenerationExt | Record<string, never>
  created_at: string
  updated_at: string
  completed_at: string | null
}

export interface WikiGenerationsResponse {
  total: number
  items: WikiGeneration[]
}

export interface WikiContentExt {
  version: string
  authored_by: string
}

export interface WikiContent {
  id: number
  generation_id: number
  type: string
  title: string
  content: string
  parent_id: number | null
  ext: WikiContentExt
  created_at: string
  updated_at: string
}

export interface WikiGenerationDetail extends WikiGeneration {
  project: WikiProject
  contents: WikiContent[]
}

export interface WikiGenerationCreate {
  project_name: string
  source_url: string
  source_id: string | null
  source_domain: string | null
  project_type: string
  source_type: string
  generation_type: string
  language?: string
  source_snapshot: WikiSourceSnapshot
  team_id: number
  ext: Record<string, unknown>
}
