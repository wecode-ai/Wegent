// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * API client functions for the evaluation module.
 * Contains shared/generic evaluation APIs.
 *
 * For role-specific APIs, use:
 * - @wecode/api/evaluation-author - Author (topic creator) APIs
 * - @wecode/api/evaluation-respondent - Respondent (answer submitter) APIs
 * - @wecode/api/evaluation-grader - Grader (AI grading) APIs
 */

import { fetchJson, fetchDelete, getEvaluationUrl } from './evaluation-client'
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
  UserRole,
  Answer,
  AnswerCreate,
  AnswerListResponse,
  VersionCheck,
  RespondentProgress,
  GradingTask,
  GradingTaskExecuteRequest,
  GradingTaskPublishRequest,
  GradingTaskUpdateReportRequest,
  GradingTaskListResponse,
} from '../types/evaluation'

// Re-export from role-specific modules
export type { GraderDashboardStats } from './evaluation-grader'
export { getGraderDashboard } from './evaluation-grader'
export {
  respondentListTopics,
  respondentGetTopic,
  respondentListQuestions,
  respondentGetQuestion,
  respondentSubmitAnswer,
  respondentListAnswerHistory,
  respondentGetAnswer,
  // NOTE: respondentListGradingReports and respondentGetGradingReport have been REMOVED
  // Respondents cannot view any grading status or results
} from './evaluation-respondent'

// Re-export grader functions with convenient aliases
export {
  graderListTopics as listGraderTopics,
  graderGetTopic as getGraderTopic,
  graderGetTopicStatistics as getGraderTopicStatistics,
  graderListTasks as listGraderTasks,
  graderGetTask as getGraderTask,
  graderExecuteTask as executeGraderTask,
  graderRetryTask as retryGraderTask,
  graderUpdateReport as updateGraderReport,
  graderPublishTask as publishGraderTask,
  graderBatchExecuteTasks as batchExecuteGraderTasks,
  graderBatchPublishTasks as batchPublishGraderTasks,
  graderListReports as listGraderReports,
  graderGetAnswer as getGraderAnswer,
  graderGetQuestion as getGraderQuestion,
} from './evaluation-grader'

// ============================================================================
// Topic API (Shared)
// ============================================================================

export async function listTopics(params: {
  page?: number
  limit?: number
  visibility?: string
  status?: number
  search?: string
  my_only?: boolean
}): Promise<TopicListResponse> {
  const searchParams = new URLSearchParams()
  if (params.page) searchParams.set('page', params.page.toString())
  if (params.limit) searchParams.set('limit', params.limit.toString())
  if (params.visibility) searchParams.set('visibility', params.visibility)
  if (params.status !== undefined) searchParams.set('status', params.status.toString())
  if (params.search) searchParams.set('search', params.search)
  if (params.my_only) searchParams.set('my_only', 'true')

  return fetchJson<TopicListResponse>(getEvaluationUrl(`/topics?${searchParams.toString()}`))
}

export async function getTopic(topicId: number): Promise<Topic> {
  return fetchJson<Topic>(getEvaluationUrl(`/topics/${topicId}`))
}

export async function createTopic(data: TopicCreate): Promise<Topic> {
  return fetchJson<Topic>(getEvaluationUrl('/topics'), {
    method: 'POST',
    body: JSON.stringify(data),
  })
}

export async function updateTopic(topicId: number, data: TopicUpdate): Promise<Topic> {
  return fetchJson<Topic>(getEvaluationUrl(`/topics/${topicId}`), {
    method: 'PUT',
    body: JSON.stringify(data),
  })
}

export async function deleteTopic(topicId: number): Promise<void> {
  await fetchDelete(getEvaluationUrl(`/topics/${topicId}`))
}

export async function publishTopic(topicId: number): Promise<TopicVersion> {
  return fetchJson<TopicVersion>(getEvaluationUrl(`/topics/${topicId}/publish`), {
    method: 'POST',
  })
}

export async function getTopicStatistics(topicId: number): Promise<TopicStatistics> {
  return fetchJson<TopicStatistics>(getEvaluationUrl(`/topics/${topicId}/statistics`))
}

// ============================================================================
// Question API (Shared)
// ============================================================================

export async function listQuestions(
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
    getEvaluationUrl(`/topics/${topicId}/questions?${searchParams.toString()}`)
  )
}

export async function getQuestion(questionId: number): Promise<Question> {
  return fetchJson<Question>(getEvaluationUrl(`/questions/${questionId}`))
}

export async function createQuestion(topicId: number, data: QuestionCreate): Promise<Question> {
  return fetchJson<Question>(getEvaluationUrl(`/topics/${topicId}/questions`), {
    method: 'POST',
    body: JSON.stringify(data),
  })
}

export async function updateQuestion(questionId: number, data: QuestionUpdate): Promise<Question> {
  return fetchJson<Question>(getEvaluationUrl(`/questions/${questionId}`), {
    method: 'PUT',
    body: JSON.stringify(data),
  })
}

export async function deleteQuestion(questionId: number): Promise<void> {
  await fetchDelete(getEvaluationUrl(`/questions/${questionId}`))
}

export async function publishQuestion(questionId: number): Promise<QuestionVersion> {
  return fetchJson<QuestionVersion>(getEvaluationUrl(`/questions/${questionId}/publish`), {
    method: 'POST',
  })
}

export async function reorderQuestions(topicId: number, questionIds: number[]): Promise<void> {
  await fetchJson(getEvaluationUrl(`/topics/${topicId}/questions/reorder`), {
    method: 'POST',
    body: JSON.stringify(questionIds),
  })
}

