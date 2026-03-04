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
  GradingTask,
  GradingTaskExecuteRequest,
  GradingTaskPublishRequest,
  GradingTaskUpdateReportRequest,
  GradingTaskListResponse,
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
// Grading Task API (Author)
// ============================================================================

export async function listAuthorGradingTasks(
  topicId: number,
  params: {
    page?: number
    limit?: number
    status?: number
    respondent_id?: number
  }
): Promise<GradingTaskListResponse> {
  const searchParams = new URLSearchParams()
  if (params.page) searchParams.set('page', params.page.toString())
  if (params.limit) searchParams.set('limit', params.limit.toString())
  if (params.status !== undefined) searchParams.set('status', params.status.toString())
  if (params.respondent_id) searchParams.set('respondent_id', params.respondent_id.toString())

  return fetchJson<GradingTaskListResponse>(
    getAuthorUrl(`/topics/${topicId}/grading-tasks?${searchParams.toString()}`)
  )
}

export async function getAuthorGradingTask(taskId: number): Promise<GradingTask> {
  return fetchJson<GradingTask>(getAuthorUrl(`/grading-tasks/${taskId}`))
}

export async function executeAuthorGradingTask(
  taskId: number,
  data?: GradingTaskExecuteRequest
): Promise<GradingTask> {
  return fetchJson<GradingTask>(getAuthorUrl(`/grading-tasks/${taskId}/execute`), {
    method: 'POST',
    body: data ? JSON.stringify(data) : undefined,
  })
}

export async function updateAuthorGradingReport(
  taskId: number,
  data: GradingTaskUpdateReportRequest
): Promise<GradingTask> {
  return fetchJson<GradingTask>(getAuthorUrl(`/grading-tasks/${taskId}/report`), {
    method: 'PUT',
    body: JSON.stringify(data),
  })
}

export async function publishAuthorGradingTask(
  taskId: number,
  data?: GradingTaskPublishRequest
): Promise<GradingTask> {
  return fetchJson<GradingTask>(getAuthorUrl(`/grading-tasks/${taskId}/publish`), {
    method: 'POST',
    body: data ? JSON.stringify(data) : undefined,
  })
}

export async function batchExecuteAuthorGradingTasks(
  topicId: number,
  taskIds: number[],
  teamId?: number
): Promise<{ executed_count: number; task_ids: number[] }> {
  const searchParams = teamId ? `?team_id=${teamId}` : ''
  return fetchJson(getAuthorUrl(`/topics/${topicId}/grading-tasks/batch-execute${searchParams}`), {
    method: 'POST',
    body: JSON.stringify(taskIds),
  })
}

export async function batchPublishAuthorGradingTasks(
  topicId: number,
  taskIds: number[]
): Promise<{ published_count: number; task_ids: number[] }> {
  return fetchJson(getAuthorUrl(`/topics/${topicId}/grading-tasks/batch-publish`), {
    method: 'POST',
    body: JSON.stringify(taskIds),
  })
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
  submit_count: number
  selected_question_id: number | null
  remaining_seconds: number
  is_overtime: boolean
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
