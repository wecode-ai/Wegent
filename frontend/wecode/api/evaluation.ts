/**
 * API client functions for the evaluation module.
 */

import { getApiBaseUrl } from '@/lib/runtime-config'
import { getToken, removeToken } from '@/apis/user'
import { paths } from '@/config/paths'
import { POST_LOGIN_REDIRECT_KEY, sanitizeRedirectPath } from '@/features/login/constants'
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
  const token = getToken()

  const response = await fetch(url, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(token && { Authorization: `Bearer ${token}` }),
      ...options?.headers,
    },
  })

  // Handle authentication errors
  if (response.status === 401) {
    removeToken()
    if (typeof window !== 'undefined') {
      const loginPath = paths.auth.login.getHref()
      if (window.location.pathname === loginPath) {
        window.location.href = loginPath
      } else {
        const disallowedTargets = [loginPath, '/login/oidc']
        const currentPathWithSearch = `${window.location.pathname}${window.location.search}`
        const redirectTarget = sanitizeRedirectPath(currentPathWithSearch, disallowedTargets)
        if (redirectTarget) {
          sessionStorage.setItem(POST_LOGIN_REDIRECT_KEY, redirectTarget)
          window.location.href = `${loginPath}?redirect=${encodeURIComponent(redirectTarget)}`
        } else {
          sessionStorage.removeItem(POST_LOGIN_REDIRECT_KEY)
          window.location.href = loginPath
        }
      }
    }
    throw new Error('Authentication failed')
  }

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
  const token = getToken()
  await fetch(getUrl(`/topics/${topicId}`), {
    method: 'DELETE',
    headers: {
      ...(token && { Authorization: `Bearer ${token}` }),
    },
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
  const token = getToken()
  await fetch(getUrl(`/questions/${questionId}`), {
    method: 'DELETE',
    headers: {
      ...(token && { Authorization: `Bearer ${token}` }),
    },
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

export async function grantPermission(
  topicId: number,
  data: PermissionCreate
): Promise<Permission> {
  return fetchJson<Permission>(getUrl(`/topics/${topicId}/permissions`), {
    method: 'POST',
    body: JSON.stringify(data),
  })
}

export async function revokePermission(topicId: number, userId: number): Promise<void> {
  const token = getToken()
  await fetch(getUrl(`/topics/${topicId}/permissions/${userId}`), {
    method: 'DELETE',
    headers: {
      ...(token && { Authorization: `Bearer ${token}` }),
    },
  })
}

export async function batchGrantPermissions(
  topicId: number,
  userIds: number[],
  _role: string
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

// ============================================================================
// Respondent API (role-based endpoints for answer submission)
// ============================================================================

export async function respondentListTopics(params: {
  page?: number
  limit?: number
  search?: string
}): Promise<TopicListResponse> {
  const searchParams = new URLSearchParams()
  if (params.page) searchParams.set('page', params.page.toString())
  if (params.limit) searchParams.set('limit', params.limit.toString())
  if (params.search) searchParams.set('search', params.search)

  return fetchJson<TopicListResponse>(getUrl(`/respondent/topics?${searchParams.toString()}`))
}

export async function respondentGetTopic(topicId: number): Promise<Topic> {
  return fetchJson<Topic>(getUrl(`/respondent/topics/${topicId}`))
}

export async function respondentListQuestions(
  topicId: number,
  params: {
    page?: number
    limit?: number
  }
): Promise<QuestionListResponse> {
  const searchParams = new URLSearchParams()
  if (params.page) searchParams.set('page', params.page.toString())
  if (params.limit) searchParams.set('limit', params.limit.toString())

  return fetchJson<QuestionListResponse>(
    getUrl(`/respondent/topics/${topicId}/questions?${searchParams.toString()}`)
  )
}

export async function respondentGetQuestion(questionId: number): Promise<Question> {
  return fetchJson<Question>(getUrl(`/respondent/questions/${questionId}`))
}

export async function respondentSubmitAnswer(
  questionId: number,
  data: AnswerCreate
): Promise<Answer> {
  return fetchJson<Answer>(getUrl(`/respondent/questions/${questionId}/answers`), {
    method: 'POST',
    body: JSON.stringify(data),
  })
}

export async function respondentListAnswerHistory(params: {
  page?: number
  limit?: number
  topic_id?: number
  latest_only?: boolean
}): Promise<AnswerListResponse> {
  const searchParams = new URLSearchParams()
  if (params.page) searchParams.set('page', params.page.toString())
  if (params.limit) searchParams.set('limit', params.limit.toString())
  if (params.topic_id) searchParams.set('topic_id', params.topic_id.toString())
  if (params.latest_only !== undefined)
    searchParams.set('latest_only', params.latest_only.toString())

  return fetchJson<AnswerListResponse>(getUrl(`/respondent/history?${searchParams.toString()}`))
}

export async function respondentGetAnswer(answerId: number): Promise<Answer> {
  return fetchJson<Answer>(getUrl(`/respondent/answers/${answerId}`))
}

export async function respondentListGradingReports(params: {
  page?: number
  limit?: number
  topic_id?: number
}): Promise<GradingTaskListResponse> {
  const searchParams = new URLSearchParams()
  if (params.page) searchParams.set('page', params.page.toString())
  if (params.limit) searchParams.set('limit', params.limit.toString())
  if (params.topic_id) searchParams.set('topic_id', params.topic_id.toString())

  return fetchJson<GradingTaskListResponse>(
    getUrl(`/respondent/reports?${searchParams.toString()}`)
  )
}

export async function respondentGetGradingReport(reportId: number): Promise<GradingTask> {
  return fetchJson<GradingTask>(getUrl(`/respondent/reports/${reportId}`))
}

// ============================================================================
// Grader Role API (role-based endpoints under /grader/*)
// ============================================================================

const GRADER_API_PREFIX = '/wecode/evaluation/grader'

function getGraderUrl(path: string): string {
  return `${getApiBaseUrl()}${GRADER_API_PREFIX}${path}`
}

export interface GraderDashboardStats {
  pending_count: number
  running_count: number
  completed_count: number
  failed_count: number
  published_count: number
  total_topics: number
}

export async function getGraderDashboard(): Promise<GraderDashboardStats> {
  return fetchJson<GraderDashboardStats>(getGraderUrl('/dashboard'))
}

export async function listGraderTopics(params: {
  page?: number
  limit?: number
  search?: string
}): Promise<TopicListResponse> {
  const searchParams = new URLSearchParams()
  if (params.page) searchParams.set('page', params.page.toString())
  if (params.limit) searchParams.set('limit', params.limit.toString())
  if (params.search) searchParams.set('search', params.search)

  return fetchJson<TopicListResponse>(getGraderUrl(`/topics?${searchParams.toString()}`))
}

export async function getGraderTopic(topicId: number): Promise<Topic> {
  return fetchJson<Topic>(getGraderUrl(`/topics/${topicId}`))
}

export async function getGraderTopicStatistics(topicId: number): Promise<TopicStatistics> {
  return fetchJson<TopicStatistics>(getGraderUrl(`/topics/${topicId}/statistics`))
}

export async function listGraderTasks(params: {
  page?: number
  limit?: number
  status?: number
  topic_id?: number
  respondent_id?: number
}): Promise<GradingTaskListResponse> {
  const searchParams = new URLSearchParams()
  if (params.page) searchParams.set('page', params.page.toString())
  if (params.limit) searchParams.set('limit', params.limit.toString())
  if (params.status !== undefined) searchParams.set('status', params.status.toString())
  if (params.topic_id) searchParams.set('topic_id', params.topic_id.toString())
  if (params.respondent_id) searchParams.set('respondent_id', params.respondent_id.toString())

  return fetchJson<GradingTaskListResponse>(getGraderUrl(`/tasks?${searchParams.toString()}`))
}

export async function getGraderTask(taskId: number): Promise<GradingTask> {
  return fetchJson<GradingTask>(getGraderUrl(`/tasks/${taskId}`))
}

export async function executeGraderTask(
  taskId: number,
  data?: GradingTaskExecuteRequest
): Promise<GradingTask> {
  return fetchJson<GradingTask>(getGraderUrl(`/tasks/${taskId}/execute`), {
    method: 'POST',
    body: data ? JSON.stringify(data) : undefined,
  })
}

export async function retryGraderTask(taskId: number): Promise<GradingTask> {
  return fetchJson<GradingTask>(getGraderUrl(`/tasks/${taskId}/retry`), {
    method: 'POST',
  })
}

export async function updateGraderReport(
  taskId: number,
  data: GradingTaskUpdateReportRequest
): Promise<GradingTask> {
  return fetchJson<GradingTask>(getGraderUrl(`/tasks/${taskId}/report`), {
    method: 'PUT',
    body: JSON.stringify(data),
  })
}

export async function publishGraderTask(
  taskId: number,
  data?: GradingTaskPublishRequest
): Promise<GradingTask> {
  return fetchJson<GradingTask>(getGraderUrl(`/tasks/${taskId}/publish`), {
    method: 'POST',
    body: data ? JSON.stringify(data) : undefined,
  })
}

export async function batchExecuteGraderTasks(
  taskIds: number[],
  teamId?: number
): Promise<{ executed_count: number; task_ids: number[] }> {
  const searchParams = teamId ? `?team_id=${teamId}` : ''
  return fetchJson(getGraderUrl(`/tasks/batch-execute${searchParams}`), {
    method: 'POST',
    body: JSON.stringify(taskIds),
  })
}

export async function batchPublishGraderTasks(
  taskIds: number[]
): Promise<{ published_count: number; task_ids: number[] }> {
  return fetchJson(getGraderUrl('/tasks/batch-publish'), {
    method: 'POST',
    body: JSON.stringify(taskIds),
  })
}

export async function listGraderReports(params: {
  page?: number
  limit?: number
  status?: number
  topic_id?: number
}): Promise<GradingTaskListResponse> {
  const searchParams = new URLSearchParams()
  if (params.page) searchParams.set('page', params.page.toString())
  if (params.limit) searchParams.set('limit', params.limit.toString())
  if (params.status !== undefined) searchParams.set('status', params.status.toString())
  if (params.topic_id) searchParams.set('topic_id', params.topic_id.toString())

  return fetchJson<GradingTaskListResponse>(getGraderUrl(`/reports?${searchParams.toString()}`))
}

export async function getGraderAnswer(answerId: number): Promise<Answer> {
  return fetchJson<Answer>(getGraderUrl(`/answers/${answerId}`))
}

export async function getGraderQuestion(questionId: number): Promise<Question> {
  return fetchJson<Question>(getGraderUrl(`/questions/${questionId}`))
}
