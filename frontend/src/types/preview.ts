// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * Preview feature types for Workbench live preview functionality.
 */

/**
 * Preview service status
 */
export type PreviewStatus = 'disabled' | 'starting' | 'ready' | 'error' | 'stopped'

/**
 * Viewport size options for responsive preview
 */
export type ViewportSize = 'desktop' | 'tablet' | 'mobile'

/**
 * Viewport size dimensions
 */
export const VIEWPORT_SIZES: Record<ViewportSize, { width: string; label: string }> = {
  desktop: { width: '100%', label: 'Desktop' },
  tablet: { width: '768px', label: 'Tablet' },
  mobile: { width: '375px', label: 'Mobile' },
}

/**
 * Preview configuration from .wegent.yaml
 */
export interface PreviewConfigSpec {
  enabled: boolean
  startCommand: string
  port: number
  readyPattern: string
  workingDir?: string
  env?: Record<string, string>
}

/**
 * Response from GET /api/preview/{task_id}/config
 */
export interface PreviewConfigResponse {
  enabled: boolean
  port?: number
  status: PreviewStatus
  url?: string
  start_command?: string
  ready_pattern?: string
  error?: string
}

/**
 * Request for POST /api/preview/{task_id}/start
 */
export interface PreviewStartRequest {
  force?: boolean
}

/**
 * Response from POST /api/preview/{task_id}/start
 */
export interface PreviewStartResponse {
  success: boolean
  message: string
  status: PreviewStatus
  url?: string
}

/**
 * Response from POST /api/preview/{task_id}/stop
 */
export interface PreviewStopResponse {
  success: boolean
  message: string
}

/**
 * WebSocket event for preview state updates
 */
export interface PreviewStateUpdate {
  task_id: number
  status: PreviewStatus
  port?: number
  url?: string
  error?: string
  output?: string
}
