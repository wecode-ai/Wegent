// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * Canvas feature types
 */

// Artifact types
export type ArtifactType = 'code' | 'text'

export interface ArtifactVersion {
  version: number
  content: string
  created_at: string
}

export interface Artifact {
  id: string
  artifact_type: ArtifactType
  title: string
  content: string
  language?: string
  version: number
  versions: ArtifactVersion[]
}

// SubTask result with artifact
export interface ArtifactResult {
  type: 'artifact'
  artifact: Artifact
}

// Canvas settings stored in TaskResource.json
export interface CanvasSettings {
  enabled: boolean
  current_artifact_subtask_id?: number
  panel_width?: number
}

// Quick action types
export interface QuickAction {
  id: string
  label: string
  icon: string
  description?: string
}

// Canvas state
export interface CanvasState {
  enabled: boolean
  artifact: Artifact | null
  subtaskId: number | null
  isLoading: boolean
  error: string | null
}

// API request/response types
export interface ArtifactUpdateRequest {
  content: string
  title?: string
  language?: string
}

export interface ArtifactRevertRequest {
  version: number
}

// Streaming artifact chunk
export interface ArtifactStreamChunk {
  type: 'artifact'
  artifact: Partial<Artifact> & {
    content_delta?: string
  }
}
