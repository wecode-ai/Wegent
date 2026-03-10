// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * API client functions for the evaluation author module.
 * These APIs are specifically for topic creators (authors) to manage their topics.
 */

import { fetchJson, fetchDelete, getAuthorUrl } from './evaluation-client'
import type {
  Topic,
  TopicCreate,
  TopicUpdate,
  TopicVersion,
  TopicStatistics,
  TopicListResponse,
  Question,
  QuestionCreate,
  QuestionUpdate,
  QuestionVersion,
  QuestionListResponse,
  Permission,
  PermissionCreate,
  PermissionListResponse,
  GradingConfig,
  GradingConfigUpdate,
} from '../types/evaluation'

// ============================================================================
// Topic API (Author)
// ============================================================================

export async function listMyTopics(params: {
  page?: number
  limit?: number
  visibility?: string
  status?: number
  search?: string
}): Promise<TopicListResponse> {
  const searchParams = new URLSearchParams()
  if (params.page) searchParams.set('page', params.page.toString())
  if (params.limit) searchParams.set('limit', params.limit.toString())
  if (params.visibility) searchParams.set('visibility', params.visibility)
  if (params.status !== undefined) searchParams.set('status', params.status.toString())
  if (params.search) searchParams.set('search', params.search)

  return fetchJson<TopicListResponse>(getAuthorUrl(`/topics?${searchParams.toString()}`))
}

export async function getAuthorTopic(topicId: number): Promise<Topic> {
  return fetchJson<Topic>(getAuthorUrl(`/topics/${topicId}`))
}

export async function createAuthorTopic(data: TopicCreate): Promise<Topic> {
  return fetchJson<Topic>(getAuthorUrl('/topics'), {
    method: 'POST',
    body: JSON.stringify(data),
  })
}

export async function updateAuthorTopic(topicId: number, data: TopicUpdate): Promise<Topic> {
  return fetchJson<Topic>(getAuthorUrl(`/topics/${topicId}`), {
    method: 'PUT',
    body: JSON.stringify(data),
  })
}

export async function deleteAuthorTopic(topicId: number): Promise<void> {
  await fetchDelete(getAuthorUrl(`/topics/${topicId}`))
}

export async function publishAuthorTopic(topicId: number): Promise<TopicVersion> {
  return fetchJson<TopicVersion>(getAuthorUrl(`/topics/${topicId}/publish`), {
    method: 'POST',
  })
}

export async function getAuthorTopicStatistics(topicId: number): Promise<TopicStatistics> {
  return fetchJson<TopicStatistics>(getAuthorUrl(`/topics/${topicId}/statistics`))
}

export async function listAuthorTopicVersions(
  topicId: number,
  params: {
    page?: number
    limit?: number
  }
): Promise<{ total: number; items: TopicVersion[] }> {
  const searchParams = new URLSearchParams()
  if (params.page) searchParams.set('page', params.page.toString())
  if (params.limit) searchParams.set('limit', params.limit.toString())

  return fetchJson<{ total: number; items: TopicVersion[] }>(
    getAuthorUrl(`/topics/${topicId}/versions?${searchParams.toString()}`)
  )
}

// ============================================================================
// Question API (Author)
// ============================================================================

export async function listAuthorQuestions(
  topicId: number,
  params: {
    page?: number
    limit?: number
    status?: number
  }
): Promise<QuestionListResponse> {
  const searchParams = new URLSearchParams()
  if (params.page) searchParams.set('page', params.page.toString())
  if (params.limit) searchParams.set('limit', params.limit.toString())
  if (params.status !== undefined) searchParams.set('status', params.status.toString())

  return fetchJson<QuestionListResponse>(
    getAuthorUrl(`/topics/${topicId}/questions?${searchParams.toString()}`)
  )
}

export async function getAuthorQuestion(questionId: number): Promise<Question> {
  return fetchJson<Question>(getAuthorUrl(`/questions/${questionId}`))
}

export async function createAuthorQuestion(
  topicId: number,
  data: QuestionCreate
): Promise<Question> {
  return fetchJson<Question>(getAuthorUrl(`/topics/${topicId}/questions`), {
    method: 'POST',
    body: JSON.stringify(data),
  })
}

