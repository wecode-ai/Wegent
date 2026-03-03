// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { uploadTextAsFile } from '@wecode/api/evaluation-shared'
import type { ExamAttachment } from '@wecode/types/evaluation-exam'
import type { QuestionDataMap, QuestionData } from './ai-assessment-types'

/**
 * Generate a unique filename for supplementary notes
 */
export function generateSupplementaryNotesFilename(): string {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  const randomStr = Math.random().toString(36).substring(2, 6)
  return `作答说明_${timestamp}_${randomStr}.txt`
}

/**
 * Upload supplementary notes text as a file
 */
export async function uploadSupplementaryNotes(
  notes: string,
  topicId: number,
  questionId: number
): Promise<ExamAttachment | null> {
  if (!notes.trim()) return null

  const filename = generateSupplementaryNotesFilename()
  const response = await uploadTextAsFile(
    notes,
    filename,
    'exam_attachment',
    topicId,
    questionId,
    'supplementaryNotes'
  )

  return {
    key: response.key,
    filename: response.filename,
    size: response.file_size,
    content_type: response.content_type,
  }
}

/**
 * Extract attachments from answer content data
 */
export function extractAttachmentsFromContent(content: {
  attachments?: Record<string, unknown>
}): QuestionData['attachments'] {
  const attachments = content.attachments || {}

  return {
    main: (attachments.main as ExamAttachment[]) || [],
    interaction: (attachments.interaction as ExamAttachment[]) || [],
    bonusAgent:
      (attachments.bonusAgent as { files?: ExamAttachment[] })?.files || [],
    bonusMultimodal: (attachments.bonusMultimodal as ExamAttachment[]) || [],
  }
}

/**
 * Extract link values from answer content data
 */
export function extractLinkValuesFromContent(content: {
  attachments?: Record<string, unknown>
}): Record<string, string> {
  const attachments = content.attachments || {}

  return {
    bonusAgent: (attachments.bonusAgent as { link?: string })?.link || '',
  }
}

/**
 * Parse answer data from API response into question data format
 */
export function parseAnswerData(answerData: {
  content_data?: {
    selectedTopicId?: number
    supplementaryNotes?: string
    attachments?: Record<string, unknown>
    supplementaryNotesFiles?: ExamAttachment[]
  }
}): Partial<QuestionData> | null {
  const content = answerData.content_data
  if (!content || !content.selectedTopicId) return null

  return {
    attachments: extractAttachmentsFromContent(content),
    supplementaryNotesFiles: content.supplementaryNotesFiles || [],
    supplementaryNotes: content.supplementaryNotes || '',
    linkValues: extractLinkValuesFromContent(content),
  }
}

/**
 * Build question data map from all answers
 */
export function buildQuestionDataMapFromAnswers(
  allAnswers: Record<string, { content_data?: { selectedTopicId?: number; supplementaryNotes?: string; attachments?: Record<string, unknown>; supplementaryNotesFiles?: ExamAttachment[] } }>
): QuestionDataMap {
  const result: QuestionDataMap = {}

  Object.entries(allAnswers).forEach(([questionIdStr, answerData]) => {
    const questionId = parseInt(questionIdStr, 10)
    const parsed = parseAnswerData(answerData)

    if (parsed) {
      result[questionId] = {
        attachments: parsed.attachments || {
          main: [],
          interaction: [],
          bonusAgent: [],
          bonusMultimodal: [],
        },
        supplementaryNotesFiles: parsed.supplementaryNotesFiles || [],
        supplementaryNotes: parsed.supplementaryNotes || '',
        linkValues: parsed.linkValues || { bonusAgent: '' },
      }
    }
  })

  return result
}

/**
 * Calculate total file count for a question
 */
export function getTotalFileCount(
  questionData: QuestionDataMap,
  questionId: number
): number {
  const data = questionData[questionId]
  if (!data) return 0

  const slotFiles = Object.values(data.attachments).reduce(
    (sum, arr) => sum + arr.length,
    0
  )
  const supplementaryFiles = data.supplementaryNotesFiles?.length || 0
  return slotFiles + supplementaryFiles
}

/**
 * Check if question has required files (main + interaction)
 */
export function hasRequiredFiles(data: QuestionData | undefined | null): boolean {
  if (!data) return false
  return (
    data.attachments.interaction.length > 0 &&
    data.attachments.main.length > 0
  )
}

/**
 * Check if question has supplementary notes
 */
export function hasSupplementaryNotes(data: QuestionData | undefined | null): boolean {
  if (!data) return false
  return (
    data.supplementaryNotes.trim().length > 0 ||
    (data.supplementaryNotesFiles?.length ?? 0) > 0
  )
}

/**
 * Get timer color class based on remaining time
 */
export function getTimerColorClass(
  timeLeft: number,
  isOvertime: boolean
): string {
  if (isOvertime) return 'text-red-600 bg-red-50 border-red-200'
  if (timeLeft > 15 * 60) return 'text-emerald-600 bg-emerald-50 border-emerald-200'
  if (timeLeft > 5 * 60) return 'text-yellow-600 bg-yellow-50 border-yellow-200'
  return 'text-red-600 bg-red-50 border-red-200'
}
