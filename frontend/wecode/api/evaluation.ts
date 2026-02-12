/**
 * API client functions for the evaluation module.
 */

import { getApiBaseUrl } from '@/lib/runtime-config'
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

const API_PREFIX = '/wecode/evaluation'

function getUrl(path: string): string {
  return `${getApiBaseUrl()}${API_PREFIX}${path}`
}

async function fetchJson<T>(url: string, options?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...options?.headers,
    },
    credentials: 'include',
  })

  if (!response.ok) {
    const error = await response.json().catch(() => ({ detail: 'Request failed' }))
    throw new Error(error.detail || 'Request failed')
  }

  return response.json()
}

// ============================================================================
// Topic API
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

  return fetchJson<TopicListResponse>(getUrl(`/topics?${searchParams.toString()}`))
}

export async function getTopic(topicId: number): Promise<Topic> {
  return fetchJson<Topic>(getUrl(`/topics/${topicId}`))
}

export async function createTopic(data: TopicCreate): Promise<Topic> {
  return fetchJson<Topic>(getUrl('/topics'), {
    method: 'POST',
    body: JSON.stringify(data),
  })
}

export async function updateTopic(topicId: number, data: TopicUpdate): Promise<Topic> {
  return fetchJson<Topic>(getUrl(`/topics/${topicId}`), {
    method: 'PUT',
    body: JSON.stringify(data),
  })
}

export async function deleteTopic(topicId: number): Promise<void> {
  await fetch(getUrl(`/topics/${topicId}`), {
    method: 'DELETE',
    credentials: 'include',
  })
}

export async function publishTopic(topicId: number): Promise<TopicVersion> {
  return fetchJson<TopicVersion>(getUrl(`/topics/${topicId}/publish`), {
    method: 'POST',
  })
}

export async function getTopicStatistics(topicId: number): Promise<TopicStatistics> {
  return fetchJson<TopicStatistics>(getUrl(`/topics/${topicId}/statistics`))
}

// ============================================================================
// Question API
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
    getUrl(`/topics/${topicId}/questions?${searchParams.toString()}`)
  )
}

export async function getQuestion(questionId: number): Promise<Question> {
  return fetchJson<Question>(getUrl(`/questions/${questionId}`))
}

export async function createQuestion(topicId: number, data: QuestionCreate): Promise<Question> {
  return fetchJson<Question>(getUrl(`/topics/${topicId}/questions`), {
    method: 'POST',
    body: JSON.stringify(data),
  })
}

export async function updateQuestion(questionId: number, data: QuestionUpdate): Promise<Question> {
  return fetchJson<Question>(getUrl(`/questions/${questionId}`), {
    method: 'PUT',
    body: JSON.stringify(data),
  })
}

export async function deleteQuestion(questionId: number): Promise<void> {
  await fetch(getUrl(`/questions/${questionId}`), {
    method: 'DELETE',
    credentials: 'include',
  })
}

export async function publishQuestion(questionId: number): Promise<QuestionVersion> {
  return fetchJson<QuestionVersion>(getUrl(`/questions/${questionId}/publish`), {
    method: 'POST',
  })
}

export async function reorderQuestions(topicId: number, questionIds: number[]): Promise<void> {
  await fetchJson(getUrl(`/topics/${topicId}/questions/reorder`), {
    method: 'POST',
    body: JSON.stringify(questionIds),
  })
}

// ============================================================================
// Permission API
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
    getUrl(`/topics/${topicId}/permissions?${searchParams.toString()}`)
  )
}

export async function grantPermission(topicId: number, data: PermissionCreate): Promise<Permission> {
  return fetchJson<Permission>(getUrl(`/topics/${topicId}/permissions`), {
    method: 'POST',
    body: JSON.stringify(data),
  })
}

export async function revokePermission(topicId: number, userId: number): Promise<void> {
  await fetch(getUrl(`/topics/${topicId}/permissions/${userId}`), {
    method: 'DELETE',
    credentials: 'include',
  })
}

export async function batchGrantPermissions(
  topicId: number,
  userIds: number[],
  role: string
): Promise<{ granted_count: number }> {
  return fetchJson(getUrl(`/topics/${topicId}/permissions/batch`), {
    method: 'POST',
    body: JSON.stringify(userIds),
    headers: {
      'Content-Type': 'application/json',
    },
  })
}

export async function getMyRole(topicId: number): Promise<UserRole> {
  return fetchJson<UserRole>(getUrl(`/topics/${topicId}/my-role`))
}

// ============================================================================
// Answer API
// ============================================================================

export async function submitAnswer(questionId: number, data: AnswerCreate): Promise<Answer> {
  return fetchJson<Answer>(getUrl(`/questions/${questionId}/answers`), {
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
    getUrl(`/questions/${questionId}/answers?${searchParams.toString()}`)
  )
}

export async function listMyAnswers(questionId: number): Promise<AnswerListResponse> {
  return fetchJson<AnswerListResponse>(getUrl(`/questions/${questionId}/answers/me`))
}

export async function checkVersionUpdate(questionId: number): Promise<VersionCheck> {
  return fetchJson<VersionCheck>(getUrl(`/questions/${questionId}/version-check`))
}

export async function getMyProgress(topicId: number): Promise<RespondentProgress> {
  return fetchJson<RespondentProgress>(getUrl(`/topics/${topicId}/my-progress`))
}

// ============================================================================
// Grading Task API
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
    getUrl(`/topics/${topicId}/grading-tasks?${searchParams.toString()}`)
  )
}

export async function getGradingTask(taskId: number): Promise<GradingTask> {
  return fetchJson<GradingTask>(getUrl(`/grading-tasks/${taskId}`))
}

export async function executeGradingTask(
  taskId: number,
  data?: GradingTaskExecuteRequest
): Promise<GradingTask> {
  return fetchJson<GradingTask>(getUrl(`/grading-tasks/${taskId}/execute`), {
    method: 'POST',
    body: data ? JSON.stringify(data) : undefined,
  })
}

export async function updateGradingReport(
  taskId: number,
  data: GradingTaskUpdateReportRequest
): Promise<GradingTask> {
  return fetchJson<GradingTask>(getUrl(`/grading-tasks/${taskId}/report`), {
    method: 'PUT',
    body: JSON.stringify(data),
  })
}

export async function publishGradingTask(
  taskId: number,
  data?: GradingTaskPublishRequest
): Promise<GradingTask> {
  return fetchJson<GradingTask>(getUrl(`/grading-tasks/${taskId}/publish`), {
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
  return fetchJson(getUrl(`/topics/${topicId}/grading-tasks/batch-execute${searchParams}`), {
    method: 'POST',
    body: JSON.stringify(taskIds),
  })
}

export async function batchPublishGradingTasks(
  topicId: number,
  taskIds: number[]
): Promise<{ published_count: number; task_ids: number[] }> {
  return fetchJson(getUrl(`/topics/${topicId}/grading-tasks/batch-publish`), {
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
    getUrl(`/my/grading-reports?${searchParams.toString()}`)
  )
}
