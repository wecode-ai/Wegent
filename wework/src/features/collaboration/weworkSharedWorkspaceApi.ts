// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import {
  createSharedWorkspaceHttpApi,
  mapCollaborationExecutionDto,
  mapWorkspaceDeliveryAssetDto,
  mapWorkspaceDeliveryDto,
  mapWorkspaceIssueCollaboratorDto,
  mapWorkspaceTaskBindingDto,
  mapWorkspaceWorkflowPlanDto,
  mapWorkspaceWorkflowStageContextDto,
} from '@wegent/collaboration'
import type {
  CollaborationAgent,
  CollaborationAttachment,
  CollaborationIssue,
  CollaborationMember,
  CollaborationProject,
  CollaborationUser,
  SharedWorkspaceAutomationApi,
  SharedWorkspaceApi,
  WeworkWorkspaceRuntimePort,
  WorkspaceBoardSnapshot,
  WorkspaceDeliveryFile,
  WorkspaceAutomationRule,
  WorkspaceAutomationRun,
  WorkspaceIncomingHook,
  WorkspaceRuntimeProfile,
  WorkspaceRuntimeTaskAddress,
  WorkspaceMyWorkItem,
} from '@wegent/collaboration'
import type {
  CloudLoopItem,
  CloudProject,
  ProjectBoardSnapshot,
  ProjectDeliveryFile,
  createDeliveryApi,
} from '@/api/deliveries'
import type { HttpClient } from '@/api/http'
import type { createProjectAutomationApi } from '@/api/projectAutomations'
import type { createProjectIncomingHookApi } from '@/api/projectIncomingHooks'
import type { createRuntimeProfileApi } from '@/api/runtimeProfiles'
import type { Attachment } from '@/types/api'
import type { RuntimeTaskAddress } from '@/types/api'

type DeliveryApi = ReturnType<typeof createDeliveryApi>
type ProjectAutomationApi = ReturnType<typeof createProjectAutomationApi>
type ProjectIncomingHookApi = ReturnType<typeof createProjectIncomingHookApi>
type RuntimeProfileApi = ReturnType<typeof createRuntimeProfileApi>

type ProjectMethod = 'list' | 'create' | 'update' | 'archive'

export type WeworkAutomationSharedWorkspaceApi = SharedWorkspaceAutomationApi

export interface WeworkDeliverySharedWorkspaceApi {
  projects: Pick<SharedWorkspaceApi['projects'], ProjectMethod>
  myWork: NonNullable<SharedWorkspaceApi['myWork']>
  issues: SharedWorkspaceApi['issues']
  attachments: SharedWorkspaceApi['attachments']
  collaborators: SharedWorkspaceApi['collaborators']
  taskBindings: SharedWorkspaceApi['taskBindings']
  workflowPlans: SharedWorkspaceApi['workflowPlans']
  members: SharedWorkspaceApi['members']
  files: SharedWorkspaceApi['files']
  deliveries: SharedWorkspaceApi['deliveries']
  executions: SharedWorkspaceApi['executions']
}

export const WEWORK_DELIVERY_SHARED_WORKSPACE_METHODS = {
  projects: ['list', 'create', 'update', 'archive'],
  myWork: ['list'],
  issues: [
    'list',
    'listPage',
    'getBoardSnapshot',
    'get',
    'create',
    'update',
    'assign',
    'approveRun',
    'rejectRun',
    'archive',
    'reorder',
    'markRead',
  ],
  attachments: [
    'list',
    'listProjectTaskAttachments',
    'upload',
    'importContexts',
    'access',
    'read',
    'download',
    'remove',
  ],
  collaborators: ['list', 'add', 'remove'],
  taskBindings: ['list'],
  workflowPlans: [
    'get',
    'approve',
    'approveReview',
    'pause',
    'resume',
    'replan',
    'decideNode',
    'getStageContext',
  ],
  members: ['list', 'searchUsers', 'add', 'update', 'remove'],
  files: [
    'list',
    'listDeliveryFiles',
    'createFolder',
    'upload',
    'access',
    'read',
    'move',
    'remove',
    'accessDeliveryFile',
    'readDeliveryFile',
  ],
  deliveries: ['list', 'get', 'create', 'addAsset', 'finalize', 'discardDraft'],
  executions: ['list', 'stop'],
} as const satisfies {
  [Domain in keyof WeworkDeliverySharedWorkspaceApi]: readonly (keyof WeworkDeliverySharedWorkspaceApi[Domain])[]
}

