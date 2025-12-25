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
}

/**
 * Correction mode state stored in localStorage
 */
export interface CorrectionModeState {
  enabled: boolean
  correctionModelId: string | null
  correctionModelName: string | null
}

// LocalStorage key for correction mode state
const CORRECTION_MODE_KEY = 'wegent_correction_mode'

/**
 * Correction APIs
 */
export const correctionApis = {
  /**
   * Correct an AI response using the specified correction model
   */
  async correctResponse(request: CorrectionRequest): Promise<CorrectionResponse> {
    return apiClient.post('/chat/correct', request)
  },

  /**
   * Get correction mode state from localStorage
   */
  getCorrectionModeState(): CorrectionModeState {
    if (typeof window === 'undefined') {
      return { enabled: false, correctionModelId: null, correctionModelName: null }
    }
    try {
      const stored = localStorage.getItem(CORRECTION_MODE_KEY)
      if (stored) {
        return JSON.parse(stored)
      }
    } catch (e) {
      console.error('Failed to parse correction mode state:', e)
    }
    return { enabled: false, correctionModelId: null, correctionModelName: null }
  },

  /**
   * Save correction mode state to localStorage
   */
  saveCorrectionModeState(state: CorrectionModeState): void {
    if (typeof window === 'undefined') return
    try {
      localStorage.setItem(CORRECTION_MODE_KEY, JSON.stringify(state))
    } catch (e) {
      console.error('Failed to save correction mode state:', e)
    }
  },

  /**
   * Clear correction mode state from localStorage
   */
  clearCorrectionModeState(): void {
    if (typeof window === 'undefined') return
    try {
      localStorage.removeItem(CORRECTION_MODE_KEY)
    } catch (e) {
      console.error('Failed to clear correction mode state:', e)
    }
  },
}
