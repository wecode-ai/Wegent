// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { apiClient } from './client';

/**
 * Correction scores for the AI response evaluation
 */
export interface CorrectionScores {
  accuracy: number;
  logic: number;
  completeness: number;
}

/**
 * A single correction item with issue and suggestion
 */
export interface CorrectionItem {
  issue: string;
  suggestion: string;
}

/**
 * Request body for AI correction
 */
export interface CorrectionRequest {
  task_id: number;
  message_id: number;
  original_question: string;
  original_answer: string;
  correction_model_id: string;
}

/**
 * Response body for AI correction
 */
export interface CorrectionResponse {
  message_id: number;
  scores: CorrectionScores;
  corrections: CorrectionItem[];
  summary: string;
  improved_answer: string;
  is_correct: boolean;
}

/**
 * Correction data stored in subtask.result.correction (persisted)
 */
export interface CorrectionData {
  model_id: string;
  model_name?: string;
  scores: CorrectionScores;
  corrections: CorrectionItem[];
  summary: string;
  improved_answer: string;
  is_correct: boolean;
  corrected_at?: string;
}

/**
 * Correction mode state stored in localStorage
 */
export interface CorrectionModeState {
  enabled: boolean;
  correctionModelId: string | null;
  correctionModelName: string | null;
}

// LocalStorage key for correction mode state
const CORRECTION_MODE_KEY = 'wegent_correction_mode';

/**
 * Extract correction data from subtask.result
 * Returns null if no correction data exists
 */
export function extractCorrectionFromResult(
  result: Record<string, unknown> | null | undefined
): CorrectionData | null {
  if (!result || typeof result !== 'object') return null;
  const correction = result.correction as CorrectionData | undefined;
  if (!correction) return null;
  return correction;
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
  };
}

/**
 * Correction APIs
 */
export const correctionApis = {
  /**
   * Correct an AI response using the specified correction model.
   * The result is automatically persisted to subtask.result.correction.
   * If a correction already exists, returns the cached result.
   */
  async correctResponse(request: CorrectionRequest): Promise<CorrectionResponse> {
    return apiClient.post('/chat/correct', request);
  },

  /**
   * Delete correction data from a subtask.
   * This allows re-running correction with a different model.
   */
  async deleteCorrection(subtaskId: number): Promise<{ message: string }> {
    return apiClient.delete(`/chat/subtasks/${subtaskId}/correction`);
  },

  /**
   * Get correction mode state from localStorage
   */
  getCorrectionModeState(): CorrectionModeState {
    if (typeof window === 'undefined') {
      return { enabled: false, correctionModelId: null, correctionModelName: null };
    }
    try {
      const stored = localStorage.getItem(CORRECTION_MODE_KEY);
      if (stored) {
        return JSON.parse(stored);
      }
    } catch (e) {
      console.error('Failed to parse correction mode state:', e);
    }
    return { enabled: false, correctionModelId: null, correctionModelName: null };
  },

  /**
   * Save correction mode state to localStorage
   */
  saveCorrectionModeState(state: CorrectionModeState): void {
    if (typeof window === 'undefined') return;
    try {
      localStorage.setItem(CORRECTION_MODE_KEY, JSON.stringify(state));
    } catch (e) {
      console.error('Failed to save correction mode state:', e);
    }
  },

  /**
   * Clear correction mode state from localStorage
   */
  clearCorrectionModeState(): void {
    if (typeof window === 'undefined') return;
    try {
      localStorage.removeItem(CORRECTION_MODE_KEY);
    } catch (e) {
      console.error('Failed to clear correction mode state:', e);
    }
  },
};
