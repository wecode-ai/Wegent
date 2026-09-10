// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import type {
  CollaborationAgent,
  CollaborationAttachment,
  CollaborationComment,
  CollaborationExecution,
  CollaborationIssue,
  CollaborationMember,
  CollaborationProject,
  CollaborationUser,
  SharedWorkspaceApi,
  WorkspaceBoardSnapshot,
  WorkspaceDelivery,
  WorkspaceDeliveryAsset,
  WorkspaceDeliveryFile,
  WorkspaceAutomationRule,
  WorkspaceAutomationRun,
  WorkspaceIncomingHook,
  WorkspaceIssueCollaborator,
  WorkspaceProjectAgent,
  WorkspaceRuntimeProfile,
  WorkspaceTaskBinding,
  WorkspaceWorkflowPlan,
  WorkspaceMyWorkItem,
} from '@wegent/collaboration'
import type {
  CloudLoopItem,
  CloudLoopItemCollaborator,
  CloudProject,
  Delivery,
  DeliveryAsset,
  DeliveryDetail,
  LoopItemTaskBinding,
  ProjectBoardSnapshot,
  ProjectDeliveryFile,
  WorkflowPlan,
  createDeliveryApi,
} from '@/api/deliveries'
import type { HttpClient } from '@/api/http'
import type { createProjectAutomationApi } from '@/api/projectAutomations'
import type { createProjectChatAgentApi } from '@/api/projectChatAgents'
import type { createProjectIncomingHookApi } from '@/api/projectIncomingHooks'
import type { createRuntimeProfileApi } from '@/api/runtimeProfiles'
import type { Attachment } from '@/types/api'

type DeliveryApi = ReturnType<typeof createDeliveryApi>
type ProjectAutomationApi = ReturnType<typeof createProjectAutomationApi>
type ProjectChatAgentApi = ReturnType<typeof createProjectChatAgentApi>
type ProjectIncomingHookApi = ReturnType<typeof createProjectIncomingHookApi>
type RuntimeProfileApi = ReturnType<typeof createRuntimeProfileApi>

type ProjectMethod = 'list' | 'create' | 'update' | 'archive' | 'listMyWork'

