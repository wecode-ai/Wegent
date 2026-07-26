// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

export type KnowledgeArtifactType = 'briefing' | 'mind_map'
export type KnowledgeArtifactStatus = 'queued' | 'running' | 'succeeded' | 'failed'
export type KnowledgeArtifactExecutionHealth = 'healthy' | 'stalled'

export interface KnowledgeArtifact {
  schema_version: number
  version: number
  attempt: number
  artifact_id: string
  knowledge_base_id: number
  artifact_type: KnowledgeArtifactType
  title: string
  status: KnowledgeArtifactStatus
  task_id: number | null
  assistant_subtask_id: number | null
  content: string | null
  source_document_ids: number[]
  generation_config: {
    instruction?: string | null
  }
  error_code: string | null
  error_message: string | null
  execution_health: KnowledgeArtifactExecutionHealth
  can_retry: boolean
  user_id: number
  created_at: string
  updated_at: string
  completed_at: string | null
}

export interface KnowledgeArtifactListResponse {
  items: KnowledgeArtifact[]
  can_manage: boolean
  available_document_count: number
}

export interface KnowledgeArtifactCreate {
  artifact_type: KnowledgeArtifactType
  title?: string
  document_ids: number[]
  instruction?: string
}