export const WEWORK_DELIVERY_SHARED_WORKSPACE_MISSING_METHODS = {
  projects: ['get', 'importMessages'],
  comments: ['list', 'create'],
  automations: [
    'list',
    'create',
    'migrateWorkflow',
    'update',
    'remove',
    'runNow',
    'runWorkflowNode',
    'listRuns',
    'cancelRun',
    'retryRun',
  ],
  incomingHooks: ['catalog', 'list', 'create', 'update', 'rotate', 'remove', 'listEvents'],
  runtimeProfiles: [
    'list',
    'create',
    'update',
    'remove',
    'getProjectDefault',
    'setProjectDefault',
    'selectExecution',
  ],
  agents: ['list', 'create', 'update'],
} as const satisfies {
  projects: readonly (keyof SharedWorkspaceApi['projects'])[]
  comments: readonly (keyof SharedWorkspaceApi['comments'])[]
  automations: readonly (keyof SharedWorkspaceApi['automations'])[]
  incomingHooks: readonly (keyof SharedWorkspaceApi['incomingHooks'])[]
  runtimeProfiles: readonly (keyof SharedWorkspaceApi['runtimeProfiles'])[]
  agents: readonly (keyof SharedWorkspaceApi['agents'])[]
}

export const WEWORK_SHARED_WORKSPACE_MISSING_METHODS = [] as const

export interface WeworkSharedWorkspaceApiDependencies {
  client: HttpClient
  deliveryApi: DeliveryApi
  projectAutomationApi: ProjectAutomationApi
  projectIncomingHookApi: ProjectIncomingHookApi
  runtimeProfileApi: RuntimeProfileApi
}

function toProject(project: CloudProject): CollaborationProject {
  return {
    ...project,
    id: String(project.id),
  }
}

function toIssue(issue: CloudLoopItem): CollaborationIssue {
  return {
    ...issue,
    id: String(issue.id),
    cloud_project_id: String(issue.cloud_project_id),
  }
}

function toRuntimeTaskAddress(task: WorkspaceRuntimeTaskAddress): RuntimeTaskAddress {
  return {
    deviceId: task.deviceId,
    taskId: task.taskId,
    ...(task.backendTaskId == null ? {} : { backendTaskId: task.backendTaskId }),
    ...(task.modelSelection == null
      ? {}
      : { runtimeHandle: { modelSelection: task.modelSelection } }),
  } as RuntimeTaskAddress
}

function toMyWorkItem(
  item: Awaited<ReturnType<DeliveryApi['listMyWork']>>['items'][number]
): WorkspaceMyWorkItem {
  return {
    ...item,
    ...toIssue(item),
  }
}

function toAttachment(
  attachment: Awaited<ReturnType<DeliveryApi['listLoopItemAttachments']>>[number]
): CollaborationAttachment {
  return {
    ...attachment,
    id: String(attachment.id),
    loop_item_id: String(attachment.loop_item_id),
    size_bytes: Number(attachment.size_bytes),
    created_by_user_id: Number(attachment.created_by_user_id),
  }
}

function toMember(
  member: Awaited<ReturnType<DeliveryApi['listCloudProjectMembers']>>[number]
): CollaborationMember {
  return {
    ...member,
    id: Number(member.id),
    user_id: Number(member.user_id),
  }
}

function toUser(
  user: Awaited<ReturnType<DeliveryApi['searchCloudProjectUsers']>>['users'][number]
): CollaborationUser {
  return {
    ...user,
    id: Number(user.id),
  }
}

function toAgent(agent: ProjectBoardSnapshot['agents'][number]): CollaborationAgent {
  return {
    ...agent,
    id: String(agent.id),
  }
}

function withoutUndefined<T extends Record<string, unknown>>(values: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(values).filter(([, value]) => value !== undefined)
  ) as Partial<T>
}

