// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import type { AnswerSlot, SlotAnswer } from '@wecode/types/evaluation-exam'

/** Permission check states for the exam page */
export type PermissionState = 'checking' | 'granted' | 'denied'

// ============================================================================
// Dynamic Question Data Types
// ============================================================================

/**
 * Dynamic question data structure using SlotAnswer
 * All content (including text inputs like "作答说明") is stored in the answers map
 */
export interface DynamicQuestionData {
  answers: Record<string, SlotAnswer>
}

/** Map of question ID to dynamic question data */
export type DynamicQuestionDataMap = Record<number, DynamicQuestionData>

// ============================================================================
// Factory Functions
// ============================================================================

/** Create empty dynamic question data based on answer slots configuration */
export const createEmptyDynamicQuestionData = (answerSlots: AnswerSlot[]): DynamicQuestionData => {
  const answers: Record<string, SlotAnswer> = {}
  for (const slot of answerSlots) {
    // Initialize based on input mode
    if (slot.inputMode === 'text') {
      answers[slot.key] = { text: '' }
    } else if (slot.inputMode === 'link+attachment') {
      answers[slot.key] = { link: '', files: [] }
    } else {
      answers[slot.key] = { files: [] }
    }
  }
  return { answers }
}

/** Create initial dynamic question data map for all questions */
export const createInitialDynamicQuestionDataMap = (
  questionIds: number[],
  answerSlotsMap: Record<number, AnswerSlot[]>
): DynamicQuestionDataMap => {
  return questionIds.reduce((acc, id) => {
    const slots = answerSlotsMap[id] || []
    acc[id] = createEmptyDynamicQuestionData(slots)
    return acc
  }, {} as DynamicQuestionDataMap)
}

/**
 * Check if a question uses dynamic slots (has answerSlots defined)
 */
export const hasDynamicSlots = (answerSlots: AnswerSlot[] | undefined): boolean => {
  return Array.isArray(answerSlots) && answerSlots.length > 0
}
