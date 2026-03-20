// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * API client functions for the evaluation grader module.
 * These APIs are for users who grade answers and manage grading tasks.
 */

import { fetchJson, getGraderUrl } from './evaluation-client'
import type {
  Topic,
  TopicStatistics,
  Question,
  Answer,
  GradingTask,
  GradingTaskExecuteRequest,
  GradingTaskPublishRequest,
  GradingTaskUpdateReportRequest,
  GradingTaskListResponse,
} from '../types/evaluation'

// ============================================================================
// Dashboard API (Grader)
// ============================================================================

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

// ============================================================================
// Topic API (Grader)
// ============================================================================

export interface GraderTopicItem {
  id: number
  name: string
  description?: string
  creator_id: number
  visibility: string
  status: number
  current_version: string
  created_at: string
  updated_at: string
  // Statistics
  question_count?: number
  total_answers: number
  pending_tasks: number
  completed_tasks: number
  published_tasks: number
}

export interface GraderTopicListResponse {
  total: number
  items: GraderTopicItem[]
}

export async function graderListTopics(params: {
  page?: number
  limit?: number
  search?: string
}): Promise<GraderTopicListResponse> {
  const searchParams = new URLSearchParams()
  if (params.page) searchParams.set('page', params.page.toString())
  if (params.limit) searchParams.set('limit', params.limit.toString())
  if (params.search) searchParams.set('search', params.search)

  return fetchJson<GraderTopicListResponse>(getGraderUrl(`/topics?${searchParams.toString()}`))
}

export async function graderGetTopic(topicId: number): Promise<Topic> {
  return fetchJson<Topic>(getGraderUrl(`/topics/${topicId}`))
}

export async function graderGetTopicStatistics(topicId: number): Promise<TopicStatistics> {
  return fetchJson<TopicStatistics>(getGraderUrl(`/topics/${topicId}/statistics`))
}

// ============================================================================
// Grading Task API (Grader)
// ============================================================================

export async function graderListTasks(params: {
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

export async function graderGetTask(taskId: number): Promise<GradingTask> {
  return fetchJson<GradingTask>(getGraderUrl(`/tasks/${taskId}`))
}

export async function graderExecuteTask(
  taskId: number,
  data?: GradingTaskExecuteRequest
): Promise<GradingTask> {
  return fetchJson<GradingTask>(getGraderUrl(`/tasks/${taskId}/execute`), {
    method: 'POST',
    body: data ? JSON.stringify(data) : undefined,
  })
}

export async function graderRetryTask(
  taskId: number,
  data?: GradingTaskExecuteRequest
): Promise<GradingTask> {
  return fetchJson<GradingTask>(getGraderUrl(`/tasks/${taskId}/retry`), {
    method: 'POST',
    body: data ? JSON.stringify(data) : undefined,
  })
}

export async function graderUpdateReport(
  taskId: number,
  data: GradingTaskUpdateReportRequest
): Promise<GradingTask> {
  return fetchJson<GradingTask>(getGraderUrl(`/tasks/${taskId}/report`), {
    method: 'PUT',
    body: JSON.stringify(data),
  })
}

export async function graderPublishTask(
  taskId: number,
  data?: GradingTaskPublishRequest
): Promise<GradingTask> {
  return fetchJson<GradingTask>(getGraderUrl(`/tasks/${taskId}/publish`), {
    method: 'POST',
    body: data ? JSON.stringify(data) : undefined,
  })
}

export async function graderBatchExecuteTasks(
  taskIds: number[],
  teamId?: number
): Promise<{ executed_count: number; task_ids: number[] }> {
  return fetchJson(getGraderUrl('/tasks/batch-execute'), {
    method: 'POST',
    body: JSON.stringify({ task_ids: taskIds, team_id: teamId }),
  })
}

export async function graderBatchPublishTasks(
  taskIds: number[]
): Promise<{ published_count: number; task_ids: number[] }> {
  return fetchJson(getGraderUrl('/tasks/batch-publish'), {
    method: 'POST',
    body: JSON.stringify(taskIds),
  })
}

// ============================================================================
// Reports API (Grader)
// ============================================================================

export async function graderListReports(params: {
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

// ============================================================================
// Report Upload/Download API (Grader) - Backend Proxy Mode
// ============================================================================

import { getToken } from '@/apis/user'

export interface ReportUploadResponse {
  key: string
  filename: string
  file_size: number
  content_type: string
}

/**
 * Upload a report file through backend proxy.
 * The file is uploaded directly to the backend, which proxies it to S3.
 * This avoids exposing S3 URLs to the frontend (prevents Mixed Content issues).
 *
 * @param taskId - Grading task ID
 * @param file - File to upload
 * @param onProgress - Optional progress callback (0-100)
 * @returns Upload response with S3 key
 */
export async function graderUploadReportFile(
  taskId: number,
  file: File,
  onProgress?: (progress: number) => void
): Promise<ReportUploadResponse> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    const formData = new FormData()

    // Build form data
    formData.append('file', file)

    // Track upload progress
    xhr.upload.addEventListener('progress', event => {
      if (event.lengthComputable && onProgress) {
        const progress = Math.round((event.loaded / event.total) * 100)
        onProgress(progress)
      }
    })

    xhr.addEventListener('load', () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        try {
          const response = JSON.parse(xhr.responseText)
          resolve(response)
        } catch {
          reject(new Error('Invalid response format'))
        }
      } else {
        try {
          const errorData = JSON.parse(xhr.responseText)
          reject(new Error(errorData.detail || `Upload failed: ${xhr.status}`))
        } catch {
          reject(new Error(`Upload failed: ${xhr.status}`))
        }
      }
    })

    xhr.addEventListener('error', () => {
      reject(new Error('Network error during upload'))
    })

    xhr.addEventListener('abort', () => {
      reject(new Error('Upload cancelled'))
    })

    // Get auth token and make request
    const token = getToken()
    xhr.open('POST', getGraderUrl(`/tasks/${taskId}/report/upload`))
    if (token) {
      xhr.setRequestHeader('Authorization', `Bearer ${token}`)
    }
    xhr.send(formData)
  })
}

