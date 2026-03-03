// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import type { ExamAttachment } from '@wecode/types/evaluation-exam'

/** Permission check states for the exam page */
export type PermissionState = 'checking' | 'granted' | 'denied'

/** Question data structure for per-question state */
export interface QuestionData {
  attachments: Record<string, ExamAttachment[]>
  supplementaryNotes: string
  supplementaryNotesFiles: ExamAttachment[]
  linkValues: Record<string, string>
}

/** Map of question ID to question data */
export type QuestionDataMap = Record<number, QuestionData>

/** Initial empty question data structure */
export const createEmptyQuestionData = (): QuestionData => ({
  attachments: { main: [], interaction: [], bonusAgent: [], bonusMultimodal: [] },
  supplementaryNotes: '',
  supplementaryNotesFiles: [],
  linkValues: { bonusAgent: '' },
})

/** Create initial question data map for all questions */
export const createInitialQuestionDataMap = (questionIds: number[]): QuestionDataMap => {
  return questionIds.reduce((acc, id) => {
    acc[id] = createEmptyQuestionData()
    return acc
  }, {} as QuestionDataMap)
}