function toBoardSnapshot(
  snapshot: ProjectBoardSnapshot,
  contextProjectId: string
): WorkspaceBoardSnapshot {
  return {
    items: snapshot.items.map(toIssue),
    members: snapshot.members.map(toMember),
    agents: snapshot.agents.map(toAgent),
    taskBindings: snapshot.task_bindings.map(binding =>
      mapWorkspaceTaskBindingDto(binding, contextProjectId)
    ),
  }
}

function toAutomationRule(
  rule: Awaited<ReturnType<ProjectAutomationApi['create']>>
): WorkspaceAutomationRule {
  return { ...rule }
}

function toAutomationRun(
  run: Awaited<ReturnType<ProjectAutomationApi['runNow']>>
): WorkspaceAutomationRun {
  return { ...run }
}

function toIncomingHook(
  hook: Awaited<ReturnType<ProjectIncomingHookApi['create']>>
): WorkspaceIncomingHook {
  return { ...hook }
}

function createWeworkAutomationsApi(
  projectAutomationApi: ProjectAutomationApi
): NonNullable<SharedWorkspaceAutomationApi['automations']> {
  return {
    async list(projectId) {
      return (await projectAutomationApi.list(projectId)).map(toAutomationRule)
    },
    async create(projectId, input) {
      return toAutomationRule(
        await projectAutomationApi.create(
          projectId,
          input as unknown as Parameters<ProjectAutomationApi['create']>[1]
        )
      )
    },
    async migrateWorkflow(projectId, input) {
      const result = await projectAutomationApi.migrateWorkflow(
        projectId,
        input as unknown as Parameters<ProjectAutomationApi['migrateWorkflow']>[1]
      )
      return {
        automation: toAutomationRule(result.automation),
        projectVersion: result.projectVersion,
      }
    },
    async update(projectId, automationId, input) {
      return toAutomationRule(
        await projectAutomationApi.update(
          projectId,
          automationId,
          input as unknown as Parameters<ProjectAutomationApi['update']>[2]
        )
      )
    },
    remove: projectAutomationApi.delete,
    async runNow(projectId, automationId) {
      return toAutomationRun(await projectAutomationApi.runNow(projectId, automationId))
    },
    async listRuns(projectId, automationId) {
      return (await projectAutomationApi.listRuns(projectId, automationId)).map(toAutomationRun)
    },
  }
}

function createWeworkIncomingHooksApi(
  projectIncomingHookApi: ProjectIncomingHookApi
): NonNullable<SharedWorkspaceAutomationApi['incomingHooks']> {
  return {
    async catalog() {
      return (await projectIncomingHookApi.catalog()).map(item => ({ ...item }))
    },
    async list(projectId) {
      return (await projectIncomingHookApi.list(projectId)).map(toIncomingHook)
    },
    async create(projectId, input) {
      return toIncomingHook(
        await projectIncomingHookApi.create(
          projectId,
          input as unknown as Parameters<ProjectIncomingHookApi['create']>[1]
        )
      )
    },
    async update(projectId, hookId, input) {
      return toIncomingHook(
        await projectIncomingHookApi.update(
          projectId,
          hookId,
          input as unknown as Parameters<ProjectIncomingHookApi['update']>[2]
        )
      )
    },
    async rotate(projectId, hookId) {
      return toIncomingHook(await projectIncomingHookApi.rotate(projectId, hookId))
    },
    remove: projectIncomingHookApi.remove,
  }
}

function toRuntimeProfile(
  profile: Awaited<ReturnType<RuntimeProfileApi['create']>>
): WorkspaceRuntimeProfile {
  return { ...profile }
}

function toDeliveryFile(file: ProjectDeliveryFile): WorkspaceDeliveryFile {
  return {
    assetId: file.asset_id,
    deliveryId: file.delivery_id,
    issueId: file.loop_item_id,
    issueTitle: file.loop_item_title,
    relativePath: file.relative_path,
    displayName: file.display_name,
    contentType: file.content_type,
    sizeBytes: file.size_bytes,
    deliveredAt: file.delivered_at,
    issuePath: file.loop_item_path,
  }
}

function isWithinPrefix(path: string, prefix: string): boolean {
  const normalizedPrefix = prefix.replace(/^\/+|\/+$/g, '')
  return (
    normalizedPrefix === '' || path === normalizedPrefix || path.startsWith(`${normalizedPrefix}/`)
  )
}

