// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import type {
  CollaborationAgent,
  CollaborationAgentInput,
  CollaborationAttachment,
  CollaborationAutomationInput,
  CollaborationAutomationRule,
  CollaborationAutomationRun,
  CollaborationBoardSnapshot,
  CollaborationComment,
  CollaborationExecution,
  CollaborationFile,
  CollaborationIssue,
  CollaborationIncomingHook,
  CollaborationIncomingHookInput,
  CollaborationMember,
  CollaborationPriority,
  CollaborationProject,
  CollaborationRole,
  CollaborationUser,
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
    data: Partial<
      Pick<
        CollaborationProject,
        | 'name'
        | 'description'
        | 'visibility'
        | 'tags'
        | 'provider_config'
        | 'board_config'
        | 'card_display'
      >
    > & { version: number }
  ): Promise<CollaborationProject>
  archiveProject(projectId: string, version: number): Promise<void>
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
    data: { parent_id: string | null; status: string; item_ids: string[] }
  ): Promise<CollaborationIssue[]>
  listComments(issueId: string): Promise<CollaborationComment[]>
  addComment(issueId: string, body: string): Promise<CollaborationComment>
  listAttachments(issueId: string): Promise<CollaborationAttachment[]>
  addAttachment(issueId: string, file: File): Promise<CollaborationAttachment>
  deleteAttachment(attachmentId: string): Promise<void>
  listMembers(projectId: string): Promise<CollaborationMember[]>
  searchUsers(query: string): Promise<CollaborationUser[]>
  addMember(
    projectId: string,
    userId: number,
    role?: Exclude<CollaborationRole, 'Owner'>
  ): Promise<CollaborationMember>
  updateMember(
    projectId: string,
    userId: number,
    data: {
      role?: Exclude<CollaborationRole, 'Owner'>
      capability_description?: string
    }
  ): Promise<CollaborationMember>
  removeMember(projectId: string, userId: number): Promise<void>
  listAgents(projectId: string): Promise<CollaborationAgent[]>
  createAgent(projectId: string, data: CollaborationAgentInput): Promise<CollaborationAgent>
  updateAgent(
    projectId: string,
    agentId: string,
    data: Partial<CollaborationAgentInput> & {
      status?: 'active' | 'archived'
      version: number
    }
  ): Promise<CollaborationAgent>
  listFiles(projectId: string): Promise<CollaborationFile[]>
  createFolder(projectId: string, path: string): Promise<CollaborationFile>
  uploadFile(projectId: string, file: File, path?: string): Promise<CollaborationFile>
  deleteFile(fileId: string, recursive?: boolean): Promise<void>
  listExecutions(projectId: string): Promise<CollaborationExecution[]>
  stopExecution(projectId: string, executionId: number): Promise<void>
  listIncomingHooks(projectId: string): Promise<CollaborationIncomingHook[]>
  createIncomingHook(
    projectId: string,
    data: CollaborationIncomingHookInput
  ): Promise<CollaborationIncomingHook>
  updateIncomingHook(
    projectId: string,
    hookId: string,
    data: Partial<CollaborationIncomingHookInput> & {
      status?: CollaborationIncomingHook['status']
      version: number
    }
  ): Promise<CollaborationIncomingHook>
  deleteIncomingHook(projectId: string, hookId: string): Promise<void>
  listAutomations(projectId: string): Promise<CollaborationAutomationRule[]>
  createAutomation(
    projectId: string,
    data: CollaborationAutomationInput
  ): Promise<CollaborationAutomationRule>
  updateAutomation(
    projectId: string,
    automationId: string,
    data: Partial<CollaborationAutomationInput> & { version: number }
  ): Promise<CollaborationAutomationRule>
  deleteAutomation(projectId: string, automationId: string): Promise<void>
  runAutomation(projectId: string, automationId: string): Promise<CollaborationAutomationRun>
  listAutomationRuns(projectId: string, automationId: string): Promise<CollaborationAutomationRun[]>
  cancelAutomationRun(projectId: string, runId: string): Promise<CollaborationAutomationRun>
  retryAutomationRun(projectId: string, runId: string): Promise<CollaborationAutomationRun>
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
    archiveProject(projectId, version) {
      return client.delete(`/v1/cloud-projects/${encodeURIComponent(projectId)}?version=${version}`)
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
    async searchUsers(query) {
      const response = await client.get<{ users: CollaborationUser[] }>(
        `/users/search?q=${encodeURIComponent(query)}&limit=20`
      )
      return response.users
    },
    addMember(projectId, userId, role = 'Developer') {
      return client.post(`/v1/cloud-projects/${encodeURIComponent(projectId)}/members`, {
        user_id: userId,
        role,
      })
    },
    updateMember(projectId, userId, data) {
      return client.patch(
        `/v1/cloud-projects/${encodeURIComponent(projectId)}/members/${userId}`,
        data
      )
    },
    removeMember(projectId, userId) {
      return client.delete(`/v1/cloud-projects/${encodeURIComponent(projectId)}/members/${userId}`)
    },
    listAgents(projectId) {
      return client.get(`/v1/cloud-projects/${encodeURIComponent(projectId)}/chat-agents`)
    },
    createAgent(projectId, data) {
      return client.post(`/v1/cloud-projects/${encodeURIComponent(projectId)}/chat-agents`, data)
    },
    updateAgent(projectId, agentId, data) {
      return client.patch(
        `/v1/cloud-projects/${encodeURIComponent(projectId)}/chat-agents/${encodeURIComponent(agentId)}`,
        data
      )
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
    listIncomingHooks(projectId) {
      return client.get(`/v1/cloud-projects/${encodeURIComponent(projectId)}/incoming-hooks`)
    },
    createIncomingHook(projectId, data) {
      return client.post(
        `/v1/cloud-projects/${encodeURIComponent(projectId)}/incoming-hooks`,
        data
      )
    },
    updateIncomingHook(projectId, hookId, data) {
      return client.patch(
        `/v1/cloud-projects/${encodeURIComponent(projectId)}/incoming-hooks/${encodeURIComponent(hookId)}`,
        data
      )
    },
    async deleteIncomingHook(projectId, hookId) {
      await client.delete(
        `/v1/cloud-projects/${encodeURIComponent(projectId)}/incoming-hooks/${encodeURIComponent(hookId)}`
      )
    },
    listAutomations(projectId) {
      return client.get(`/v1/cloud-projects/${encodeURIComponent(projectId)}/automations`)
    },
    createAutomation(projectId, data) {
      return client.post(`/v1/cloud-projects/${encodeURIComponent(projectId)}/automations`, data)
    },
    updateAutomation(projectId, automationId, data) {
      return client.patch(
        `/v1/cloud-projects/${encodeURIComponent(projectId)}/automations/${encodeURIComponent(automationId)}`,
        data
      )
    },
    async deleteAutomation(projectId, automationId) {
      await client.delete(
        `/v1/cloud-projects/${encodeURIComponent(projectId)}/automations/${encodeURIComponent(automationId)}`
      )
    },
    runAutomation(projectId, automationId) {
      return client.post(
        `/v1/cloud-projects/${encodeURIComponent(projectId)}/automations/${encodeURIComponent(automationId)}/run`,
        {}
      )
    },
    listAutomationRuns(projectId, automationId) {
      return client.get(
        `/v1/cloud-projects/${encodeURIComponent(projectId)}/automations/${encodeURIComponent(automationId)}/runs`
      )
    },
    cancelAutomationRun(projectId, runId) {
      return client.post(
        `/v1/cloud-projects/${encodeURIComponent(projectId)}/automation-runs/${encodeURIComponent(runId)}/cancel`,
        {}
      )
    },
    retryAutomationRun(projectId, runId) {
      return client.post(
        `/v1/cloud-projects/${encodeURIComponent(projectId)}/automation-runs/${encodeURIComponent(runId)}/retry`,
        {}
      )
    },
  }
}
