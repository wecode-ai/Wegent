// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * Canvas API endpoints for document editing.
 */

import apiClient from './client'
import type {
  Canvas,
  CanvasCreateRequest,
  CanvasUpdateRequest,
  CanvasRollbackRequest,
  CanvasVersionsResponse,
} from '@/types/canvas'

const CANVAS_BASE_URL = '/canvas'

/**
 * Create a new canvas document.
 */
export async function createCanvas(request: CanvasCreateRequest): Promise<Canvas> {
  return apiClient.post<Canvas>(`${CANVAS_BASE_URL}/create`, request)
}

/**
 * Get canvas by ID.
 */
export async function getCanvas(canvasId: number): Promise<Canvas> {
  return apiClient.get<Canvas>(`${CANVAS_BASE_URL}/${canvasId}`)
}

/**
 * Update canvas content (user edit).
 */
export async function updateCanvas(canvasId: number, request: CanvasUpdateRequest): Promise<Canvas> {
  return apiClient.put<Canvas>(`${CANVAS_BASE_URL}/${canvasId}`, request)
}

/**
 * Get canvas version history.
 */
export async function getCanvasVersions(canvasId: number): Promise<CanvasVersionsResponse> {
  return apiClient.get<CanvasVersionsResponse>(`${CANVAS_BASE_URL}/${canvasId}/versions`)
}

/**
 * Get a specific canvas version.
 */
export async function getCanvasVersion(canvasId: number, version: number): Promise<Canvas> {
  return apiClient.get<Canvas>(`${CANVAS_BASE_URL}/${canvasId}/versions/${version}`)
}

/**
 * Rollback canvas to a specific version.
 */
export async function rollbackCanvas(canvasId: number, request: CanvasRollbackRequest): Promise<Canvas> {
  return apiClient.post<Canvas>(`${CANVAS_BASE_URL}/${canvasId}/rollback`, request)
}

/**
 * Get canvas by subtask ID.
 */
export async function getCanvasBySubtask(subtaskId: number): Promise<Canvas> {
  return apiClient.get<Canvas>(`${CANVAS_BASE_URL}/subtask/${subtaskId}`)
}

/**
 * Export canvas as file.
 * Returns a download URL.
 */
export function getCanvasExportUrl(canvasId: number, format: 'md' | 'txt' = 'txt'): string {
  return `/api${CANVAS_BASE_URL}/${canvasId}/export?format=${format}`
}