export function createWeworkDeliverySharedWorkspaceApi(
  deliveryApi: DeliveryApi
): WeworkDeliverySharedWorkspaceApi {
  return {
    projects: {
      async list() {
        return (await deliveryApi.listCloudProjects()).items.map(toProject)
      },
      create(input) {
        return deliveryApi
          .createCloudProject(
            withoutUndefined({
              project_key: input.projectKey,
              name: input.name,
              description: input.description,
              task_provider: input.taskProvider,
              visibility: input.visibility,
              provider_config: input.providerConfig as Parameters<
                DeliveryApi['createCloudProject']
              >[0]['provider_config'],
            }) as Parameters<DeliveryApi['createCloudProject']>[0]
          )
          .then(toProject)
      },
      update(projectId, input) {
        return deliveryApi
          .updateCloudProject(
            projectId,
            withoutUndefined({
              version: input.version,
              name: input.name,
              description: input.description,
              tags: input.tags,
              visibility: input.visibility,
              provider_config: input.providerConfig as Parameters<
                DeliveryApi['updateCloudProject']
              >[1]['provider_config'],
              board_config: input.boardConfig,
              card_display: input.cardDisplay,
              pull_request_automation: input.pullRequestAutomation as Parameters<
                DeliveryApi['updateCloudProject']
              >[1]['pull_request_automation'],
              workflow_definition: input.workflowDefinition as Parameters<
                DeliveryApi['updateCloudProject']
              >[1]['workflow_definition'],
            }) as Parameters<DeliveryApi['updateCloudProject']>[1]
          )
          .then(toProject)
      },
      archive(projectId, version) {
        return deliveryApi.archiveCloudProject(projectId, version)
      },
    },
    myWork: {
      async list() {
        return (await deliveryApi.listMyWork()).items.map(toMyWorkItem)
      },
    },
    issues: {
      async list(projectId, filters) {
        return (await deliveryApi.listLoopItems(projectId, filters)).items.map(toIssue)
      },
      async listPage(projectId, input) {
        const page = await deliveryApi.listLoopItemsPage(projectId, {
          status: input.status,
          parentId: input.parentId,
          cursor: input.cursor,
          limit: input.limit,
        })
        return {
          items: page.items.map(toIssue),
          nextCursor: page.next_cursor,
          taskBindings: page.task_bindings.map(binding =>
            mapWorkspaceTaskBindingDto(binding, projectId)
          ),
        }
      },
      async getBoardSnapshot(projectId) {
        return toBoardSnapshot(await deliveryApi.getBoardSnapshot(projectId), projectId)
      },
      get(issueId) {
        return deliveryApi.getLoopItem(issueId).then(toIssue)
      },
      create(projectId, input) {
        return deliveryApi
          .createLoopItem(
            projectId,
            withoutUndefined({
              title: input.title,
              description: input.description,
              status: input.status,
              priority: input.priority,
              due_at: input.dueAt,
              parent_id: input.parentId,
              tags: input.tags,
              local_project_id: input.localProjectId,
              local_project_name: input.localProjectName,
              workflow: input.workflow as Parameters<DeliveryApi['createLoopItem']>[1]['workflow'],
              execution_config: input.executionConfig as Parameters<
                DeliveryApi['createLoopItem']
              >[1]['execution_config'],
              automation_rule_id: input.automationRuleId,
            }) as Parameters<DeliveryApi['createLoopItem']>[1]
          )
          .then(toIssue)
      },
      update(issueId, input) {
        return deliveryApi
          .updateLoopItem(
            issueId,
            withoutUndefined({
              version: input.version,
              title: input.title,
              description: input.description,
              status: input.status,
              priority: input.priority,
              parent_id: input.parentId,
              assignee_user_id: input.assigneeUserId,
              assignee_agent_id: input.assigneeAgentId,
              assignee_team_id: input.assigneeTeamId,
              due_at: input.dueAt,
              tags: input.tags,
              workflow: input.workflow as Parameters<DeliveryApi['updateLoopItem']>[1]['workflow'],
              execution_config: input.executionConfig as Parameters<
                DeliveryApi['updateLoopItem']
              >[1]['execution_config'],
              automation_rule_id: input.automationRuleId,
            }) as Parameters<DeliveryApi['updateLoopItem']>[1]
          )
          .then(toIssue)
      },
      assign(projectId, issueId, input) {
        return deliveryApi.assignLoopItem(projectId, issueId, input).then(toIssue)
      },
      approveRun(projectId, issueId, version) {
        return deliveryApi.approveLoopItemRun(projectId, issueId, version).then(toIssue)
      },
      rejectRun(projectId, issueId, version, reason) {
        return deliveryApi.rejectLoopItemRun(projectId, issueId, version, reason).then(toIssue)
      },
      archive(issueId) {
        return deliveryApi.archiveLoopItem(issueId)
      },
      async reorder(projectId, input) {
        return (
          await deliveryApi.reorderLoopItems(projectId, {
            parent_id: input.parentId,
            status: input.status,
            item_ids: input.issueIds,
          })
        ).items.map(toIssue)
      },
      markRead(issueId) {
        return deliveryApi.markLoopItemRead(issueId).then(toIssue)
      },
    },
    attachments: {
      async list(issueId) {
        return (await deliveryApi.listLoopItemAttachments(issueId)).map(toAttachment)
      },
      async listProjectTaskAttachments(projectId) {
        return (await deliveryApi.listProjectTaskAttachments(projectId)).items.map(toAttachment)
      },
      async upload(issueId, file) {
        return toAttachment(await deliveryApi.addLoopItemAttachment(issueId, file))
      },
      async importContexts(issueId, contextIds) {
        const attachments = contextIds.map(id => ({ id }) as Attachment)
        return (await deliveryApi.importLoopItemAttachments(issueId, attachments)).map(toAttachment)
      },
      async access(attachmentId) {
        const access = await deliveryApi.accessLoopItemAttachment(attachmentId)
        return { url: access.url, expiresInSeconds: access.expires_in_seconds }
      },
      read(attachmentId) {
        return deliveryApi.readLoopItemAttachment(attachmentId)
      },
      download(attachmentId, filename) {
        return deliveryApi.downloadLoopItemAttachment(attachmentId, filename)
      },
      remove(attachmentId) {
        return deliveryApi.deleteLoopItemAttachment(attachmentId)
      },
    },
    collaborators: {
      async list(issueId) {
        return (await deliveryApi.listLoopItemCollaborators(issueId)).map(
          mapWorkspaceIssueCollaboratorDto
        )
      },
      async add(issueId, userId) {
        return mapWorkspaceIssueCollaboratorDto(
          await deliveryApi.addLoopItemCollaborator(issueId, userId)
        )
      },
      remove(issueId, userId) {
        return deliveryApi.removeLoopItemCollaborator(issueId, userId)
      },
    },
    taskBindings: {
      async list(issueId, projectId) {
        return (await deliveryApi.listTaskBindings(issueId)).map(binding =>
          mapWorkspaceTaskBindingDto(binding, projectId)
        )
      },
    },
    workflowPlans: {
      get get() {
        if (typeof deliveryApi.getWorkflowPlan !== 'function') return undefined
        return async (issueId: string) => {
          const plan = await deliveryApi.getWorkflowPlan(issueId)
          return plan ? mapWorkspaceWorkflowPlanDto(plan) : null
        }
      },
      get approve() {
        if (typeof deliveryApi.approveWorkflowPlan !== 'function') return undefined
        return async (issueId: string) =>
          mapWorkspaceWorkflowPlanDto(await deliveryApi.approveWorkflowPlan(issueId))
      },
      get approveReview() {
        if (typeof deliveryApi.approveWorkflowReview !== 'function') return undefined
        return async (issueId: string) =>
          mapWorkspaceWorkflowPlanDto(await deliveryApi.approveWorkflowReview(issueId))
      },
      get pause() {
        if (typeof deliveryApi.pauseWorkflowPlan !== 'function') return undefined
        return async (issueId: string) =>
          mapWorkspaceWorkflowPlanDto(await deliveryApi.pauseWorkflowPlan(issueId))
      },
      get resume() {
        if (typeof deliveryApi.resumeWorkflowPlan !== 'function') return undefined
        return async (issueId: string) =>
          mapWorkspaceWorkflowPlanDto(await deliveryApi.resumeWorkflowPlan(issueId))
      },
      get replan() {
        if (typeof deliveryApi.replanWorkflowPlan !== 'function') return undefined
        return async (issueId: string) =>
          mapWorkspaceWorkflowPlanDto(await deliveryApi.replanWorkflowPlan(issueId))
      },
      decideNode(issueId, workflowNodeId, action, reason) {
        return deliveryApi.decideWorkflowNode(issueId, workflowNodeId, action, reason)
      },
      async getStageContext(issueId, workflowNodeId) {
        const context = await deliveryApi.getWorkflowStageContext(issueId, workflowNodeId)
        return mapWorkspaceWorkflowStageContextDto(context)
      },
    },
    members: {
      async list(projectId) {
        return (await deliveryApi.listCloudProjectMembers(projectId)).map(toMember)
      },
      async searchUsers(query) {
        return (await deliveryApi.searchCloudProjectUsers(query)).users.map(toUser)
      },
      async add(projectId, userId, role) {
        return toMember(await deliveryApi.addCloudProjectMember(projectId, userId, role))
      },
      async update(projectId, userId, input) {
        return toMember(
          await deliveryApi.updateCloudProjectMember(
            projectId,
            userId,
            withoutUndefined({
              role: input.role,
              capability_description: input.capabilityDescription,
            })
          )
        )
      },
      remove(projectId, userId) {
        return deliveryApi.removeCloudProjectMember(projectId, userId)
      },
    },
    files: {
      async list(projectId, prefix) {
        const files = (await deliveryApi.listCloudFiles(projectId)).items
        return prefix ? files.filter(file => isWithinPrefix(file.path, prefix)) : files
      },
      async listDeliveryFiles(projectId) {
        return (await deliveryApi.listProjectDeliveryFiles(projectId)).items.map(toDeliveryFile)
      },
      createFolder(projectId, path) {
        return deliveryApi.createCloudFolder(projectId, path)
      },
      upload(projectId, file, path) {
        return deliveryApi.uploadCloudFile(projectId, file, path)
      },
      async access(fileId) {
        const access = await deliveryApi.accessCloudFile(fileId)
        return { url: access.url, expiresInSeconds: access.expires_in_seconds }
      },
      read(fileId) {
        return deliveryApi.readCloudFile(fileId)
      },
      move(fileId, path, version) {
        return deliveryApi.moveCloudFile(fileId, path, version)
      },
      remove(fileId, recursive) {
        return deliveryApi.deleteCloudFile(fileId, recursive)
      },
      async accessDeliveryFile(assetId) {
        const access = await deliveryApi.accessDeliveryFile(assetId)
        return { url: access.url, expiresInSeconds: access.expires_in_seconds }
      },
      readDeliveryFile(assetId) {
        return deliveryApi.readDeliveryFile(assetId)
      },
    },
    deliveries: {
      async list(issueId) {
        return (await deliveryApi.listDeliveries(issueId)).items.map(mapWorkspaceDeliveryDto)
      },
      async get(deliveryId) {
        return mapWorkspaceDeliveryDto(await deliveryApi.getDelivery(deliveryId))
      },
      async create(issueId, input) {
        return mapWorkspaceDeliveryDto(
          await deliveryApi.createDelivery(issueId, {
            markdown: input.markdown,
            chat: input.chat,
            source_task: input.sourceTask
              ? {
                  deviceId: input.sourceTask.deviceId,
                  taskId: input.sourceTask.taskId,
                }
              : undefined,
          })
        )
      },
      async addAsset(deliveryId, file, relativePath) {
        return mapWorkspaceDeliveryAssetDto(
          await deliveryApi.addAsset(deliveryId, file, relativePath)
        )
      },
      async finalize(deliveryId, input) {
        return mapWorkspaceDeliveryDto(
          await deliveryApi.finalizeDelivery(
            deliveryId,
            input as Parameters<DeliveryApi['finalizeDelivery']>[1]
          )
        )
      },
      discardDraft(deliveryId) {
        return deliveryApi.discardDraft(deliveryId)
      },
    },
    executions: {
      async list(projectId, filters) {
        return (
          await deliveryApi.listLoopItemExecutions(projectId, {
            agent_id: filters?.agentId,
            status: filters?.status,
            include_terminal: filters?.includeTerminal,
          })
        ).items.map(mapCollaborationExecutionDto)
      },
      stop(projectId, executionId) {
        return deliveryApi.stopExecution(projectId, executionId)
      },
    },
  }
}

