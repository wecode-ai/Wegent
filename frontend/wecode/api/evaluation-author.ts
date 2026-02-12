// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * API client functions for the evaluation author module.
 * These APIs are specifically for topic creators (authors) to manage their topics.
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
  GradingTask,
  GradingTaskExecuteRequest,
  GradingTaskPublishRequest,
  GradingTaskUpdateReportRequest,
  GradingTaskListResponse,
} from '../types/evaluation'

const API_PREFIX = '/wecode/evaluation/author'

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

  return fetchJson<TopicListResponse>(getUrl(`/topics?${searchParams.toString()}`))
}

export async function getAuthorTopic(topicId: number): Promise<Topic> {
  return fetchJson<Topic>(getUrl(`/topics/${topicId}`))
}

export async function createAuthorTopic(data: TopicCreate): Promise<Topic> {
  return fetchJson<Topic>(getUrl('/topics'), {
    method: 'POST',
    body: JSON.stringify(data),
  })
}

export async function updateAuthorTopic(topicId: number, data: TopicUpdate): Promise<Topic> {
  return fetchJson<Topic>(getUrl(`/topics/${topicId}`), {
    method: 'PUT',
    body: JSON.stringify(data),
  })
}

export async function deleteAuthorTopic(topicId: number): Promise<void> {
  const token = getToken()
  await fetch(getUrl(`/topics/${topicId}`), {
    method: 'DELETE',
    headers: {
      ...(token && { Authorization: `Bearer ${token}` }),
    },
  })
}

export async function publishAuthorTopic(topicId: number): Promise<TopicVersion> {
  return fetchJson<TopicVersion>(getUrl(`/topics/${topicId}/publish`), {
    method: 'POST',
  })
}

export async function getAuthorTopicStatistics(topicId: number): Promise<TopicStatistics> {
  return fetchJson<TopicStatistics>(getUrl(`/topics/${topicId}/statistics`))
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
    getUrl(`/topics/${topicId}/versions?${searchParams.toString()}`)
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
    getUrl(`/topics/${topicId}/questions?${searchParams.toString()}`)
  )
}

export async function getAuthorQuestion(questionId: number): Promise<Question> {
  return fetchJson<Question>(getUrl(`/questions/${questionId}`))
}

export async function createAuthorQuestion(
  topicId: number,
  data: QuestionCreate
): Promise<Question> {
  return fetchJson<Question>(getUrl(`/topics/${topicId}/questions`), {
    method: 'POST',
    body: JSON.stringify(data),
  })
}

export async function updateAuthorQuestion(
  questionId: number,
  data: QuestionUpdate
): Promise<Question> {
  return fetchJson<Question>(getUrl(`/questions/${questionId}`), {
    method: 'PUT',
    body: JSON.stringify(data),
  })
}

export async function deleteAuthorQuestion(questionId: number): Promise<void> {
  const token = getToken()
  await fetch(getUrl(`/questions/${questionId}`), {
    method: 'DELETE',
    headers: {
      ...(token && { Authorization: `Bearer ${token}` }),
    },
  })
}

export async function publishAuthorQuestion(questionId: number): Promise<QuestionVersion> {
  return fetchJson<QuestionVersion>(getUrl(`/questions/${questionId}/publish`), {
    method: 'POST',
  })
}

export async function reorderAuthorQuestions(
  topicId: number,
  questionIds: number[]
): Promise<void> {
  await fetchJson(getUrl(`/topics/${topicId}/questions/reorder`), {
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
    getUrl(`/topics/${topicId}/permissions?${searchParams.toString()}`)
  )
}

export async function grantAuthorPermission(
  topicId: number,
  data: PermissionCreate
): Promise<Permission> {
  return fetchJson<Permission>(getUrl(`/topics/${topicId}/permissions`), {
    method: 'POST',
    body: JSON.stringify(data),
  })
}

export async function revokeAuthorPermission(topicId: number, userId: number): Promise<void> {
  const token = getToken()
  await fetch(getUrl(`/topics/${topicId}/permissions/${userId}`), {
    method: 'DELETE',
    headers: {
      ...(token && { Authorization: `Bearer ${token}` }),
    },
  })
}

export async function batchGrantAuthorPermissions(
  topicId: number,
  userIds: number[],
  role: string
): Promise<{ granted_count: number }> {
  const searchParams = new URLSearchParams()
  searchParams.set('role', role)
  return fetchJson(getUrl(`/topics/${topicId}/permissions/batch?${searchParams.toString()}`), {
    method: 'POST',
    body: JSON.stringify(userIds),
  })
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
    getUrl(`/topics/${topicId}/grading-tasks?${searchParams.toString()}`)
  )
}

export async function getAuthorGradingTask(taskId: number): Promise<GradingTask> {
  return fetchJson<GradingTask>(getUrl(`/grading-tasks/${taskId}`))
}

export async function executeAuthorGradingTask(
  taskId: number,
  data?: GradingTaskExecuteRequest
): Promise<GradingTask> {
  return fetchJson<GradingTask>(getUrl(`/grading-tasks/${taskId}/execute`), {
    method: 'POST',
    body: data ? JSON.stringify(data) : undefined,
  })
}

export async function updateAuthorGradingReport(
  taskId: number,
  data: GradingTaskUpdateReportRequest
): Promise<GradingTask> {
  return fetchJson<GradingTask>(getUrl(`/grading-tasks/${taskId}/report`), {
    method: 'PUT',
    body: JSON.stringify(data),
  })
}

export async function publishAuthorGradingTask(
  taskId: number,
  data?: GradingTaskPublishRequest
): Promise<GradingTask> {
  return fetchJson<GradingTask>(getUrl(`/grading-tasks/${taskId}/publish`), {
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
  return fetchJson(getUrl(`/topics/${topicId}/grading-tasks/batch-execute${searchParams}`), {
    method: 'POST',
    body: JSON.stringify(taskIds),
  })
}

export async function batchPublishAuthorGradingTasks(
  topicId: number,
  taskIds: number[]
): Promise<{ published_count: number; task_ids: number[] }> {
  return fetchJson(getUrl(`/topics/${topicId}/grading-tasks/batch-publish`), {
    method: 'POST',
    body: JSON.stringify(taskIds),
  })
}
