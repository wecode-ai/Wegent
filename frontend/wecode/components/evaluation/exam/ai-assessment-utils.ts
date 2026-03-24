// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import type { ExamAttachment, SlotAnswer, AnswerSlot } from '@wecode/types/evaluation-exam'
import type { DynamicQuestionData, DynamicQuestionDataMap } from './ai-assessment-types'

/**
 * Extract attachments from answer content data
 */
export function extractAttachmentsFromContent(
  content: {
    attachments?: Record<string, unknown>
    answers?: Record<string, SlotAnswer>
  },
  answerSlots: AnswerSlot[]
): Record<string, SlotAnswer> {
  // If content has the new answers format, use it directly
  if (content.answers && typeof content.answers === 'object') {
    return content.answers as Record<string, SlotAnswer>
  }

  // Otherwise, convert from attachments format
  const attachments = content.attachments || {}
  const result: Record<string, SlotAnswer> = {}

  for (const slot of answerSlots) {
    const slotData = attachments[slot.key]

    if (slotData && typeof slotData === 'object') {
      // Check if it's an object format with files/text/link
      if (
        'files' in (slotData as Record<string, unknown>) ||
        'text' in (slotData as Record<string, unknown>) ||
        'link' in (slotData as Record<string, unknown>)
      ) {
        const typedSlot = slotData as { files?: ExamAttachment[]; text?: string; link?: string }
        result[slot.key] = {
          files: typedSlot.files || [],
          text: typedSlot.text,
          link: typedSlot.link,
        }
      } else if (Array.isArray(slotData)) {
        // It's a simple array of files
        result[slot.key] = {
          files: slotData as ExamAttachment[],
        }
      }
    } else {
      // Initialize with empty value based on slot input mode
      if (slot.inputMode === 'text') {
        result[slot.key] = { text: '' }
      } else if (slot.inputMode === 'link+attachment') {
        result[slot.key] = { link: '', files: [] }
      } else {
        result[slot.key] = { files: [] }
      }
    }
  }

  return result
}

/**
 * Extract text values from dynamic answer content
 */
export function extractTextValuesFromContent(
  answers: Record<string, SlotAnswer>
): Record<string, string> {
  const result: Record<string, string> = {}

  for (const [key, answer] of Object.entries(answers)) {
    if (answer.text) {
      result[key] = answer.text
    }
  }

  return result
}

/**
 * Parse answer data from API response into dynamic question data format
 */
export function parseDynamicAnswerData(
  answerData: {
    content_data?: {
      selectedTopicId?: number
      attachments?: Record<string, unknown>
      answers?: Record<string, SlotAnswer>
    }
  },
  answerSlots: AnswerSlot[]
): Partial<DynamicQuestionData> | null {
  const content = answerData.content_data
  if (!content || !content.selectedTopicId) return null

  return {
    answers: extractAttachmentsFromContent(content, answerSlots),
  }
}

/**
 * Build dynamic question data map from all answers
 */
export function buildDynamicQuestionDataMapFromAnswers(
  allAnswers: Record<
    string,
    {
      content_data?: {
        selectedTopicId?: number
        attachments?: Record<string, unknown>
        answers?: Record<string, SlotAnswer>
      }
    }
  >,
  answerSlotsMap: Record<number, AnswerSlot[]>
): DynamicQuestionDataMap {
  const result: DynamicQuestionDataMap = {}

  Object.entries(allAnswers).forEach(([questionIdStr, answerData]) => {
    const questionId = parseInt(questionIdStr, 10)
    const slots = answerSlotsMap[questionId] || []
    const parsed = parseDynamicAnswerData(answerData, slots)

    if (parsed) {
      // Initialize with empty slots
      const answers: Record<string, SlotAnswer> = {}
      for (const slot of slots) {
        if (slot.inputMode === 'text') {
          answers[slot.key] = { text: '' }
        } else if (slot.inputMode === 'link+attachment') {
          answers[slot.key] = { link: '', files: [] }
        } else {
          answers[slot.key] = { files: [] }
        }
      }

      result[questionId] = {
        answers: { ...answers, ...parsed.answers },
      }
    }
  })

  return result
}

/**
 * Calculate total file count for dynamic question data
 */
export function getDynamicTotalFileCount(answers: Record<string, SlotAnswer>): number {
  return Object.values(answers).reduce((sum, answer) => {
    return sum + (answer.files?.length || 0)
  }, 0)
}

/**
 * Check if dynamic question has required files based on slot configuration
 */
export function hasDynamicRequiredFiles(
  answers: Record<string, SlotAnswer>,
  answerSlots: AnswerSlot[]
): boolean {
  for (const slot of answerSlots) {
    if (slot.required && !slot.isBonus) {
      const answer = answers[slot.key]
      const hasContent =
        (answer?.files && answer.files.length > 0) ||
        (answer?.text && answer.text.trim() !== '') ||
        (answer?.link && answer.link.trim() !== '')
      if (!hasContent) {
        return false
      }
    }
  }
  return true
}

/**
 * Get timer color class based on remaining time
 */
export function getTimerColorClass(timeLeft: number, isOvertime: boolean): string {
  if (isOvertime) return 'text-red-600 bg-red-50 border-red-200'
  if (timeLeft > 15 * 60) return 'text-emerald-600 bg-emerald-50 border-emerald-200'
  if (timeLeft > 5 * 60) return 'text-yellow-600 bg-yellow-50 border-yellow-200'
  return 'text-red-600 bg-red-50 border-red-200'
}