export async function updateAuthorQuestion(
  questionId: number,
  data: QuestionUpdate
): Promise<Question> {
  return fetchJson<Question>(getAuthorUrl(`/questions/${questionId}`), {
    method: 'PUT',
    body: JSON.stringify(data),
  })
}

export async function deleteAuthorQuestion(questionId: number): Promise<void> {
  await fetchDelete(getAuthorUrl(`/questions/${questionId}`))
}

export async function publishAuthorQuestion(questionId: number): Promise<QuestionVersion> {
  return fetchJson<QuestionVersion>(getAuthorUrl(`/questions/${questionId}/publish`), {
    method: 'POST',
  })
}

export interface QuestionVersionListResponse {
  total: number
  items: QuestionVersion[]
}

export async function listAuthorQuestionVersions(
  questionId: number,
  params: {
    page?: number
    limit?: number
  }
): Promise<QuestionVersionListResponse> {
  const searchParams = new URLSearchParams()
  if (params.page) searchParams.set('page', params.page.toString())
  if (params.limit) searchParams.set('limit', params.limit.toString())

  return fetchJson<QuestionVersionListResponse>(
    getAuthorUrl(`/questions/${questionId}/versions?${searchParams.toString()}`)
  )
}

export async function reorderAuthorQuestions(
  topicId: number,
  questionIds: number[]
): Promise<void> {
  await fetchJson(getAuthorUrl(`/topics/${topicId}/questions/reorder`), {
    method: 'POST',
    body: JSON.stringify(questionIds),
  })
}

// ============================================================================
// Permission API (Author)
// ============================================================================

export async function listAuthorPermissions(
  topicId: number,
  params: {
    page?: number
    limit?: number
    role?: string
  }
): Promise<PermissionListResponse> {
  const searchParams = new URLSearchParams()
  if (params.page) searchParams.set('page', params.page.toString())
  if (params.limit) searchParams.set('limit', params.limit.toString())
  if (params.role) searchParams.set('role', params.role)

  return fetchJson<PermissionListResponse>(
    getAuthorUrl(`/topics/${topicId}/permissions?${searchParams.toString()}`)
  )
}

export async function grantAuthorPermission(
  topicId: number,
  data: PermissionCreate
): Promise<Permission> {
  return fetchJson<Permission>(getAuthorUrl(`/topics/${topicId}/permissions`), {
    method: 'POST',
    body: JSON.stringify(data),
  })
}

export async function revokeAuthorPermission(topicId: number, userId: number): Promise<void> {
  await fetchDelete(getAuthorUrl(`/topics/${topicId}/permissions/${userId}`))
}

export async function batchGrantAuthorPermissions(
  topicId: number,
  userIds: number[],
  role: string
): Promise<{ granted_count: number }> {
  const searchParams = new URLSearchParams()
  searchParams.set('role', role)
  return fetchJson(
    getAuthorUrl(`/topics/${topicId}/permissions/batch?${searchParams.toString()}`),
    {
      method: 'POST',
      body: JSON.stringify(userIds),
    }
  )
}

// ============================================================================
// Grading Configuration API (Author)
// ============================================================================

export async function getAuthorGradingConfig(topicId: number): Promise<GradingConfig> {
  return fetchJson<GradingConfig>(getAuthorUrl(`/topics/${topicId}/grading-config`))
}

export async function updateAuthorGradingConfig(
  topicId: number,
  data: GradingConfigUpdate
): Promise<GradingConfig> {
  return fetchJson<GradingConfig>(getAuthorUrl(`/topics/${topicId}/grading-config`), {
    method: 'PUT',
    body: JSON.stringify(data),
  })
}

// ============================================================================
// Topic Rollback API (Author)
// ============================================================================

export async function rollbackAuthorTopic(topicId: number, version: string): Promise<Topic> {
  const searchParams = new URLSearchParams()
  searchParams.set('version', version)
  return fetchJson<Topic>(getAuthorUrl(`/topics/${topicId}/rollback?${searchParams.toString()}`), {
    method: 'POST',
  })
}

// ============================================================================
// Graders List API (Author)
// ============================================================================