// ============================================================================
// Permission API (Shared)
// ============================================================================

export async function listPermissions(
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
    getEvaluationUrl(`/topics/${topicId}/permissions?${searchParams.toString()}`)
  )
}

export async function grantPermission(
  topicId: number,
  data: PermissionCreate
): Promise<Permission> {
  return fetchJson<Permission>(getEvaluationUrl(`/topics/${topicId}/permissions`), {
    method: 'POST',
    body: JSON.stringify(data),
  })
}

export async function revokePermission(topicId: number, userId: number): Promise<void> {
  await fetchDelete(getEvaluationUrl(`/topics/${topicId}/permissions/${userId}`))
}

export async function batchGrantPermissions(
  topicId: number,
  userIds: number[],
  _role: string
): Promise<{ granted_count: number }> {
  return fetchJson(getEvaluationUrl(`/topics/${topicId}/permissions/batch`), {
    method: 'POST',
    body: JSON.stringify(userIds),
  })
}

export async function getMyRole(topicId: number): Promise<UserRole> {
  return fetchJson<UserRole>(getEvaluationUrl(`/topics/${topicId}/my-role`))
}

// ============================================================================
// Answer API (Shared)
// ============================================================================

export async function submitAnswer(questionId: number, data: AnswerCreate): Promise<Answer> {
  return fetchJson<Answer>(getEvaluationUrl(`/questions/${questionId}/answers`), {
    method: 'POST',
    body: JSON.stringify(data),
  })
}

export async function listAnswers(
  questionId: number,
  params: {
    page?: number
    limit?: number
    respondent_id?: number
    latest_only?: boolean
  }
): Promise<AnswerListResponse> {
  const searchParams = new URLSearchParams()
  if (params.page) searchParams.set('page', params.page.toString())
  if (params.limit) searchParams.set('limit', params.limit.toString())
  if (params.respondent_id) searchParams.set('respondent_id', params.respondent_id.toString())
  if (params.latest_only) searchParams.set('latest_only', 'true')

  return fetchJson<AnswerListResponse>(
    getEvaluationUrl(`/questions/${questionId}/answers?${searchParams.toString()}`)
  )
}

export async function listMyAnswers(questionId: number): Promise<AnswerListResponse> {
  return fetchJson<AnswerListResponse>(getEvaluationUrl(`/questions/${questionId}/answers/me`))
}

export async function checkVersionUpdate(questionId: number): Promise<VersionCheck> {
  return fetchJson<VersionCheck>(getEvaluationUrl(`/questions/${questionId}/version-check`))
}

/**
 * @deprecated Use respondentGetProgress from evaluation-respondent.ts instead
 */
export async function getMyProgress(topicId: number): Promise<RespondentProgress> {
  return fetchJson<RespondentProgress>(getEvaluationUrl(`/respondent/topics/${topicId}/progress`))
}

// ============================================================================
// Grading Task API (Shared)
// ============================================================================

export async function listGradingTasks(
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
    getEvaluationUrl(`/topics/${topicId}/grading-tasks?${searchParams.toString()}`)
  )
}

export async function getGradingTask(taskId: number): Promise<GradingTask> {
  return fetchJson<GradingTask>(getEvaluationUrl(`/grading-tasks/${taskId}`))
}

export async function executeGradingTask(
  taskId: number,
  data?: GradingTaskExecuteRequest
): Promise<GradingTask> {
  return fetchJson<GradingTask>(getEvaluationUrl(`/grading-tasks/${taskId}/execute`), {
    method: 'POST',
    body: data ? JSON.stringify(data) : undefined,
  })
}

export async function updateGradingReport(
  taskId: number,
  data: GradingTaskUpdateReportRequest
): Promise<GradingTask> {
  return fetchJson<GradingTask>(getEvaluationUrl(`/grading-tasks/${taskId}/report`), {
    method: 'PUT',
    body: JSON.stringify(data),
  })
}

export async function publishGradingTask(
  taskId: number,
  data?: GradingTaskPublishRequest
): Promise<GradingTask> {
  return fetchJson<GradingTask>(getEvaluationUrl(`/grading-tasks/${taskId}/publish`), {
    method: 'POST',
    body: data ? JSON.stringify(data) : undefined,
  })
}

export async function batchExecuteGradingTasks(
  topicId: number,
  taskIds: number[],
  teamId?: number
): Promise<{ executed_count: number; task_ids: number[] }> {
  const searchParams = teamId ? `?team_id=${teamId}` : ''
  return fetchJson(
    getEvaluationUrl(`/topics/${topicId}/grading-tasks/batch-execute${searchParams}`),
    {
      method: 'POST',
      body: JSON.stringify(taskIds),
    }
  )
}

export async function batchPublishGradingTasks(
  topicId: number,
  taskIds: number[]
): Promise<{ published_count: number; task_ids: number[] }> {
  return fetchJson(getEvaluationUrl(`/topics/${topicId}/grading-tasks/batch-publish`), {
    method: 'POST',
    body: JSON.stringify(taskIds),
  })
}

export async function listMyGradingReports(params: {
  page?: number
  limit?: number
  topic_id?: number
  status?: number
}): Promise<GradingTaskListResponse> {
  const searchParams = new URLSearchParams()
  if (params.page) searchParams.set('page', params.page.toString())
  if (params.limit) searchParams.set('limit', params.limit.toString())
  if (params.topic_id) searchParams.set('topic_id', params.topic_id.toString())
  if (params.status !== undefined) searchParams.set('status', params.status.toString())

  return fetchJson<GradingTaskListResponse>(
    getEvaluationUrl(`/my/grading-reports?${searchParams.toString()}`)
  )
}