export interface WeworkDeliverySharedWorkspaceApi {
  projects: Pick<SharedWorkspaceApi['projects'], ProjectMethod>
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
  projects: ['list', 'create', 'update', 'archive', 'listMyWork'],
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
  projectChatAgentApi: ProjectChatAgentApi
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

function toTaskBinding(
  binding: LoopItemTaskBinding,
  contextProjectId?: string
): WorkspaceTaskBinding {
  const projectId = binding.cloud_project_id ?? contextProjectId
  if (projectId == null) {
    throw new Error(`DeliveryApi task binding ${binding.id} is missing cloud_project_id`)
  }
  return {
    id: binding.id,
    projectId: String(projectId),
    issueId: binding.loop_item_id,
    taskUserId: binding.task_user_id,
    deviceId: binding.device_id,
    taskId: binding.task_id,
    taskTitle: binding.task_title,
    backendTaskId: binding.backend_task_id,
    modelSelection: binding.modelSelection ? { ...binding.modelSelection } : binding.modelSelection,
    workflowNodeId: binding.workflow_node_id,
    bindingType: binding.binding_type,
    linkedAt: binding.linked_at,
  }
}

function toBoardSnapshot(
  snapshot: ProjectBoardSnapshot,
  contextProjectId: string
): WorkspaceBoardSnapshot {
  return {
    items: snapshot.items.map(toIssue),
    members: snapshot.members.map(toMember),
    agents: snapshot.agents.map(toAgent),
    taskBindings: snapshot.task_bindings.map(binding => toTaskBinding(binding, contextProjectId)),
  }
}

function toExecution(input: object): CollaborationExecution {
  const row = input as Record<string, unknown>
  return {
    id: Number(row.id),
    loop_item_id: String(row.loopItemId ?? row.loop_item_id ?? ''),
    task_title: String(row.taskTitle ?? row.task_title ?? ''),
    executor_type: String(row.executorType ?? row.executor_type ?? 'project_robot'),
    status: String(row.status ?? ''),
    display_state: String(row.displayState ?? row.display_state ?? 'unknown'),
    observed_state: String(row.observedState ?? row.observed_state ?? 'unconfirmed'),
    sync_state: String(row.syncState ?? row.sync_state ?? 'pending'),
    started_at:
      row.startedAt == null && row.started_at == null
        ? null
        : String(row.startedAt ?? row.started_at),
    completed_at:
      row.completedAt == null && row.completed_at == null
        ? null
        : String(row.completedAt ?? row.completed_at),
    error_message:
      row.errorMessage == null && row.error_message == null
        ? null
        : String(row.errorMessage ?? row.error_message),
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

function toRuntimeProfile(
  profile: Awaited<ReturnType<RuntimeProfileApi['create']>>
): WorkspaceRuntimeProfile {
  return { ...profile }
}

function toProjectAgent(
  agent: Awaited<ReturnType<ProjectChatAgentApi['create']>>
): WorkspaceProjectAgent {
  return { ...agent }
}

function toCollaborator(collaborator: CloudLoopItemCollaborator): WorkspaceIssueCollaborator {
  return {
    id: collaborator.id,
    issueId: collaborator.loop_item_id,
    userId: collaborator.user_id,
    userName: collaborator.user_name,
    email: collaborator.email,
    source: collaborator.source,
    addedByUserId: collaborator.added_by_user_id,
    createdAt: collaborator.created_at,
  }
}

function toWorkflowPlan(plan: WorkflowPlan): WorkspaceWorkflowPlan {
  return {
    runId: plan.run_id,
    issueId: plan.issue_id,
    stageId: plan.stage_id,
    planVersion: plan.plan_version,
    approvalPolicy: plan.approval_policy,
    status: plan.status,
    summary: plan.summary,
    items: plan.items.map(item => ({ ...item })),
    managerRun: plan.manager_run ? { ...plan.manager_run } : plan.manager_run,
  }
}

function toDeliveryAsset(asset: DeliveryAsset): WorkspaceDeliveryAsset {
  return {
    id: asset.id,
    kind: asset.kind,
    displayName: asset.display_name,
    relativePath: asset.relative_path,
    contentType: asset.content_type,
    sizeBytes: asset.size_bytes,
    sha256: asset.sha256,
  }
}

function toDelivery(delivery: Delivery | DeliveryDetail): WorkspaceDelivery {
  return {
    id: delivery.id,
    issueId: delivery.loop_item_id,
    status: delivery.status,
    ...('markdown' in delivery ? { markdown: delivery.markdown, chat: delivery.chat } : {}),
    assets: delivery.assets.map(toDeliveryAsset),
    fulfillments: delivery.fulfillments,
    createdAt: delivery.created_at,
    deliveredAt: delivery.delivered_at,
  }
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
      async listMyWork() {
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
          taskBindings: page.task_bindings.map(binding => toTaskBinding(binding, projectId)),
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
      remove(attachmentId) {
        return deliveryApi.deleteLoopItemAttachment(attachmentId)
      },
    },
    collaborators: {
      async list(issueId) {
        return (await deliveryApi.listLoopItemCollaborators(issueId)).map(toCollaborator)
      },
      async add(issueId, userId) {
        return toCollaborator(await deliveryApi.addLoopItemCollaborator(issueId, userId))
      },
      remove(issueId, userId) {
        return deliveryApi.removeLoopItemCollaborator(issueId, userId)
      },
    },
    taskBindings: {
      async list(issueId) {
        return (await deliveryApi.listTaskBindings(issueId)).map(binding => toTaskBinding(binding))
      },
    },
    workflowPlans: {
      async get(issueId) {
        const plan = await deliveryApi.getWorkflowPlan(issueId)
        return plan ? toWorkflowPlan(plan) : null
      },
      async approve(issueId) {
        return toWorkflowPlan(await deliveryApi.approveWorkflowPlan(issueId))
      },
      async approveReview(issueId) {
        return toWorkflowPlan(await deliveryApi.approveWorkflowReview(issueId))
      },
      async pause(issueId) {
        return toWorkflowPlan(await deliveryApi.pauseWorkflowPlan(issueId))
      },
      async resume(issueId) {
        return toWorkflowPlan(await deliveryApi.resumeWorkflowPlan(issueId))
      },
      async replan(issueId) {
        return toWorkflowPlan(await deliveryApi.replanWorkflowPlan(issueId))
      },
      decideNode(issueId, workflowNodeId, action, reason) {
        return deliveryApi.decideWorkflowNode(issueId, workflowNodeId, action, reason)
      },
      async getStageContext(issueId, workflowNodeId) {
        const context = await deliveryApi.getWorkflowStageContext(issueId, workflowNodeId)
        const { compiled_task_instruction, ...rest } = context
        return { ...rest, compiledTaskInstruction: compiled_task_instruction }
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
        return (await deliveryApi.listDeliveries(issueId)).items.map(toDelivery)
      },
      async get(deliveryId) {
        return toDelivery(await deliveryApi.getDelivery(deliveryId))
      },
      async create(issueId, input) {
        return toDelivery(await deliveryApi.createDelivery(issueId, input))
      },
      async addAsset(deliveryId, file, relativePath) {
        return toDeliveryAsset(await deliveryApi.addAsset(deliveryId, file, relativePath))
      },
      async finalize(deliveryId, input) {
        return toDelivery(
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
          })
        ).items.map(toExecution)
      },
      stop(projectId, executionId) {
        return deliveryApi.stopExecution(projectId, executionId)
      },
    },
  }
}

