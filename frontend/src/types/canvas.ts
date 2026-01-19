// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * Canvas document editing types and payload definitions
 */

// ============================================================
// Canvas Data Types
// ============================================================

export type CanvasVersionSource = 'user' | 'ai'

export interface CanvasVersionInfo {
  version: number
  content: string
  timestamp: string
  source: CanvasVersionSource
  old_str?: string
  new_str?: string
  rollback_from?: number
}

export interface Canvas {
  id: number
  subtask_id: number
  filename: string
  content: string
  version: number
  created_at: string
  updated_at: string
}

export interface CanvasBrief {
  id: number
  subtask_id: number
  filename: string
  version: number
  content_preview: string
  created_at: string
  updated_at: string
}

// ============================================================
// Canvas API Request/Response Types
// ============================================================

export interface CanvasCreateRequest {
  subtask_id: number
  filename?: string
  content?: string
}

export interface CanvasUpdateRequest {
  content: string
}

export interface CanvasRollbackRequest {
  version: number
}

export interface CanvasVersionsResponse {
  versions: CanvasVersionInfo[]
}

export interface CanvasUpdateResult {
  success: boolean
  new_content?: string
  version?: number
  diff_info?: {
    old_str: string
    new_str: string
  }
  error?: string
}

// ============================================================
// Canvas WebSocket Payloads
// ============================================================

export interface CanvasCreatePayload {
  task_id: number
  subtask_id: number
  canvas_id: number
  filename: string
  content: string
}

export interface CanvasUpdatePayload {
  task_id: number
  subtask_id: number
  canvas_id: number
  new_content: string
  version: number
  diff_info: {
    old_str: string
    new_str: string
  }
}

export interface CanvasRollbackPayload {
  task_id: number
  subtask_id: number
  canvas_id: number
  version: number
  content: string
}

// ============================================================
// Canvas State Types
// ============================================================

export interface CanvasDiffInfo {
  oldStr: string
  newStr: string
  oldContent: string
  newContent: string
}

export interface CanvasState {
  canvasId: number | null
  filename: string
  content: string
  version: number
  versions: CanvasVersionInfo[]
  isLoading: boolean
  isDiffMode: boolean
  diffInfo: CanvasDiffInfo | null
  error: string | null
}

// Canvas Server Events
export const CanvasServerEvents = {
  CANVAS_CREATE: 'canvas:create',
  CANVAS_UPDATE: 'canvas:update',
  CANVAS_ROLLBACK: 'canvas:rollback',
} as const