export function createWeworkAutomationSharedWorkspaceApi(
  deliveryApi: DeliveryApi,
  projectAutomationApi?: ProjectAutomationApi,
  projectIncomingHookApi?: ProjectIncomingHookApi
): WeworkAutomationSharedWorkspaceApi {
  const delivery = createWeworkDeliverySharedWorkspaceApi(deliveryApi)
  return {
    projects: {
      update: delivery.projects.update,
    },
    ...(projectAutomationApi
      ? { automations: createWeworkAutomationsApi(projectAutomationApi) }
      : {}),
    ...(projectIncomingHookApi
      ? { incomingHooks: createWeworkIncomingHooksApi(projectIncomingHookApi) }
      : {}),
  }
}

export function createWeworkWorkspaceRuntimePort(
  deliveryApi: DeliveryApi,
  projectAutomationApi: ProjectAutomationApi
): WeworkWorkspaceRuntimePort {
  return {
    async findIssueForTask(task) {
      return toIssue(await deliveryApi.findLoopItemForTask(toRuntimeTaskAddress(task)))
    },
    async findCloudContextForTask(task) {
      const context = await deliveryApi.findCloudContextForTask(toRuntimeTaskAddress(task))
      return {
        project: toProject(context.project),
        issueId: context.loop_item_id,
        workflowNodeId: context.workflow_node_id,
      }
    },
    bindTask(issueId, task, taskTitle, workflowNodeId) {
      return deliveryApi.bindTask(issueId, toRuntimeTaskAddress(task), taskTitle, workflowNodeId)
    },
    unbindTask(issueId, task) {
      return deliveryApi.unbindTask(issueId, toRuntimeTaskAddress(task))
    },
    unbindCloudContext(task) {
      return deliveryApi.unbindCloudContext(toRuntimeTaskAddress(task))
    },
    async trackProjectTask(projectId, task, title, description) {
      const result = await deliveryApi.trackProjectTask(
        projectId,
        toRuntimeTaskAddress(task),
        title,
        description
      )
      return { issue: toIssue(result.item) }
    },
    async updateTrackedTaskStatus(task, executionStatus) {
      const issue = await deliveryApi.updateTaskTrackingStatus(
        toRuntimeTaskAddress(task),
        executionStatus
      )
      return issue ? toIssue(issue) : null
    },
    async updateTrackedTaskTitle(task, title) {
      const issue = await deliveryApi.updateTaskTrackingTitle(toRuntimeTaskAddress(task), title)
      return issue ? toIssue(issue) : null
    },
    async claimNextExecution(input) {
      const execution = await projectAutomationApi.claimNext({
        execution_device_id: input.executionDeviceId,
        lease_seconds: input.leaseSeconds,
      })
      return execution ? mapCollaborationExecutionDto(execution) : null
    },
    async reportExecutionLifecycle(projectId, executionId, event) {
      const execution = { id: executionId, cloud_project_id: projectId }
      const updated =
        event.type === 'heartbeat'
          ? await projectAutomationApi.heartbeat(
              execution,
              event.runtimeDeviceId,
              event.runtimeTaskId
            )
          : event.type === 'start_requested'
            ? await projectAutomationApi.startRequested(
                execution,
                event.runtimeDeviceId,
                event.runtimeTaskId
              )
            : event.type === 'dispatch_unknown'
              ? await projectAutomationApi.dispatchUnknown(
                  execution,
                  event.runtimeDeviceId,
                  event.runtimeTaskId,
                  event.error
                )
              : event.type === 'runtime_start'
                ? await projectAutomationApi.runtimeStart(
                    execution,
                    event.runtimeDeviceId,
                    event.runtimeTaskId,
                    event.prompt,
                    event.model
                  )
                : await projectAutomationApi.dispatchFailed(execution, event.error)
      return updated ? mapCollaborationExecutionDto(updated) : null
    },
  }
}

