// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * Canvas feature types
 *
 * Storage model: Artifacts are stored in TaskResource.json["canvas"] with
 * diff-based version history for ~75% storage reduction.
 */

// Artifact types
export type ArtifactType = 'code' | 'text'

/**
 * Version entry in history (diff-based storage)
 *
 * Note: `diff` is null for the initial version, and contains unified diff
 * for subsequent versions. Content is reconstructed by applying diffs.
 */
export interface ArtifactVersion {
  version: number
  diff: string | null // null for initial version, unified diff for updates
  created_at: string
}

/**
 * Main artifact model (current state)
 *
 * Note: `versions` is populated from history when fetching from API.
 * For backward compatibility, `versions` may also contain `content` field
 * for older data, but new data uses diff-based storage.
 */
export interface Artifact {
  id: string
  artifact_type: ArtifactType
  title: string
  content: string // Current content only
  language?: string
  version: number
  versions: ArtifactVersion[] // Version history with diffs
}

// SubTask result with artifact
export interface ArtifactResult {
  type: 'artifact'
  artifact: Artifact
}

// Canvas data stored in TaskResource.json["canvas"]
export interface CanvasData {
  enabled: boolean
  artifact: Artifact | null
  history: ArtifactVersion[]
  auto_open?: boolean
}

// Canvas settings (subset of CanvasData for API)
export interface CanvasSettings {
  enabled: boolean
  auto_open?: boolean
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
  isLoading: boolean
  error: string | null
}

// API request/response types
export interface ArtifactUpdateRequest {
  content: string
  title?: string
  create_version?: boolean // Whether to create a new version (default: true)
}

export interface ArtifactRevertRequest {
  version: number
}

// API response for artifact
export interface ArtifactResponse {
  artifact: Artifact
  task_id: number
}

// API response for version content
export interface VersionContentResponse {
  version: number
  content: string
}

// Streaming artifact chunk
export interface ArtifactStreamChunk {
  type: 'artifact'
  artifact: Partial<Artifact> & {
    content_delta?: string
  }
}
