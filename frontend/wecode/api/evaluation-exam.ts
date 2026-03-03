// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * API client functions for the evaluation exam module.
 * These APIs are for exam participants to fetch exam data and submit answers.
 */

import { fetchJson, getRespondentUrl, getEvaluationUrl } from './evaluation-client'
import type {
  ExamTopicExtraData,
  ExamAnswerContent,
  ExamSessionStatus,
} from '@wecode/types/evaluation-exam'
import type { Topic, Question, Answer } from '@wecode/types/evaluation'

/**
 * Response data for exam page initialization
 */
export interface ExamDataResponse {
  /** Topic with exam configuration */
  topic: Omit<Topic, 'extra_data'> & { extra_data: ExamTopicExtraData }
  /** Questions with rich exam content */
  questions: Question[]
  /** User's existing answer if already submitted */
  userAnswer: (Omit<Answer, 'content_data'> & { content_data: ExamAnswerContent }) | null
  /** All answers for all questions (for multi-question exam support) */
  allAnswers?: Record<string, Answer>
  /** Exam session status with timing information */
  session: ExamSessionStatus
}

/**
 * Request body for submitting an exam answer
 */
export interface ExamSubmitRequest {
  /** Selected question ID */
  selectedQuestionId: number
  /** Participant's name */
  participantName: string
  /** Exam answer content with attachments */
  content_data: ExamAnswerContent
}

/**
 * Response data for file upload
 */
export interface ExamUploadResponse {
  /** Unique file key */
  key: string
  /** Display filename */
  filename: string
  /** File size in bytes */
  size: number
}

// ============================================================================
// Exam API
// ============================================================================

/**
 * Fetch exam data for a topic
 * @param topicId - The topic ID
 * @param createSession - If true, creates a new exam session (for "进入考试" action)
 * @returns Exam data including topic, questions, and existing answer
 */
export async function getExamData(
  topicId: number,
  createSession = false
): Promise<ExamDataResponse> {
  const url = getRespondentUrl(`/topics/${topicId}/exam?create_session=${createSession}`)
  return fetchJson<ExamDataResponse>(url)
}

/**
 * Submit an exam answer (multiple submissions allowed)
 * @param topicId - The topic ID
 * @param data - The exam submission data
 * @returns The created/updated answer with submit_count
 */
export async function submitExamAnswer(
  topicId: number,
  data: ExamSubmitRequest
): Promise<Answer & { submit_count: number }> {
  const url = getRespondentUrl(`/topics/${topicId}/exam/submit`)
  return fetchJson<Answer & { submit_count: number }>(url, {
    method: 'POST',
    body: JSON.stringify(data),
  })
}

/**
 * Select a question for the exam session
 * @param topicId - The topic ID
 * @param questionId - The selected question ID
 * @returns Success response
 */
export async function selectExamQuestion(
  topicId: number,
  questionId: number
): Promise<{ success: boolean; selected_question_id: number }> {
  const url = getRespondentUrl(`/topics/${topicId}/exam/select-question`)
  return fetchJson<{ success: boolean; selected_question_id: number }>(url, {
    method: 'POST',
    body: JSON.stringify({ question_id: questionId }),
  })
}

/**
 * Update exam attachments metadata in real-time.
 * This allows incremental updates to attachments without creating a new submission.
 *
 * @param topicId - The topic ID
 * @param data - The attachments update data
 * @returns The updated answer
 */
export async function updateExamAttachments(
  topicId: number,
  data: {
    selectedQuestionId: number
    content_data: {
      attachments?: {
        main?: { key: string; filename: string; size: number; content_type?: string }[]
        interaction?: { key: string; filename: string; size: number; content_type?: string }[]
        bonusAgent?: {
          link?: string
          files: { key: string; filename: string; size: number; content_type?: string }[]
        }
        bonusMultimodal?: { key: string; filename: string; size: number; content_type?: string }[]
      }
      supplementaryNotes?: string
      supplementaryNotesFiles?: {
        key: string
        filename: string
        size: number
        content_type?: string
      }[]
    }
  }
): Promise<Answer> {
  const url = getRespondentUrl(`/topics/${topicId}/exam/attachments`)
  return fetchJson<Answer>(url, {
    method: 'PATCH',
    body: JSON.stringify(data),
  })
}

/**
 * Upload a file for exam attachment
 * @param file - The file to upload
 * @param onProgress - Optional callback for upload progress (not supported with fetch)
 * @returns Upload response with file key and metadata
 */
export async function uploadExamFile(
  file: File,
  onProgress?: (progress: number) => void
): Promise<ExamUploadResponse> {
  const formData = new FormData()
  formData.append('file', file)
  formData.append('file_type', 'exam_attachment')

  // Note: fetchJson doesn't support FormData (sets Content-Type: application/json)
  // We need to use fetch directly for file uploads
  const url = getEvaluationUrl('/shared/upload')

  // Get token for authentication
  const { getToken } = await import('@/apis/user')
  const token = getToken()

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      ...(token && { Authorization: `Bearer ${token}` }),
    },
    body: formData,
  })

  if (!response.ok) {
    const error = await response.json().catch(() => ({ detail: 'Upload failed' }))
    throw new Error(error.detail || 'Upload failed')
  }

  // Simulate progress callback (fetch doesn't support upload progress natively)
  if (onProgress) {
    onProgress(100)
  }

  return response.json()
}

/**
 * Advance exam to the next phase
 * @param topicId - The topic ID
 * @param targetPhase - Target phase to advance to (exam, review, completed)
 * @returns Response with updated session status
 */
export async function advanceExamPhase(
  topicId: number,
  targetPhase: 'exam' | 'review' | 'completed'
): Promise<{
  success: boolean
  previous_phase: string
  current_phase: string
  session: ExamSessionStatus
}> {
  return fetchJson(getRespondentUrl(`/topics/${topicId}/exam/advance-phase`), {
    method: 'POST',
    body: JSON.stringify({ target_phase: targetPhase }),
  })
}