export function createWeworkSharedWorkspaceApi<
  Dependencies extends WeworkSharedWorkspaceApiDependencies,
>({
  client,
  deliveryApi,
  projectAutomationApi,
  projectIncomingHookApi,
  runtimeProfileApi,
}: Dependencies): SharedWorkspaceApi {
  const delivery = createWeworkDeliverySharedWorkspaceApi(deliveryApi)
  const sharedHttpApi = createSharedWorkspaceHttpApi(client)

  return {
    ...delivery,
    workspaces: sharedHttpApi.workspaces,
    resources: sharedHttpApi.resources,
    projects: {
      ...delivery.projects,
      async list(workspaceId) {
        if (!workspaceId) return delivery.projects.list()
        const response = await client.get<{ items: CloudProject[] }>(
          `/v1/workspaces/${encodeURIComponent(workspaceId)}/projects`
        )
        return response.items.map(toProject)
      },
      async create(input) {
        if (!input.workspaceId) return delivery.projects.create(input)
        const { workspaceId, ...projectInput } = input
        return toProject(
          await client.post<CloudProject>(
            `/v1/workspaces/${encodeURIComponent(workspaceId)}/projects`,
            withoutUndefined({
              project_key: projectInput.projectKey,
              name: projectInput.name,
              description: projectInput.description,
              task_provider: projectInput.taskProvider,
              visibility: projectInput.visibility,
              provider_config: projectInput.providerConfig,
            })
          )
        )
      },
      get(projectId) {
        return client.get<CloudProject>(`/v1/cloud-projects/${encodeURIComponent(projectId)}`)
      },
      importMessages(projectId, input) {
        return client.post<{ issue: CloudLoopItem }>(
          `/v1/cloud-projects/${encodeURIComponent(projectId)}/message-imports`,
          {
            source_task_id: input.sourceTaskId,
            subtask_ids: input.subtaskIds,
            target:
              input.target.kind === 'new_issue'
                ? { kind: input.target.kind, title: input.target.title }
                : { kind: input.target.kind, issue_id: input.target.issueId },
            note: input.note,
          }
        )
      },
    },
    comments: sharedHttpApi.comments,
    assignments: sharedHttpApi.assignments,
    automations: {
      ...createWeworkAutomationsApi(projectAutomationApi),
      async runWorkflowNode(projectId, issueId, workflowNodeId, automationId) {
        return toAutomationRun(
          await projectAutomationApi.runWorkflowNode(
            projectId,
            issueId,
            workflowNodeId,
            automationId
          )
        )
      },
      async cancelRun(projectId, runId) {
        return toAutomationRun(await projectAutomationApi.cancelRun(projectId, runId))
      },
      async retryRun(projectId, runId) {
        return toAutomationRun(await projectAutomationApi.retryRun(projectId, runId))
      },
    },
    incomingHooks: {
      ...createWeworkIncomingHooksApi(projectIncomingHookApi),
      async listEvents(projectId, hookId, limit) {
        return (await projectIncomingHookApi.listEvents(projectId, hookId, limit)).map(event => ({
          ...event,
        }))
      },
    },
    runtimeProfiles: {
      async list() {
        return (await runtimeProfileApi.list()).map(toRuntimeProfile)
      },
      async create(input) {
        return toRuntimeProfile(
          await runtimeProfileApi.create(
            input as unknown as Parameters<RuntimeProfileApi['create']>[0]
          )
        )
      },
      async update(profileId, input) {
        return toRuntimeProfile(
          await runtimeProfileApi.update(
            profileId,
            input as unknown as Parameters<RuntimeProfileApi['update']>[1]
          )
        )
      },
      remove: runtimeProfileApi.delete,
      getProjectDefault: runtimeProfileApi.getProjectDefault,
      setProjectDefault: runtimeProfileApi.setProjectDefault,
      async selectExecution(projectId, executionId, runtimeProfileId, version) {
        return mapCollaborationExecutionDto(
          await runtimeProfileApi.selectExecution(projectId, executionId, runtimeProfileId, version)
        )
      },
    },
    agents: sharedHttpApi.agents,
  }
}
