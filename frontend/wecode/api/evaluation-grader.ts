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

export async function graderRetryTask(taskId: number): Promise<GradingTask> {
  return fetchJson<GradingTask>(getGraderUrl(`/tasks/${taskId}/retry`), {
    method: 'POST',
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
// Report Upload/Download API (Grader)
// ============================================================================

export interface ReportUploadResponse {
  upload_url: string
  key: string
  expires_in: number
}

export interface ReportDownloadResponse {
  download_url: string
  filename: string
  s3_path?: string
}

/**
 * Get a presigned URL for uploading a report file.
 * Use this to upload a file as the final report before publishing.
 */
export async function graderGetReportUploadUrl(
  taskId: number,
  filename: string,
  contentType?: string
): Promise<ReportUploadResponse> {
  return fetchJson<ReportUploadResponse>(getGraderUrl(`/tasks/${taskId}/report/upload-url`), {
    method: 'POST',
    body: JSON.stringify({
      filename,
      content_type: contentType || 'application/octet-stream',
    }),
  })
}

/**
 * Upload a file to the presigned URL.
 * Returns true if successful.
 */
export async function uploadFileToPresignedUrl(
  uploadUrl: string,
  file: File
): Promise<boolean> {
  const response = await fetch(uploadUrl, {
    method: 'PUT',
    body: file,
    headers: {
      'Content-Type': file.type || 'application/octet-stream',
    },
  })
  return response.ok
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
 * Get a presigned URL for downloading a report file.
 * @param version - Report version: ai, human, or final. Defaults to latest available.
 */
export async function graderGetReportDownloadUrl(
  taskId: number,
  version?: 'ai' | 'human' | 'final'
): Promise<ReportDownloadResponse> {
  const searchParams = new URLSearchParams()
  if (version) searchParams.set('version', version)

  return fetchJson<ReportDownloadResponse>(
    getGraderUrl(`/tasks/${taskId}/report/download-url?${searchParams.toString()}`)
  )
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
