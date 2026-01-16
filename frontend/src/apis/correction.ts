// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { apiClient } from './client'

/**
 * Correction scores for the AI response evaluation
 */
export interface CorrectionScores {
  accuracy: number
  logic: number
  completeness: number
}

/**
 * A single correction item with issue and suggestion
 */
export interface CorrectionItem {
  issue: string
  suggestion: string
}

/**
 * Request body for AI correction
 */
export interface CorrectionRequest {
  task_id: number
  message_id: number
  original_question: string
  original_answer: string
  correction_model_id: string
  force_retry?: boolean // Force re-evaluation even if correction exists
  enable_web_search?: boolean // Enable web search tool for fact verification
}

/**
 * Response body for AI correction
 */
export interface CorrectionResponse {
  message_id: number
  scores: CorrectionScores
  corrections: CorrectionItem[]
  summary: string
  improved_answer: string
  is_correct: boolean
  applied?: boolean // Whether the correction has been applied to the original message
}

/**
 * Correction data stored in subtask.result.correction (persisted)
 */
export interface CorrectionData {
  model_id: string
  model_name?: string
  scores: CorrectionScores
  corrections: CorrectionItem[]
  summary: string
  improved_answer: string
  is_correct: boolean
  corrected_at?: string
  applied?: boolean // Whether the correction has been applied to the original message
  applied_at?: string // Timestamp when the correction was applied
  original_value?: string // Original message content before correction was applied
}
/**
 * Correction mode state stored in localStorage
 */
export interface CorrectionModeState {
  enabled: boolean
  correctionModelId: string | null
  correctionModelName: string | null
  enableWebSearch?: boolean // Enable web search for fact verification
}

// LocalStorage key prefix for correction mode state (per-task)
const CORRECTION_MODE_KEY_PREFIX = 'wegent_correction_mode_task_'

/**
 * Get the localStorage key for a specific task's correction mode state
 */
function getCorrectionModeKey(taskId: number | null): string {
  if (taskId === null) {
    return `${CORRECTION_MODE_KEY_PREFIX}new`
  }
  return `${CORRECTION_MODE_KEY_PREFIX}${taskId}`
}

/**
 * Extract correction data from subtask.result
 * Returns null if no correction data exists
 */
export function extractCorrectionFromResult(
  result: Record<string, unknown> | null | undefined
): CorrectionData | null {
  if (!result || typeof result !== 'object') return null
  const correction = result.correction as CorrectionData | undefined
  if (!correction) return null
  return correction
}

/**
 * Convert persisted CorrectionData to CorrectionResponse format
 */
export function correctionDataToResponse(
  data: CorrectionData,
  messageId: number
): CorrectionResponse {
  return {
    message_id: messageId,
    scores: data.scores,
    corrections: data.corrections,
    summary: data.summary,
    improved_answer: data.improved_answer,
    is_correct: data.is_correct,
    applied: data.applied,
  }
}

/**
 * Correction APIs
 */
export const correctionApis = {
  /**
   * Correct an AI response using the specified correction model.
   * The result is automatically persisted to subtask.result.correction.
   * If a correction already exists and force_retry is false, returns the cached result.
   * Set force_retry to true to force re-evaluation.
   */
  async correctResponse(request: CorrectionRequest): Promise<CorrectionResponse> {
    return apiClient.post('/chat/correct', request)
  },

  /**
   * Delete correction data from a subtask.
   * This allows re-running correction with a different model.
   */
  async deleteCorrection(subtaskId: number): Promise<{ message: string }> {
    return apiClient.delete(`/chat/subtasks/${subtaskId}/correction`)
  },

  /**
   * Apply the improved answer from correction to replace the AI message content.
   * This updates subtask.result.value with the improved answer.
   */
  async applyCorrection(
    subtaskId: number,
    improvedAnswer: string
  ): Promise<{ message: string; subtask_id: number }> {
    return apiClient.post(`/chat/subtasks/${subtaskId}/apply-correction`, {
      improved_answer: improvedAnswer,
    })
  },

  /**
   * Get correction mode state from localStorage for a specific task
   * @param taskId - The task ID, or null for new tasks
   */
  getCorrectionModeState(taskId: number | null): CorrectionModeState {
    if (typeof window === 'undefined') {
      return {
        enabled: false,
        correctionModelId: null,
        correctionModelName: null,
        enableWebSearch: false,
      }
    }
    try {
      const key = getCorrectionModeKey(taskId)
      const stored = localStorage.getItem(key)
      if (stored) {
        const parsed = JSON.parse(stored)
        // Ensure new fields have default values for backward compatibility
        return {
          enabled: parsed.enabled ?? false,
          correctionModelId: parsed.correctionModelId ?? null,
          correctionModelName: parsed.correctionModelName ?? null,
          enableWebSearch: parsed.enableWebSearch ?? false,
        }
      }
    } catch (e) {
      console.error('Failed to parse correction mode state:', e)
    }
    return {
      enabled: false,
      correctionModelId: null,
      correctionModelName: null,
      enableWebSearch: false,
    }
  },

  /**
   * Save correction mode state to localStorage for a specific task
   * @param taskId - The task ID, or null for new tasks
   * @param state - The correction mode state to save
   */
  saveCorrectionModeState(taskId: number | null, state: CorrectionModeState): void {
    if (typeof window === 'undefined') return
    try {
      const key = getCorrectionModeKey(taskId)
      localStorage.setItem(key, JSON.stringify(state))
    } catch (e) {
      console.error('Failed to save correction mode state:', e)
    }
  },

  /**
   * Clear correction mode state from localStorage for a specific task
   * @param taskId - The task ID, or null for new tasks
   */
  clearCorrectionModeState(taskId: number | null): void {
    if (typeof window === 'undefined') return
    try {
      const key = getCorrectionModeKey(taskId)
      localStorage.removeItem(key)
    } catch (e) {
      console.error('Failed to clear correction mode state:', e)
    }
  },

  /**
   * Migrate correction mode state from one task to another.
   * This is used when a new task is created and we need to transfer
   * the correction mode state from the "new" task to the real task ID.
   * @param fromTaskId - The source task ID (null for new tasks)
   * @param toTaskId - The destination task ID
   * @returns The migrated state, or null if no state was found
   */
  migrateCorrectionModeState(
    fromTaskId: number | null,
    toTaskId: number
  ): CorrectionModeState | null {
    if (typeof window === 'undefined') return null
    try {
      const fromKey = getCorrectionModeKey(fromTaskId)
      const stored = localStorage.getItem(fromKey)
      if (stored) {
        const state = JSON.parse(stored) as CorrectionModeState
        // Save to new task ID
        const toKey = getCorrectionModeKey(toTaskId)
        localStorage.setItem(toKey, stored)
        // Remove from old key
        localStorage.removeItem(fromKey)
        return state
      }
    } catch (e) {
      console.error('Failed to migrate correction mode state:', e)
    }
    return null
  },
}