/**
 * Publish a grading task with an uploaded attachment as the final report.
 */
export async function graderPublishTaskWithAttachment(
  taskId: number,
  attachment: {
    key: string
    filename: string
    size?: number
    contentType?: string
  }
): Promise<GradingTask> {
  return fetchJson<GradingTask>(getGraderUrl(`/tasks/${taskId}/publish-with-attachment`), {
    method: 'POST',
    body: JSON.stringify({
      attachment_key: attachment.key,
      attachment_filename: attachment.filename,
      attachment_size: attachment.size,
      attachment_content_type: attachment.contentType,
    }),
  })
}

/**
 * Download a report file through backend proxy.
 * The file is fetched from the backend, which proxies it from S3.
 * This avoids exposing S3 URLs to the frontend (prevents Mixed Content issues).
 *
 * @param taskId - Grading task ID
 * @param version - Report version: ai, human, or final. Defaults to latest available.
 */
export async function graderDownloadReportFile(
  taskId: number,
  version?: 'ai' | 'human' | 'final'
): Promise<void> {
  const token = getToken()
  const searchParams = new URLSearchParams()
  if (version) searchParams.set('version', version)

  const url = getGraderUrl(`/tasks/${taskId}/report/download?${searchParams.toString()}`)

  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    })

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}))
      throw new Error(errorData.detail || `Download failed: ${response.status}`)
    }

    // Get the blob from response
    const blob = await response.blob()
    const blobUrl = URL.createObjectURL(blob)

    // Extract filename from Content-Disposition header
    let filename = 'report'
    const contentDisposition = response.headers.get('Content-Disposition')
    if (contentDisposition) {
      const match = contentDisposition.match(/filename\*?=(?:UTF-8'')?["']?([^"';\s]+)["']?/i)
      if (match) {
        filename = decodeURIComponent(match[1])
      }
    }

    // Create a temporary link to trigger download
    const link = document.createElement('a')
    link.href = blobUrl
    link.download = filename
    document.body.appendChild(link)
    link.click()
    document.body.removeChild(link)

    // Clean up the blob URL
    URL.revokeObjectURL(blobUrl)
  } catch (error) {
    console.error('Download failed:', error)
    throw error
  }
}

// ============================================================================
// Supporting Data API (Grader)
// ============================================================================

export async function graderGetAnswer(answerId: number): Promise<Answer> {
  return fetchJson<Answer>(getGraderUrl(`/answers/${answerId}`))
}

export async function graderGetQuestion(questionId: number): Promise<Question> {
  return fetchJson<Question>(getGraderUrl(`/questions/${questionId}`))
}