export async function listAuthorGraders(
  topicId: number,
  params: {
    page?: number
    limit?: number
  }
): Promise<PermissionListResponse> {
  const searchParams = new URLSearchParams()
  if (params.page) searchParams.set('page', params.page.toString())
  if (params.limit) searchParams.set('limit', params.limit.toString())

  return fetchJson<PermissionListResponse>(
    getAuthorUrl(`/topics/${topicId}/graders?${searchParams.toString()}`)
  )
}

// ============================================================================
// Exam Session API (Author)
// ============================================================================

export interface ExamSession {
  user_id: number
  user_name?: string
  user_email?: string
  current_phase: 'intro' | 'exam' | 'review' | 'completed'
  started_at: string | null
  selected_question_id: number | null
  remaining_seconds: number
  is_overtime: boolean
  exam_duration_seconds: number | null
}

export interface ExamTopicInfo {
  id: number
  name: string
  description?: string
  exam_mode: boolean
  intro_duration_minutes: number
  exam_duration_minutes: number
  review_duration_minutes: number
}

export interface ExamSessionListResponse {
  topic: ExamTopicInfo
  sessions: ExamSession[]
  total: number
}

export async function getTopicExamSessions(
  topicId: number,
  params: {
    page?: number
    limit?: number
    phase?: string
  }
): Promise<ExamSessionListResponse> {
  const searchParams = new URLSearchParams()
  if (params.page) searchParams.set('page', params.page.toString())
  if (params.limit) searchParams.set('limit', params.limit.toString())
  if (params.phase) searchParams.set('phase', params.phase)

  return fetchJson<ExamSessionListResponse>(
    getAuthorUrl(`/topics/${topicId}/exam-sessions?${searchParams.toString()}`)
  )
}

export async function resetUserExamSession(
  topicId: number,
  userId: number
): Promise<{ success: boolean; message: string }> {
  return fetchJson<{ success: boolean; message: string }>(
    getAuthorUrl(`/topics/${topicId}/exam-sessions/${userId}/reset`),
    {
      method: 'POST',
    }
  )
}

export async function updateUserExamSessionPhase(
  topicId: number,
  userId: number,
  targetPhase: 'intro' | 'exam' | 'review' | 'completed',
  force?: boolean
): Promise<{
  success: boolean
  message: string
  previous_phase: string
  current_phase: string
  user_id: number
}> {
  return fetchJson<{
    success: boolean
    message: string
    previous_phase: string
    current_phase: string
    user_id: number
  }>(getAuthorUrl(`/topics/${topicId}/exam-sessions/${userId}/update-phase`), {
    method: 'POST',
    body: JSON.stringify({ target_phase: targetPhase, force }),
  })
}

export async function forceEndExamSession(
  topicId: number,
  userId: number
): Promise<{
  success: boolean
  message: string
  previous_phase: string
  current_phase: string
  user_id: number
}> {
  return fetchJson<{
    success: boolean
    message: string
    previous_phase: string
    current_phase: string
    user_id: number
  }>(getAuthorUrl(`/topics/${topicId}/exam-sessions/${userId}/force-end`), {
    method: 'POST',
  })
}

// ============================================================================
// Exam Session Detail API (Author)
// ============================================================================

export interface ExamSessionDetailQuestion {
  id: number
  title: string
  content_type: string
  content_data: Record<string, unknown>
  order_index: number
  answer: {
    id: number
    content_type: string
    content_data: Record<string, unknown>
    submitted_at: string
    question_version: string
  } | null
}

export interface ExamSessionDetail {
  session: ExamSession & {
    completed_at: string | null
    is_active: boolean
    phase: 'intro' | 'exam' | 'review' | 'completed'
    started_at: string
    intro_end_at: string
    exam_end_at: string
    review_end_at: string
  }
  topic: {
    id: number
    name: string
    description?: string
  }
  questions: ExamSessionDetailQuestion[]
  session_all_answers: Record<string, unknown>
}

export async function getExamSessionDetail(
  topicId: number,
  userId: number
): Promise<ExamSessionDetail> {
  return fetchJson<ExamSessionDetail>(
    getAuthorUrl(`/topics/${topicId}/exam-sessions/${userId}/detail`)
  )
}
