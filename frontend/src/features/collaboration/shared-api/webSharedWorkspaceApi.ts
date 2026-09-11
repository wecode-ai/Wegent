// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import {
  buildInstalledPluginProjectCatalog,
  mapCollaborationExecutionDto,
  mapWorkspaceDeliveryAssetDto,
  mapWorkspaceDeliveryDto,
  mapWorkspaceIssueCollaboratorDto,
  mapWorkspaceTaskBindingDto,
  mapWorkspaceWorkflowPlanDto,
  mapWorkspaceWorkflowStageContextDto,
} from '@wegent/collaboration'
import type {
  CollaborationAttachment,
  CollaborationBoardSnapshot,
  CollaborationFile,
  CollaborationIssue,
  CollaborationProject,
  InstalledPluginCatalogItem,
  SharedWorkspaceApi,
  WorkspaceBinaryAccess,
  WorkspaceAutomationExecutionCatalog,
  WorkspaceAutomationPlugin,
  WorkspaceDeliveryFile,
} from '@wegent/collaboration'

import { ApiError, apiClient } from '@/apis/client'
import { getToken } from '@/apis/user'
import { getApiBaseUrl } from '@/lib/runtime-config'

export interface WebWorkspaceHttpClient {
  get<T>(endpoint: string): Promise<T>
  post<T>(endpoint: string, data?: unknown): Promise<T>
  postForm<T>(endpoint: string, data: FormData): Promise<T>
  put<T>(endpoint: string, data?: unknown): Promise<T>
  patch<T>(endpoint: string, data?: unknown): Promise<T>
  delete<T>(endpoint: string, data?: unknown): Promise<T>
}

export interface WebWorkspaceBinaryTransport {
  getBlob(endpoint: string): Promise<Blob>
}

export type WebWorkspaceCapabilityStatus = 'supported' | 'partial' | 'unsupported'

export interface WebWorkspaceCapability {
  capability: string
  status: WebWorkspaceCapabilityStatus
  endpoint?: string
  reason?: string
}

