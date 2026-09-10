// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import type {
  CollaborationAttachment,
  CollaborationBoardSnapshot,
  CollaborationComment,
  CollaborationExecution,
  CollaborationFile,
  CollaborationIssue,
  CollaborationMember,
  CollaborationPriority,
  CollaborationProject,
} from './types'

export interface CollaborationHttpClient {
  get<T>(endpoint: string): Promise<T>
  post<T>(endpoint: string, data?: unknown): Promise<T>
  postForm?<T>(endpoint: string, data: FormData): Promise<T>
  patch<T>(endpoint: string, data?: unknown): Promise<T>
  delete<T>(endpoint: string, data?: unknown): Promise<T>
}

export interface CollaborationApi {
  listProjects(): Promise<CollaborationProject[]>
  getProject(projectId: string): Promise<CollaborationProject>
  createProject(data: {
    name: string
    description?: string
    visibility?: 'private' | 'public'
    project_store?: 'local' | 'backend'
  }): Promise<CollaborationProject>
  updateProject(
    projectId: string,
    data: Partial<Pick<CollaborationProject, 'name' | 'description' | 'visibility'>> & {
      version: number
    }
  ): Promise<CollaborationProject>
  getBoardSnapshot(projectId: string): Promise<CollaborationBoardSnapshot>
  getIssue(issueId: string): Promise<CollaborationIssue>
  createIssue(
    projectId: string,
    data: {
      title: string
      description?: string
      status?: string
      priority?: CollaborationPriority
      due_at?: string
      tags?: string[]
    }
  ): Promise<CollaborationIssue>
  updateIssue(
    issueId: string,
    data: Partial<
      Pick<
        CollaborationIssue,
        | 'title'
        | 'description'
        | 'status'
        | 'priority'
        | 'assignee_user_id'
        | 'assignee_agent_id'
        | 'assignee_team_id'
        | 'due_at'
        | 'tags'
      >
    > & { version: number }
  ): Promise<CollaborationIssue>
  reorderIssues(
    projectId: string,
    data: { parent_id: null; status: string; item_ids: string[] }
  ): Promise<CollaborationIssue[]>
  listComments(issueId: string): Promise<CollaborationComment[]>
  addComment(issueId: string, body: string): Promise<CollaborationComment>
  listAttachments(issueId: string): Promise<CollaborationAttachment[]>
  addAttachment(issueId: string, file: File): Promise<CollaborationAttachment>
  deleteAttachment(attachmentId: string): Promise<void>
  listMembers(projectId: string): Promise<CollaborationMember[]>
  listFiles(projectId: string): Promise<CollaborationFile[]>
  createFolder(projectId: string, path: string): Promise<CollaborationFile>
  uploadFile(projectId: string, file: File, path?: string): Promise<CollaborationFile>
  deleteFile(fileId: string, recursive?: boolean): Promise<void>
  listExecutions(projectId: string): Promise<CollaborationExecution[]>
  stopExecution(projectId: string, executionId: number): Promise<void>
}

function formPost<T>(
  client: CollaborationHttpClient,
  endpoint: string,
  form: FormData
): Promise<T> {
  if (client.postForm) return client.postForm<T>(endpoint, form)
  return client.post<T>(endpoint, form)
}

export function createCollaborationApi(client: CollaborationHttpClient): CollaborationApi {
  return {
    async listProjects() {
      const response = await client.get<{ items: CollaborationProject[] }>('/v1/cloud-projects')
      return response.items
    },
    getProject(projectId) {
      return client.get(`/v1/cloud-projects/${encodeURIComponent(projectId)}`)
    },
    createProject(data) {
      return client.post('/v1/cloud-projects', data)
    },
    updateProject(projectId, data) {
      return client.patch(`/v1/cloud-projects/${encodeURIComponent(projectId)}`, data)
    },
    getBoardSnapshot(projectId) {
      return client.get(`/v1/cloud-projects/${encodeURIComponent(projectId)}/board-snapshot`)
    },
    getIssue(issueId) {
      return client.get(`/v1/loop-items/${encodeURIComponent(issueId)}`)
    },
    createIssue(projectId, data) {
      return client.post(`/v1/cloud-projects/${encodeURIComponent(projectId)}/loop-items`, data)
    },
    updateIssue(issueId, data) {
      return client.patch(`/v1/loop-items/${encodeURIComponent(issueId)}`, data)
    },
    async reorderIssues(projectId, data) {
      const response = await client.post<{ items: CollaborationIssue[] }>(
        `/v1/cloud-projects/${encodeURIComponent(projectId)}/loop-items/reorder`,
        data
      )
      return response.items
    },
    listComments(issueId) {
      return client.get(`/v1/loop-items/${encodeURIComponent(issueId)}/comments`)
    },
    addComment(issueId, body) {
      return client.post(`/v1/loop-items/${encodeURIComponent(issueId)}/comments`, { body })
    },
    listAttachments(issueId) {
      return client.get(`/v1/loop-items/${encodeURIComponent(issueId)}/attachments`)
    },
    addAttachment(issueId, file) {
      const form = new FormData()
      form.set('file', file, file.name)
      return formPost(client, `/v1/loop-items/${encodeURIComponent(issueId)}/attachments`, form)
    },
    deleteAttachment(attachmentId) {
      return client.delete(`/v1/loop-item-attachments/${encodeURIComponent(attachmentId)}`)
    },
    listMembers(projectId) {
      return client.get(`/v1/cloud-projects/${encodeURIComponent(projectId)}/members`)
    },
    async listFiles(projectId) {
      const response = await client.get<{ items: CollaborationFile[] }>(
        `/v1/cloud-projects/${encodeURIComponent(projectId)}/files`
      )
      return response.items
    },
    createFolder(projectId, path) {
      return client.post(`/v1/cloud-projects/${encodeURIComponent(projectId)}/folders`, { path })
    },
    uploadFile(projectId, file, path = file.name) {
      const form = new FormData()
      form.set('file', file, file.name)
      form.set('path', path)
      return formPost(client, `/v1/cloud-projects/${encodeURIComponent(projectId)}/files`, form)
    },
    deleteFile(fileId, recursive = false) {
      return client.delete(
        `/v1/cloud-projects/files/${encodeURIComponent(fileId)}${recursive ? '?recursive=true' : ''}`
      )
    },
    async listExecutions(projectId) {
      const response = await client.get<{
        items: Array<Record<string, unknown>>
      }>(`/v1/cloud-projects/${encodeURIComponent(projectId)}/executions`)
      return response.items.map(row => ({
        id: Number(row.id),
        loop_item_id: String(row.loopItemId ?? ''),
        task_title: String(row.taskTitle ?? ''),
        executor_type: String(row.executorType ?? ''),
        status: String(row.status ?? ''),
        display_state: String(row.displayState ?? ''),
        observed_state: String(row.observedState ?? ''),
        sync_state: String(row.syncState ?? ''),
        started_at: row.startedAt == null ? null : String(row.startedAt),
        completed_at: row.completedAt == null ? null : String(row.completedAt),
        error_message: row.errorMessage == null ? null : String(row.errorMessage),
      }))
    },
    async stopExecution(projectId, executionId) {
      await client.post(
        `/v1/cloud-projects/${encodeURIComponent(projectId)}/executions/${executionId}/stop`
      )
    },
  }
}