export function createWeworkSharedWorkspaceApi({
  client,
  deliveryApi,
  projectAutomationApi,
  projectIncomingHookApi,
  runtimeProfileApi,
  projectChatAgentApi,
}: WeworkSharedWorkspaceApiDependencies): SharedWorkspaceApi {
  const delivery = createWeworkDeliverySharedWorkspaceApi(deliveryApi)

  return {
    ...delivery,
    projects: {
      ...delivery.projects,
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
    comments: {
      list(issueId) {
        return client.get<CollaborationComment[]>(
          `/v1/loop-items/${encodeURIComponent(issueId)}/comments`
        )
      },
      create(issueId, body) {
        return client.post<CollaborationComment>(
          `/v1/loop-items/${encodeURIComponent(issueId)}/comments`,
          { body }
        )
      },
    },
    automations: {
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
      async listRuns(projectId, automationId) {
        return (await projectAutomationApi.listRuns(projectId, automationId)).map(toAutomationRun)
      },
      async cancelRun(projectId, runId) {
        return toAutomationRun(await projectAutomationApi.cancelRun(projectId, runId))
      },
      async retryRun(projectId, runId) {
        return toAutomationRun(await projectAutomationApi.retryRun(projectId, runId))
      },
    },
    incomingHooks: {
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
        return toExecution(
          await runtimeProfileApi.selectExecution(projectId, executionId, runtimeProfileId, version)
        )
      },
    },
    agents: {
      async list(projectId) {
        return (await projectChatAgentApi.list(projectId)).map(toProjectAgent)
      },
      async create(projectId, input) {
        return toProjectAgent(
          await projectChatAgentApi.create(
            projectId,
            input as unknown as Parameters<ProjectChatAgentApi['create']>[1]
          )
        )
      },
      async update(projectId, agentId, input) {
        return toProjectAgent(
          await projectChatAgentApi.update(
            projectId,
            agentId,
            input as unknown as Parameters<ProjectChatAgentApi['update']>[2]
          )
        )
      },
    },
  }
}