export const WEB_SHARED_WORKSPACE_CAPABILITIES: readonly WebWorkspaceCapability[] = [
  { capability: 'projects.list', status: 'supported', endpoint: 'GET /v1/cloud-projects' },
  { capability: 'projects.get', status: 'supported', endpoint: 'GET /v1/cloud-projects/{id}' },
  { capability: 'projects.create', status: 'supported', endpoint: 'POST /v1/cloud-projects' },
  { capability: 'projects.update', status: 'supported', endpoint: 'PATCH /v1/cloud-projects/{id}' },
  {
    capability: 'projects.archive',
    status: 'supported',
    endpoint: 'DELETE /v1/cloud-projects/{id}',
  },
  {
    capability: 'projects.importMessages',
    status: 'supported',
    endpoint: 'POST /v1/cloud-projects/{id}/message-imports',
  },
  {
    capability: 'issues.list',
    status: 'supported',
    endpoint: 'GET /v1/cloud-projects/{id}/loop-items',
  },
  {
    capability: 'issues.listPage',
    status: 'supported',
    endpoint: 'GET /v1/cloud-projects/{id}/loop-item-pages',
  },
  {
    capability: 'issues.getBoardSnapshot',
    status: 'supported',
    endpoint: 'GET /v1/cloud-projects/{id}/board-snapshot',
  },
  { capability: 'issues.get', status: 'supported', endpoint: 'GET /v1/loop-items/{id}' },
  {
    capability: 'issues.create',
    status: 'supported',
    endpoint: 'POST /v1/cloud-projects/{id}/loop-items',
  },
  { capability: 'issues.update', status: 'supported', endpoint: 'PATCH /v1/loop-items/{id}' },
  {
    capability: 'issues.assign',
    status: 'supported',
    endpoint:
      'POST /v1/cloud-projects/{id}/loop-items/{issueId}/assign or PATCH /v1/loop-items/{issueId}',
  },
  {
    capability: 'issues.approveRun',
    status: 'supported',
    endpoint: 'POST /v1/cloud-projects/{id}/loop-items/{issueId}/approve',
  },
  {
    capability: 'issues.rejectRun',
    status: 'supported',
    endpoint: 'POST /v1/cloud-projects/{id}/loop-items/{issueId}/reject',
  },
  { capability: 'issues.archive', status: 'supported', endpoint: 'DELETE /v1/loop-items/{id}' },
  {
    capability: 'issues.reorder',
    status: 'supported',
    endpoint: 'POST /v1/cloud-projects/{id}/loop-items/reorder',
  },
  {
    capability: 'issues.markRead',
    status: 'supported',
    endpoint: 'POST /v1/loop-items/{id}/read',
  },
  {
    capability: 'comments.list',
    status: 'supported',
    endpoint: 'GET /v1/loop-items/{id}/comments',
  },
  {
    capability: 'comments.create',
    status: 'supported',
    endpoint: 'POST /v1/loop-items/{id}/comments',
  },
  {
    capability: 'attachments.list',
    status: 'supported',
    endpoint: 'GET /v1/loop-items/{id}/attachments',
  },
  {
    capability: 'attachments.listProjectTaskAttachments',
    status: 'supported',
    endpoint: 'GET /v1/cloud-projects/{id}/task-attachments',
  },
  {
    capability: 'attachments.upload',
    status: 'supported',
    endpoint: 'POST /v1/loop-items/{id}/attachments',
  },
  {
    capability: 'attachments.importContexts',
    status: 'supported',
    endpoint: 'POST /v1/loop-items/{id}/attachments/import-contexts',
  },
  {
    capability: 'attachments.access',
    status: 'supported',
    endpoint: 'GET /v1/loop-item-attachments/{id}/access',
  },
  {
    capability: 'attachments.read',
    status: 'supported',
    endpoint: 'GET /v1/loop-item-attachments/{id}/content',
  },
  {
    capability: 'attachments.remove',
    status: 'supported',
    endpoint: 'DELETE /v1/loop-item-attachments/{id}',
  },
  {
    capability: 'collaborators.list',
    status: 'supported',
    endpoint: 'GET /v1/loop-items/{id}/collaborators',
  },
  {
    capability: 'collaborators.add',
    status: 'supported',
    endpoint: 'POST /v1/loop-items/{id}/collaborators',
  },
  {
    capability: 'collaborators.remove',
    status: 'supported',
    endpoint: 'DELETE /v1/loop-items/{id}/collaborators/{userId}',
  },
  {
    capability: 'taskBindings.list',
    status: 'supported',
    endpoint: 'GET /v1/loop-items/{id}/tasks',
  },
  {
    capability: 'workflowPlans.get',
    status: 'supported',
    endpoint: 'GET /v1/loop-items/{id}/workflow-plan',
  },
  {
    capability: 'workflowPlans.approve',
    status: 'supported',
    endpoint: 'POST /v1/loop-items/{id}/workflow-plan/approve',
  },
  {
    capability: 'workflowPlans.approveReview',
    status: 'supported',
    endpoint: 'POST /v1/loop-items/{id}/workflow-plan/review',
  },
  {
    capability: 'workflowPlans.pause',
    status: 'supported',
    endpoint: 'POST /v1/loop-items/{id}/workflow-plan/pause',
  },
  {
    capability: 'workflowPlans.resume',
    status: 'supported',
    endpoint: 'POST /v1/loop-items/{id}/workflow-plan/resume',
  },
  {
    capability: 'workflowPlans.replan',
    status: 'supported',
    endpoint: 'POST /v1/loop-items/{id}/workflow-plan/replan',
  },
  {
    capability: 'workflowPlans.decideNode',
    status: 'supported',
    endpoint: 'POST /v1/loop-items/{id}/workflow-nodes/{nodeId}/decision',
  },
  {
    capability: 'workflowPlans.getStageContext',
    status: 'supported',
    endpoint: 'GET /v1/loop-items/{id}/workflow-nodes/{nodeId}/input-context',
  },
  {
    capability: 'members.list',
    status: 'supported',
    endpoint: 'GET /v1/cloud-projects/{id}/members',
  },
  { capability: 'members.searchUsers', status: 'supported', endpoint: 'GET /users/search' },
  {
    capability: 'members.add',
    status: 'supported',
    endpoint: 'POST /v1/cloud-projects/{id}/members',
  },
  {
    capability: 'members.update',
    status: 'supported',
    endpoint: 'PATCH /v1/cloud-projects/{id}/members/{userId}',
  },
  {
    capability: 'members.remove',
    status: 'supported',
    endpoint: 'DELETE /v1/cloud-projects/{id}/members/{userId}',
  },
  {
    capability: 'files.list',
    status: 'supported',
    endpoint: 'GET /v1/cloud-projects/{id}/files',
  },
  {
    capability: 'files.listDeliveryFiles',
    status: 'supported',
    endpoint: 'GET /v1/cloud-projects/{id}/delivery-files',
  },
  {
    capability: 'files.createFolder',
    status: 'supported',
    endpoint: 'POST /v1/cloud-projects/{id}/folders',
  },
  {
    capability: 'files.upload',
    status: 'supported',
    endpoint: 'POST /v1/cloud-projects/{id}/files',
  },
  {
    capability: 'files.access',
    status: 'supported',
    endpoint: 'GET /v1/cloud-projects/files/{id}/access',
  },
  {
    capability: 'files.read',
    status: 'supported',
    endpoint: 'GET /v1/cloud-projects/files/{id}/content',
  },
  {
    capability: 'files.move',
    status: 'supported',
    endpoint: 'PATCH /v1/cloud-projects/files/{id}',
  },
  {
    capability: 'files.remove',
    status: 'supported',
    endpoint: 'DELETE /v1/cloud-projects/files/{id}',
  },
  {
    capability: 'files.accessDeliveryFile',
    status: 'supported',
    endpoint: 'GET /v1/delivery-assets/{id}/access',
  },
  {
    capability: 'files.readDeliveryFile',
    status: 'supported',
    endpoint: 'GET /v1/delivery-assets/{id}/content',
  },
  {
    capability: 'deliveries.list',
    status: 'supported',
    endpoint: 'GET /v1/loop-items/{id}/deliveries',
  },
  {
    capability: 'deliveries.get',
    status: 'supported',
    endpoint: 'GET /v1/deliveries/{id}',
  },
  {
    capability: 'deliveries.create',
    status: 'supported',
    endpoint: 'POST /v1/loop-items/{id}/deliveries',
  },
  {
    capability: 'deliveries.addAsset',
    status: 'supported',
    endpoint: 'POST /v1/deliveries/{id}/assets',
  },
  {
    capability: 'deliveries.finalize',
    status: 'supported',
    endpoint: 'POST /v1/deliveries/{id}/finalize',
  },
  {
    capability: 'deliveries.discardDraft',
    status: 'supported',
    endpoint: 'DELETE /v1/deliveries/{id}',
  },
  {
    capability: 'executions.list',
    status: 'supported',
    endpoint: 'GET /v1/cloud-projects/{id}/executions',
  },
  {
    capability: 'executions.stop',
    status: 'supported',
    endpoint: 'POST /v1/cloud-projects/{id}/executions/{executionId}/stop',
  },
  {
    capability: 'automations.list',
    status: 'supported',
    endpoint: 'GET /v1/cloud-projects/{id}/automations',
  },
  {
    capability: 'automations.create',
    status: 'supported',
    endpoint: 'POST /v1/cloud-projects/{id}/automations',
  },
  {
    capability: 'automations.migrateWorkflow',
    status: 'supported',
    endpoint: 'POST /v1/cloud-projects/{id}/automations/migrate-workflow',
  },
  {
    capability: 'automations.update',
    status: 'supported',
    endpoint: 'PATCH /v1/cloud-projects/{id}/automations/{automationId}',
  },
  {
    capability: 'automations.remove',
    status: 'supported',
    endpoint: 'DELETE /v1/cloud-projects/{id}/automations/{automationId}',
  },
  {
    capability: 'automations.runNow',
    status: 'supported',
    endpoint: 'POST /v1/cloud-projects/{id}/automations/{automationId}/run',
  },
  {
    capability: 'automations.runWorkflowNode',
    status: 'supported',
    endpoint: 'POST /v1/cloud-projects/{id}/loop-items/{issueId}/workflow-nodes/{nodeId}/run',
  },
  {
    capability: 'automations.listRuns',
    status: 'supported',
    endpoint: 'GET /v1/cloud-projects/{id}/automations/{automationId}/runs',
  },
  {
    capability: 'automations.cancelRun',
    status: 'supported',
    endpoint: 'POST /v1/cloud-projects/{id}/automation-runs/{runId}/cancel',
  },
  {
    capability: 'automations.retryRun',
    status: 'supported',
    endpoint: 'POST /v1/cloud-projects/{id}/automation-runs/{runId}/retry',
  },
  {
    capability: 'incomingHooks.catalog',
    status: 'supported',
    endpoint: 'GET /v1/cloud-projects/event-sources/catalog',
  },
  {
    capability: 'incomingHooks.list',
    status: 'supported',
    endpoint: 'GET /v1/cloud-projects/{id}/incoming-hooks',
  },
  {
    capability: 'incomingHooks.create',
    status: 'supported',
    endpoint: 'POST /v1/cloud-projects/{id}/incoming-hooks',
  },
  {
    capability: 'incomingHooks.update',
    status: 'supported',
    endpoint: 'PATCH /v1/cloud-projects/{id}/incoming-hooks/{hookId}',
  },
  {
    capability: 'incomingHooks.rotate',
    status: 'supported',
    endpoint: 'POST /v1/cloud-projects/{id}/incoming-hooks/{hookId}/rotate',
  },
  {
    capability: 'incomingHooks.remove',
    status: 'supported',
    endpoint: 'DELETE /v1/cloud-projects/{id}/incoming-hooks/{hookId}',
  },
  {
    capability: 'incomingHooks.listEvents',
    status: 'supported',
    endpoint: 'GET /v1/cloud-projects/{id}/incoming-hooks/{hookId}/events',
  },
  {
    capability: 'runtimeProfiles.list',
    status: 'supported',
    endpoint: 'GET /v1/runtime-profiles',
  },
  {
    capability: 'runtimeProfiles.create',
    status: 'supported',
    endpoint: 'POST /v1/runtime-profiles',
  },
  {
    capability: 'runtimeProfiles.update',
    status: 'supported',
    endpoint: 'PATCH /v1/runtime-profiles/{profileId}',
  },
  {
    capability: 'runtimeProfiles.remove',
    status: 'supported',
    endpoint: 'DELETE /v1/runtime-profiles/{profileId}',
  },
  {
    capability: 'runtimeProfiles.getProjectDefault',
    status: 'supported',
    endpoint: 'GET /v1/cloud-projects/{id}/runtime-default',
  },
  {
    capability: 'runtimeProfiles.setProjectDefault',
    status: 'supported',
    endpoint: 'PUT /v1/cloud-projects/{id}/runtime-default',
  },
  {
    capability: 'runtimeProfiles.selectExecution',
    status: 'supported',
    endpoint: 'PUT /v1/cloud-projects/{id}/executions/{executionId}/runtime',
  },
  {
    capability: 'automationExecutionCatalog.load',
    status: 'supported',
    endpoint: 'GET /devices + GET /models/unified + GET /v1/runtime-profiles',
  },
  {
    capability: 'automationExecutionCatalog.loadPlugins',
    status: 'supported',
    endpoint: 'GET /plugins/installed',
  },
  {
    capability: 'agents.list',
    status: 'supported',
    endpoint: 'GET /v1/cloud-projects/{id}/chat-agents',
  },
  {
    capability: 'agents.create',
    status: 'supported',
    endpoint: 'POST /v1/cloud-projects/{id}/chat-agents',
  },
  {
    capability: 'agents.update',
    status: 'supported',
    endpoint: 'PATCH /v1/cloud-projects/{id}/chat-agents/{agentId}',
  },
] as const

function encoded(value: string | number): string {
  return encodeURIComponent(String(value))
}

function snakeCaseKey(key: string): string {
  return key.replace(/[A-Z]/g, letter => `_${letter.toLowerCase()}`)
}

function keysToSnakeCase(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(keysToSnakeCase)
  const isBlob = typeof Blob !== 'undefined' && value instanceof Blob
  const isFile = typeof File !== 'undefined' && value instanceof File
  if (!value || typeof value !== 'object' || isBlob || isFile) {
    return value
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, nested]) => [snakeCaseKey(key), keysToSnakeCase(nested)])
  )
}

function mapBinaryAccess(row: Record<string, unknown>): WorkspaceBinaryAccess {
  return {
    url: String(row.url ?? ''),
    expiresInSeconds: Number(row.expires_in_seconds ?? 0),
  }
}

function recordValue(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function stringRecord(value: unknown): Record<string, string> {
  return Object.fromEntries(
    Object.entries(recordValue(value)).flatMap(([key, item]) =>
      typeof item === 'string' ? [[key, item]] : []
    )
  )
}

function mapAutomationExecutionCatalog(
  devicesResponse: unknown,
  modelsResponse: unknown,
  runtimeProfilesResponse: unknown
): WorkspaceAutomationExecutionCatalog {
  const devices = Array.isArray(recordValue(devicesResponse).items)
    ? (recordValue(devicesResponse).items as Array<Record<string, unknown>>)
    : []
  const models = Array.isArray(recordValue(modelsResponse).data)
    ? (recordValue(modelsResponse).data as Array<Record<string, unknown>>)
    : []
  const runtimeProfiles = Array.isArray(runtimeProfilesResponse)
    ? (runtimeProfilesResponse as Array<Record<string, unknown>>)
    : []

  return {
    environments: devices
      .filter(device => device.status !== 'offline')
      .map(device => ({
        deviceId: String(device.device_id ?? ''),
        label: String(device.name ?? device.device_id ?? ''),
        executionEnvironment:
          device.device_type === 'local' ? ('local' as const) : ('cloud' as const),
      }))
      .filter(environment => environment.deviceId),
    models: models
      .filter(model => model.isActive !== false && model.modelCategoryType !== 'image')
      .map(model => ({
        name: String(model.name ?? ''),
        label: String(model.displayName ?? model.name ?? ''),
        type: ['public', 'user', 'group', 'runtime'].includes(String(model.type))
          ? (model.type as 'public' | 'user' | 'group' | 'runtime')
          : null,
        options: {
          ...stringRecord(model.config),
          ...(typeof model.namespace === 'string'
            ? { weworkCloudModelNamespace: model.namespace }
            : {}),
          ...(typeof model.resourceUserId === 'number'
            ? { weworkCloudModelResourceUserId: String(model.resourceUserId) }
            : {}),
        },
      }))
      .filter(model => model.name),
    runtimeProfiles: runtimeProfiles
      .map(profile => ({
        ...profile,
        id: String(profile.id ?? ''),
        name: String(profile.name ?? ''),
        executionEnvironment:
          profile.executionEnvironment === 'local' ? ('local' as const) : ('cloud' as const),
        executionDeviceId: String(profile.executionDeviceId ?? ''),
        model: String(profile.model ?? ''),
        modelType: ['public', 'user', 'group', 'runtime'].includes(String(profile.modelType))
          ? (profile.modelType as 'public' | 'user' | 'group' | 'runtime')
          : null,
        modelOptions: stringRecord(profile.modelOptions),
        status: profile.status === 'archived' ? ('archived' as const) : ('active' as const),
        version: Number(profile.version ?? 1),
      }))
      .filter(profile => profile.id && profile.status === 'active'),
    plugins: [],
  }
}

function mapAutomationPlugins(response: unknown): WorkspaceAutomationPlugin[] {
  const items = Array.isArray(recordValue(response).items)
    ? (recordValue(response).items as InstalledPluginCatalogItem[])
    : []
  return buildInstalledPluginProjectCatalog(items).map(reference => ({
    id: reference.id,
    label: reference.displayName,
    reference: { ...reference },
  }))
}

async function defaultGetBlob(endpoint: string): Promise<Blob> {
  const token = getToken()
  const response = await fetch(`${getApiBaseUrl()}${endpoint}`, {
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
  })
  if (!response.ok) {
    const detail = await response.text()
    throw new ApiError(
      detail || `Binary workspace request failed (${response.status})`,
      response.status
    )
  }
  return response.blob()
}

function createDefaultBinaryTransport(): WebWorkspaceBinaryTransport {
  return { getBlob: defaultGetBlob }
}

export function createWebSharedWorkspaceApi(
  client: WebWorkspaceHttpClient = apiClient,
  binaryTransport: WebWorkspaceBinaryTransport = createDefaultBinaryTransport()
): SharedWorkspaceApi {
  return {
    projects: {
      async list() {
        const response = await client.get<{ items: CollaborationProject[] }>('/v1/cloud-projects')
        return response.items
      },
      get(projectId) {
        return client.get(`/v1/cloud-projects/${encoded(projectId)}`)
      },
      create(input) {
        return client.post('/v1/cloud-projects', keysToSnakeCase(input))
      },
      update(projectId, input) {
        return client.patch(`/v1/cloud-projects/${encoded(projectId)}`, keysToSnakeCase(input))
      },
      archive(projectId, version) {
        return client.delete(`/v1/cloud-projects/${encoded(projectId)}?version=${version}`)
      },
      importMessages(projectId, input) {
        return client.post(
          `/v1/cloud-projects/${encoded(projectId)}/message-imports`,
          keysToSnakeCase(input)
        )
      },
    },
    issues: {
      async list(projectId, filters) {
        const query = new URLSearchParams()
        if (filters?.assigneeType) query.set('assignee_type', filters.assigneeType)
        if (filters?.assigneeId != null) query.set('assignee_id', String(filters.assigneeId))
        if (filters?.executionState) query.set('execution_state', filters.executionState)
        const suffix = query.size ? `?${query.toString()}` : ''
        const response = await client.get<{ items: CollaborationIssue[] }>(
          `/v1/cloud-projects/${encoded(projectId)}/loop-items${suffix}`
        )
        return response.items
      },
      async listPage(projectId, input) {
        const query = new URLSearchParams({
          status: input.status,
          limit: String(input.limit ?? 10),
        })
        if (input.parentId) query.set('parent_id', input.parentId)
        if (input.cursor) query.set('cursor', input.cursor)
        const response = await client.get<{
          items: CollaborationIssue[]
          next_cursor: string | null
          task_bindings: Array<Record<string, unknown>>
        }>(`/v1/cloud-projects/${encoded(projectId)}/loop-item-pages?${query.toString()}`)
        return {
          items: response.items,
          nextCursor: response.next_cursor,
          taskBindings: response.task_bindings.map(binding =>
            mapWorkspaceTaskBindingDto(binding, projectId)
          ),
        }
      },
      async getBoardSnapshot(projectId) {
        const response = await client.get<
          CollaborationBoardSnapshot & {
            task_bindings: Array<Record<string, unknown>>
          }
        >(`/v1/cloud-projects/${encoded(projectId)}/board-snapshot`)
        return {
          items: response.items,
          members: response.members,
          agents: response.agents,
          taskBindings: response.task_bindings.map(binding =>
            mapWorkspaceTaskBindingDto(binding, projectId)
          ),
        }
      },
      get(issueId) {
        return client.get(`/v1/loop-items/${encoded(issueId)}`)
      },
      create(projectId, input) {
        return client.post(
          `/v1/cloud-projects/${encoded(projectId)}/loop-items`,
          keysToSnakeCase(input)
        )
      },
      update(issueId, input) {
        return client.patch(`/v1/loop-items/${encoded(issueId)}`, keysToSnakeCase(input))
      },
      assign(projectId, issueId, input) {
        if (input.assigneeType === 'team') {
          const teamId = Number(input.assigneeId)
          if (!Number.isInteger(teamId) || teamId < 1) {
            throw new TypeError(`Invalid team assignee ID: ${input.assigneeId}`)
          }
          return client.patch(`/v1/loop-items/${encoded(issueId)}`, {
            version: input.version,
            assignee_team_id: teamId,
            notify_assignee: input.notifyAssignee ?? true,
          })
        }
        return client.post(
          `/v1/cloud-projects/${encoded(projectId)}/loop-items/${encoded(issueId)}/assign`,
          keysToSnakeCase(input)
        )
      },
      approveRun(projectId, issueId, version) {
        return client.post(
          `/v1/cloud-projects/${encoded(projectId)}/loop-items/${encoded(issueId)}/approve`,
          { version }
        )
      },
      rejectRun(projectId, issueId, version, reason) {
        return client.post(
          `/v1/cloud-projects/${encoded(projectId)}/loop-items/${encoded(issueId)}/reject`,
          { version, reason: reason ?? null }
        )
      },
      archive(issueId) {
        return client.delete(`/v1/loop-items/${encoded(issueId)}`)
      },
      async reorder(projectId, input) {
        const response = await client.post<{ items: CollaborationIssue[] }>(
          `/v1/cloud-projects/${encoded(projectId)}/loop-items/reorder`,
          {
            parent_id: input.parentId,
            status: input.status,
            item_ids: input.issueIds,
          }
        )
        return response.items
      },
      markRead(issueId) {
        return client.post(`/v1/loop-items/${encoded(issueId)}/read`)
      },
    },
    comments: {
      list(issueId) {
        return client.get(`/v1/loop-items/${encoded(issueId)}/comments`)
      },
      create(issueId, body) {
        return client.post(`/v1/loop-items/${encoded(issueId)}/comments`, { body })
      },
    },
    attachments: {
      list(issueId) {
        return client.get(`/v1/loop-items/${encoded(issueId)}/attachments`)
      },
      async listProjectTaskAttachments(projectId) {
        const response = await client.get<{ items: CollaborationAttachment[] }>(
          `/v1/cloud-projects/${encoded(projectId)}/task-attachments`
        )
        return response.items
      },
      upload(issueId, file) {
        const form = new FormData()
        form.set('file', file, file.name)
        return client.postForm(`/v1/loop-items/${encoded(issueId)}/attachments`, form)
      },
      importContexts(issueId, contextIds) {
        return client.post(`/v1/loop-items/${encoded(issueId)}/attachments/import-contexts`, {
          context_ids: contextIds,
        })
      },
      async access(attachmentId) {
        const response = await client.get<Record<string, unknown>>(
          `/v1/loop-item-attachments/${encoded(attachmentId)}/access`
        )
        return mapBinaryAccess(response)
      },
      read(attachmentId) {
        return binaryTransport.getBlob(`/v1/loop-item-attachments/${encoded(attachmentId)}/content`)
      },
      remove(attachmentId) {
        return client.delete(`/v1/loop-item-attachments/${encoded(attachmentId)}`)
      },
    },
    collaborators: {
      async list(issueId) {
        const response = await client.get<Array<Record<string, unknown>>>(
          `/v1/loop-items/${encoded(issueId)}/collaborators`
        )
        return response.map(mapWorkspaceIssueCollaboratorDto)
      },
      async add(issueId, userId) {
        const response = await client.post<Record<string, unknown>>(
          `/v1/loop-items/${encoded(issueId)}/collaborators`,
          { user_id: userId }
        )
        return mapWorkspaceIssueCollaboratorDto(response)
      },
      remove(issueId, userId) {
        return client.delete(`/v1/loop-items/${encoded(issueId)}/collaborators/${encoded(userId)}`)
      },
    },
    taskBindings: {
      async list(issueId, projectId) {
        const response = await client.get<Array<Record<string, unknown>>>(
          `/v1/loop-items/${encoded(issueId)}/tasks`
        )
        return response.map(binding => mapWorkspaceTaskBindingDto(binding, projectId))
      },
    },
    workflowPlans: {
      async get(issueId) {
        const response = await client.get<Record<string, unknown> | null>(
          `/v1/loop-items/${encoded(issueId)}/workflow-plan`
        )
        return response ? mapWorkspaceWorkflowPlanDto(response) : null
      },
      async approve(issueId) {
        const response = await client.post<Record<string, unknown>>(
          `/v1/loop-items/${encoded(issueId)}/workflow-plan/approve`,
          {}
        )
        return mapWorkspaceWorkflowPlanDto(response)
      },
      async approveReview(issueId) {
        const response = await client.post<Record<string, unknown>>(
          `/v1/loop-items/${encoded(issueId)}/workflow-plan/review`,
          {}
        )
        return mapWorkspaceWorkflowPlanDto(response)
      },
      async pause(issueId) {
        const response = await client.post<Record<string, unknown>>(
          `/v1/loop-items/${encoded(issueId)}/workflow-plan/pause`,
          {}
        )
        return mapWorkspaceWorkflowPlanDto(response)
      },
      async resume(issueId) {
        const response = await client.post<Record<string, unknown>>(
          `/v1/loop-items/${encoded(issueId)}/workflow-plan/resume`,
          {}
        )
        return mapWorkspaceWorkflowPlanDto(response)
      },
      async replan(issueId) {
        const response = await client.post<Record<string, unknown>>(
          `/v1/loop-items/${encoded(issueId)}/workflow-plan/replan`,
          {}
        )
        return mapWorkspaceWorkflowPlanDto(response)
      },
      decideNode(issueId, workflowNodeId, action, reason) {
        return client.post(
          `/v1/loop-items/${encoded(issueId)}/workflow-nodes/${encoded(workflowNodeId)}/decision`,
          { action, reason: reason ?? '' }
        )
      },
      async getStageContext(issueId, workflowNodeId) {
        const response = await client.get<Record<string, unknown>>(
          `/v1/loop-items/${encoded(issueId)}/workflow-nodes/${encoded(workflowNodeId)}/input-context`
        )
        return mapWorkspaceWorkflowStageContextDto(response)
      },
    },
    members: {
      list(projectId) {
        return client.get(`/v1/cloud-projects/${encoded(projectId)}/members`)
      },
      async searchUsers(query) {
        const response = await client.get<{
          users: Array<{ id: number; user_name: string; email?: string | null }>
        }>(`/users/search?q=${encodeURIComponent(query)}&limit=20`)
        return response.users.map(user => ({ ...user, email: user.email ?? null }))
      },
      add(projectId, userId, role = 'Developer') {
        return client.post(`/v1/cloud-projects/${encoded(projectId)}/members`, {
          user_id: userId,
          role,
        })
      },
      update(projectId, userId, input) {
        return client.patch(
          `/v1/cloud-projects/${encoded(projectId)}/members/${encoded(userId)}`,
          keysToSnakeCase(input)
        )
      },
      remove(projectId, userId) {
        return client.delete(`/v1/cloud-projects/${encoded(projectId)}/members/${encoded(userId)}`)
      },
    },
    files: {
      async list(projectId, prefix) {
        const query = prefix ? `?prefix=${encodeURIComponent(prefix)}` : ''
        const response = await client.get<{ items: CollaborationFile[] }>(
          `/v1/cloud-projects/${encoded(projectId)}/files${query}`
        )
        return response.items
      },
      async listDeliveryFiles(projectId) {
        const response = await client.get<{
          items: Array<Record<string, unknown>>
        }>(`/v1/cloud-projects/${encoded(projectId)}/delivery-files`)
        return response.items.map<WorkspaceDeliveryFile>(row => ({
          assetId: String(row.asset_id),
          deliveryId: String(row.delivery_id),
          issueId: String(row.loop_item_id),
          issueTitle: String(row.loop_item_title ?? ''),
          relativePath: String(row.relative_path ?? ''),
          displayName: String(row.display_name ?? ''),
          contentType: row.content_type == null ? null : String(row.content_type),
          sizeBytes: Number(row.size_bytes),
          deliveredAt: String(row.delivered_at ?? ''),
          issuePath: Array.isArray(row.loop_item_path)
            ? row.loop_item_path.map(item => {
                const pathItem = item as Record<string, unknown>
                return { id: String(pathItem.id), title: String(pathItem.title ?? '') }
              })
            : [],
        }))
      },
      createFolder(projectId, path) {
        return client.post(`/v1/cloud-projects/${encoded(projectId)}/folders`, { path })
      },
      upload(projectId, file, path = file.name) {
        const form = new FormData()
        form.set('file', file, file.name)
        form.set('path', path)
        return client.postForm(`/v1/cloud-projects/${encoded(projectId)}/files`, form)
      },
      async access(fileId) {
        return mapBinaryAccess(
          await client.get(`/v1/cloud-projects/files/${encoded(fileId)}/access`)
        )
      },
      read(fileId) {
        return binaryTransport.getBlob(`/v1/cloud-projects/files/${encoded(fileId)}/content`)
      },
      move(fileId, path, version) {
        return client.patch(`/v1/cloud-projects/files/${encoded(fileId)}`, { path, version })
      },
      remove(fileId, recursive = false) {
        return client.delete(
          `/v1/cloud-projects/files/${encoded(fileId)}${recursive ? '?recursive=true' : ''}`
        )
      },
      async accessDeliveryFile(assetId) {
        return mapBinaryAccess(await client.get(`/v1/delivery-assets/${encoded(assetId)}/access`))
      },
      readDeliveryFile(assetId) {
        return binaryTransport.getBlob(`/v1/delivery-assets/${encoded(assetId)}/content`)
      },
    },
    deliveries: {
      async list(issueId) {
        const response = await client.get<{ items: Array<Record<string, unknown>> }>(
          `/v1/loop-items/${encoded(issueId)}/deliveries`
        )
        return response.items.map(mapWorkspaceDeliveryDto)
      },
      async get(deliveryId) {
        return mapWorkspaceDeliveryDto(await client.get(`/v1/deliveries/${encoded(deliveryId)}`))
      },
      async create(issueId, input) {
        return mapWorkspaceDeliveryDto(
          await client.post(`/v1/loop-items/${encoded(issueId)}/deliveries`, keysToSnakeCase(input))
        )
      },
      async addAsset(deliveryId, file, relativePath) {
        const form = new FormData()
        form.set('file', file, file.name)
        form.set('relative_path', relativePath)
        return mapWorkspaceDeliveryAssetDto(
          await client.postForm(`/v1/deliveries/${encoded(deliveryId)}/assets`, form)
        )
      },
      async finalize(deliveryId, input) {
        return mapWorkspaceDeliveryDto(
          await client.post(`/v1/deliveries/${encoded(deliveryId)}/finalize`, {
            fulfillments: input.fulfillments.map(keysToSnakeCase),
          })
        )
      },
      discardDraft(deliveryId) {
        return client.delete(`/v1/deliveries/${encoded(deliveryId)}`)
      },
    },
    executions: {
      async list(projectId, filters) {
        const query = new URLSearchParams()
        if (filters?.agentId) query.set('agent_id', filters.agentId)
        if (filters?.status) query.set('status', filters.status)
        const suffix = query.size ? `?${query.toString()}` : ''
        const response = await client.get<{ items: Array<Record<string, unknown>> }>(
          `/v1/cloud-projects/${encoded(projectId)}/executions${suffix}`
        )
        return response.items.map(mapCollaborationExecutionDto)
      },
      async stop(projectId, executionId) {
        const response = await client.post<Record<string, unknown>>(
          `/v1/cloud-projects/${encoded(projectId)}/executions/${encoded(executionId)}/stop`
        )
        return { id: Number(response.id), status: String(response.status ?? '') }
      },
    },
    automations: {
      list(projectId) {
        return client.get(`/v1/cloud-projects/${encoded(projectId)}/automations`)
      },
      create(projectId, input) {
        return client.post(
          `/v1/cloud-projects/${encoded(projectId)}/automations`,
          keysToSnakeCase(input)
        )
      },
      migrateWorkflow(projectId, input) {
        return client.post(
          `/v1/cloud-projects/${encoded(projectId)}/automations/migrate-workflow`,
          keysToSnakeCase(input)
        )
      },
      update(projectId, automationId, input) {
        return client.patch(
          `/v1/cloud-projects/${encoded(projectId)}/automations/${encoded(automationId)}`,
          keysToSnakeCase(input)
        )
      },
      remove(projectId, automationId) {
        return client.delete(
          `/v1/cloud-projects/${encoded(projectId)}/automations/${encoded(automationId)}`
        )
      },
      runNow(projectId, automationId) {
        return client.post(
          `/v1/cloud-projects/${encoded(projectId)}/automations/${encoded(automationId)}/run`
        )
      },
      runWorkflowNode(projectId, issueId, workflowNodeId, automationId) {
        const query = `automation_id=${encodeURIComponent(automationId)}`
        return client.post(
          `/v1/cloud-projects/${encoded(projectId)}/loop-items/${encoded(issueId)}/workflow-nodes/${encoded(workflowNodeId)}/run?${query}`
        )
      },
      listRuns(projectId, automationId) {
        return client.get(
          `/v1/cloud-projects/${encoded(projectId)}/automations/${encoded(automationId)}/runs`
        )
      },
      cancelRun(projectId, runId) {
        return client.post(
          `/v1/cloud-projects/${encoded(projectId)}/automation-runs/${encoded(runId)}/cancel`
        )
      },
      retryRun(projectId, runId) {
        return client.post(
          `/v1/cloud-projects/${encoded(projectId)}/automation-runs/${encoded(runId)}/retry`
        )
      },
    },
    incomingHooks: {
      catalog() {
        return client.get('/v1/cloud-projects/event-sources/catalog')
      },
      list(projectId) {
        return client.get(`/v1/cloud-projects/${encoded(projectId)}/incoming-hooks`)
      },
      create(projectId, input) {
        return client.post(
          `/v1/cloud-projects/${encoded(projectId)}/incoming-hooks`,
          keysToSnakeCase(input)
        )
      },
      update(projectId, hookId, input) {
        return client.patch(
          `/v1/cloud-projects/${encoded(projectId)}/incoming-hooks/${encoded(hookId)}`,
          keysToSnakeCase(input)
        )
      },
      rotate(projectId, hookId) {
        return client.post(
          `/v1/cloud-projects/${encoded(projectId)}/incoming-hooks/${encoded(hookId)}/rotate`
        )
      },
      remove(projectId, hookId) {
        return client.delete(
          `/v1/cloud-projects/${encoded(projectId)}/incoming-hooks/${encoded(hookId)}`
        )
      },
      listEvents(projectId, hookId, limit = 50) {
        return client.get(
          `/v1/cloud-projects/${encoded(projectId)}/incoming-hooks/${encoded(hookId)}/events?limit=${limit}`
        )
      },
    },
    automationExecutionCatalog: {
      async load() {
        const [devices, models, runtimeProfiles] = await Promise.all([
          client.get('/devices'),
          client.get('/models/unified?include_config=true&model_category_type=llm'),
          client.get('/v1/runtime-profiles'),
        ])
        return mapAutomationExecutionCatalog(devices, models, runtimeProfiles)
      },
      async loadPlugins(_projectId, deviceIds) {
        const deviceQuery = deviceIds.length === 1 ? `?device_id=${encoded(deviceIds[0])}` : ''
        const response = await client.get(`/plugins/installed${deviceQuery}`)
        return mapAutomationPlugins(response)
      },
    },
    runtimeProfiles: {
      list() {
        return client.get('/v1/runtime-profiles')
      },
      create(input) {
        return client.post('/v1/runtime-profiles', keysToSnakeCase(input))
      },
      update(profileId, input) {
        return client.patch(`/v1/runtime-profiles/${encoded(profileId)}`, keysToSnakeCase(input))
      },
      remove(profileId) {
        return client.delete(`/v1/runtime-profiles/${encoded(profileId)}`)
      },
      getProjectDefault(projectId) {
        return client.get(`/v1/cloud-projects/${encoded(projectId)}/runtime-default`)
      },
      setProjectDefault(projectId, runtimeProfileId) {
        return client.put(`/v1/cloud-projects/${encoded(projectId)}/runtime-default`, {
          runtimeProfileId,
        })
      },
      async selectExecution(projectId, executionId, runtimeProfileId, version) {
        const response = await client.put<Record<string, unknown>>(
          `/v1/cloud-projects/${encoded(projectId)}/executions/${encoded(executionId)}/runtime`,
          { runtimeProfileId, version }
        )
        return mapCollaborationExecutionDto(response)
      },
    },
    agents: {
      list(projectId) {
        return client.get(`/v1/cloud-projects/${encoded(projectId)}/chat-agents`)
      },
      create(projectId, input) {
        return client.post(
          `/v1/cloud-projects/${encoded(projectId)}/chat-agents`,
          keysToSnakeCase(input)
        )
      },
      update(projectId, agentId, input) {
        return client.patch(
          `/v1/cloud-projects/${encoded(projectId)}/chat-agents/${encoded(agentId)}`,
          keysToSnakeCase(input)
        )
      },
    },
  }
}
