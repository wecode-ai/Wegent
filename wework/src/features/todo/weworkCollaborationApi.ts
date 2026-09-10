// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import type {
  CollaborationApi,
  CollaborationAttachment,
  CollaborationBoardSnapshot,
  CollaborationComment,
  CollaborationExecution,
  CollaborationFile,
  CollaborationIssue,
  CollaborationProject,
} from '@wegent/collaboration'

import {
  DEFAULT_WORK_ITEM_PROJECT_ID,
  type CloudLoopItem,
  type CloudLoopItemAttachment,
  type CloudLoopItemExecution,
  type CloudProject,
  type CloudProjectFile,
} from '@/api/deliveries'
import type {
  DeliveryApi,
  ProjectSpaceLocation,
  WorkbenchServices,
} from '@/features/workbench/workbenchServices'

interface ProjectReference {
  location: ProjectSpaceLocation
  projectId: string
}

interface ResourceReference extends ProjectReference {
  resourceId: string
}

const PROJECT_PREFIX = 'wework-project:'
const RESOURCE_PREFIX = 'wework-resource:'

function encodeReference(prefix: string, value: object): string {
  return `${prefix}${encodeURIComponent(JSON.stringify(value))}`
}

function decodeReference<T>(prefix: string, value: string): T {
  if (!value.startsWith(prefix)) throw new Error('Invalid Wework collaboration reference')
  return JSON.parse(decodeURIComponent(value.slice(prefix.length))) as T
}

export function collaborationProjectId(reference: ProjectReference): string {
  return encodeReference(PROJECT_PREFIX, reference)
}

export function collaborationProjectReference(projectId: string): ProjectReference {
  return decodeReference<ProjectReference>(PROJECT_PREFIX, projectId)
}

function collaborationResourceId(reference: ResourceReference): string {
  return encodeReference(RESOURCE_PREFIX, reference)
}

export function collaborationIssueId(reference: ProjectReference, issueId: string): string {
  return collaborationResourceId({ ...reference, resourceId: issueId })
}

function collaborationResourceReference(resourceId: string): ResourceReference {
  return decodeReference<ResourceReference>(RESOURCE_PREFIX, resourceId)
}

function projectLocation(project: Pick<CloudProject, 'project_store'>): ProjectSpaceLocation {
  return project.project_store === 'local' ? 'local' : 'cloud'
}

function mapProject(
  project: CollaborationProject | CloudProject,
  location: ProjectSpaceLocation
): CollaborationProject {
  return {
    ...project,
    id: collaborationProjectId({ location, projectId: String(project.id) }),
    project_store: location === 'local' ? 'local' : 'backend',
  }
}

function mapIssue(issue: CollaborationIssue | CloudLoopItem, reference: ProjectReference) {
  const resource = { ...reference, resourceId: issue.id }
  return {
    ...issue,
    id: collaborationResourceId(resource),
    cloud_project_id: collaborationProjectId(reference),
    parent_id: issue.parent_id
      ? collaborationResourceId({ ...reference, resourceId: issue.parent_id })
      : null,
  } satisfies CollaborationIssue
}

function mapAttachment(
  attachment: CollaborationAttachment | CloudLoopItemAttachment,
  reference: ProjectReference
): CollaborationAttachment {
  return {
    ...attachment,
    id: collaborationResourceId({ ...reference, resourceId: attachment.id }),
    loop_item_id: collaborationResourceId({
      ...reference,
      resourceId: attachment.loop_item_id,
    }),
  }
}

function mapFile(
  file: CollaborationFile | CloudProjectFile,
  reference: ProjectReference
): CollaborationFile {
  return {
    ...file,
    id: collaborationResourceId({ ...reference, resourceId: file.id }),
    cloud_project_id: collaborationProjectId(reference),
  }
}

function mapExecution(
  execution: CollaborationExecution | CloudLoopItemExecution,
  reference: ProjectReference
): CollaborationExecution {
  return {
    id: execution.id,
    loop_item_id: collaborationResourceId({
      ...reference,
      resourceId: execution.loop_item_id,
    }),
    task_title: execution.task_title,
    executor_type: execution.executor_type,
    status: execution.status,
    display_state: execution.display_state,
    observed_state: execution.observed_state,
    sync_state: execution.sync_state,
    started_at: execution.started_at,
    completed_at: execution.completed_at,
    error_message: execution.error_message,
  }
}

function mapChatMessage(message: {
  messageId: string
  content: string
  sender: { name: string }
  createdAt: string
  updatedAt: string
}): CollaborationComment {
  return {
    id: message.messageId,
    body: message.content,
    author: message.sender.name,
    web_url: null,
    created_at: message.createdAt,
    updated_at: message.updatedAt,
  }
}

function deliveryApiFor(services: WorkbenchServices, location: ProjectSpaceLocation): DeliveryApi {
  const api = services.projectSpaceApis?.[location]
  if (!api) throw new Error(`The ${location} project-space API is unavailable`)
  return api
}

async function localProject(services: WorkbenchServices, projectId: string): Promise<CloudProject> {
  const response = await deliveryApiFor(services, 'local').listCloudProjects()
  const project = response.items.find(item => String(item.id) === projectId)
  if (!project) throw new Error('Local project not found')
  return project
}

export function createWeworkCollaborationApi(services: WorkbenchServices): CollaborationApi {
  const cloudApi = services.collaborationApi
  if (!cloudApi) throw new Error('The cloud collaboration API is unavailable')

  return {
    async listProjects() {
      const localApi = services.projectSpaceApis?.local
      const [cloudProjects, localProjects] = await Promise.all([
        cloudApi.listProjects(),
        localApi?.listCloudProjects().then(response => response.items) ?? Promise.resolve([]),
      ])
      return [
        ...cloudProjects
          .filter(project => project.id !== DEFAULT_WORK_ITEM_PROJECT_ID)
          .map(project => mapProject(project, 'cloud')),
        ...localProjects
          .filter(project => project.id !== DEFAULT_WORK_ITEM_PROJECT_ID)
          .map(project => mapProject(project, projectLocation(project))),
      ]
    },
    async getProject(projectId) {
      const reference = collaborationProjectReference(projectId)
      if (reference.location === 'cloud') {
        return mapProject(await cloudApi.getProject(reference.projectId), 'cloud')
      }
      return mapProject(await localProject(services, reference.projectId), 'local')
    },
    async createProject(data) {
      if (data.project_store === 'local') {
        const localApi = deliveryApiFor(services, 'local')
        const created = await localApi.createCloudProject({
          name: data.name,
          description: data.description,
          task_provider: 'local',
        })
        return mapProject(created, 'local')
      }
      return mapProject(
        await cloudApi.createProject({
          name: data.name,
          description: data.description,
          visibility: data.visibility,
        }),
        'cloud'
      )
    },
    async updateProject(projectId, data) {
      const reference = collaborationProjectReference(projectId)
      if (reference.location === 'cloud') {
        return mapProject(await cloudApi.updateProject(reference.projectId, data), 'cloud')
      }
      const updated = await deliveryApiFor(services, 'local').updateCloudProject(
        reference.projectId,
        data
      )
      return mapProject(updated, 'local')
    },
    async getBoardSnapshot(projectId) {
      const reference = collaborationProjectReference(projectId)
      if (reference.location === 'cloud') {
        const snapshot = await cloudApi.getBoardSnapshot(reference.projectId)
        return {
          ...snapshot,
          items: snapshot.items.map(issue => mapIssue(issue, reference)),
        }
      }
      const snapshot = await deliveryApiFor(services, 'local').getBoardSnapshot(reference.projectId)
      return {
        items: snapshot.items.map(issue => mapIssue(issue, reference)),
        members: snapshot.members,
        agents: snapshot.agents,
      } satisfies CollaborationBoardSnapshot
    },
    async getIssue(issueId) {
      const reference = collaborationResourceReference(issueId)
      const issue =
        reference.location === 'cloud'
          ? await cloudApi.getIssue(reference.resourceId)
          : await deliveryApiFor(services, 'local').getLoopItem(reference.resourceId)
      return mapIssue(issue, reference)
    },
    async createIssue(projectId, data) {
      const reference = collaborationProjectReference(projectId)
      const issue =
        reference.location === 'cloud'
          ? await cloudApi.createIssue(reference.projectId, data)
          : await deliveryApiFor(services, 'local').createLoopItem(reference.projectId, data)
      return mapIssue(issue, reference)
    },
    async updateIssue(issueId, data) {
      const reference = collaborationResourceReference(issueId)
      const issue =
        reference.location === 'cloud'
          ? await cloudApi.updateIssue(reference.resourceId, data)
          : await deliveryApiFor(services, 'local').updateLoopItem(reference.resourceId, data)
      return mapIssue(issue, reference)
    },
    async reorderIssues(projectId, data) {
      const reference = collaborationProjectReference(projectId)
      const rawItemIds = data.item_ids.map(
        itemId => collaborationResourceReference(itemId).resourceId
      )
      const parentId = data.parent_id
        ? collaborationResourceReference(data.parent_id).resourceId
        : null
      const items =
        reference.location === 'cloud'
          ? await cloudApi.reorderIssues(reference.projectId, {
              ...data,
              parent_id: parentId,
              item_ids: rawItemIds,
            })
          : (
              await deliveryApiFor(services, 'local').reorderLoopItems(reference.projectId, {
                ...data,
                parent_id: parentId,
                item_ids: rawItemIds,
              })
            ).items
      return items.map(item => mapIssue(item, reference))
    },
    async listComments(issueId) {
      const reference = collaborationResourceReference(issueId)
      if (reference.location === 'local') {
        const client = services.localProjectChatClient
        if (!client) throw new Error('The local project comment API is unavailable')
        const subscription = await client.subscribe(
          reference.projectId,
          reference.resourceId,
          0,
          () => undefined
        )
        subscription.unsubscribe()
        return subscription.snapshot.messages.map(mapChatMessage)
      }
      return cloudApi.listComments(reference.resourceId)
    },
    async addComment(issueId, body) {
      const reference = collaborationResourceReference(issueId)
      if (reference.location === 'local') {
        const client = services.localProjectChatClient
        if (!client) throw new Error('The local project comment API is unavailable')
        return mapChatMessage(
          await client.send({
            projectId: reference.projectId,
            taskId: reference.resourceId,
            clientMessageId: crypto.randomUUID(),
            text: body,
          })
        )
      }
      return cloudApi.addComment(reference.resourceId, body)
    },
    async listAttachments(issueId) {
      const reference = collaborationResourceReference(issueId)
      const attachments =
        reference.location === 'cloud'
          ? await cloudApi.listAttachments(reference.resourceId)
          : await deliveryApiFor(services, 'local').listLoopItemAttachments(reference.resourceId)
      return attachments.map(attachment => mapAttachment(attachment, reference))
    },
    async addAttachment(issueId, file) {
      const reference = collaborationResourceReference(issueId)
      const attachment =
        reference.location === 'cloud'
          ? await cloudApi.addAttachment(reference.resourceId, file)
          : await deliveryApiFor(services, 'local').addLoopItemAttachment(
              reference.resourceId,
              file
            )
      return mapAttachment(attachment, reference)
    },
    async deleteAttachment(attachmentId) {
      const reference = collaborationResourceReference(attachmentId)
      if (reference.location === 'cloud') {
        await cloudApi.deleteAttachment(reference.resourceId)
      } else {
        await deliveryApiFor(services, 'local').deleteLoopItemAttachment(reference.resourceId)
      }
    },
    async listMembers(projectId) {
      const reference = collaborationProjectReference(projectId)
      return reference.location === 'cloud'
        ? cloudApi.listMembers(reference.projectId)
        : deliveryApiFor(services, 'local').listCloudProjectMembers(reference.projectId)
    },
    async searchUsers(query) {
      return cloudApi.searchUsers(query)
    },
    async addMember(projectId, userId, role) {
      const reference = collaborationProjectReference(projectId)
      if (reference.location === 'cloud') {
        return cloudApi.addMember(reference.projectId, userId, role)
      }
      return deliveryApiFor(services, reference.location).addCloudProjectMember(
        reference.projectId,
        userId,
        role
      )
    },
    async updateMember(projectId, userId, data) {
      const reference = collaborationProjectReference(projectId)
      if (reference.location === 'cloud') {
        return cloudApi.updateMember(reference.projectId, userId, data)
      }
      return deliveryApiFor(services, reference.location).updateCloudProjectMember(
        reference.projectId,
        userId,
        data
      )
    },
    async removeMember(projectId, userId) {
      const reference = collaborationProjectReference(projectId)
      if (reference.location === 'cloud') {
        await cloudApi.removeMember(reference.projectId, userId)
        return
      }
      await deliveryApiFor(services, reference.location).removeCloudProjectMember(
        reference.projectId,
        userId
      )
    },
    async listFiles(projectId) {
      const reference = collaborationProjectReference(projectId)
      const files =
        reference.location === 'cloud'
          ? await cloudApi.listFiles(reference.projectId)
          : (await deliveryApiFor(services, 'local').listCloudFiles(reference.projectId)).items
      return files.map(file => mapFile(file, reference))
    },
    async createFolder(projectId, path) {
      const reference = collaborationProjectReference(projectId)
      const file =
        reference.location === 'cloud'
          ? await cloudApi.createFolder(reference.projectId, path)
          : await deliveryApiFor(services, 'local').createCloudFolder(reference.projectId, path)
      return mapFile(file, reference)
    },
    async uploadFile(projectId, file, path) {
      const reference = collaborationProjectReference(projectId)
      const uploaded =
        reference.location === 'cloud'
          ? await cloudApi.uploadFile(reference.projectId, file, path)
          : await deliveryApiFor(services, 'local').uploadCloudFile(reference.projectId, file, path)
      return mapFile(uploaded, reference)
    },
    async deleteFile(fileId, recursive) {
      const reference = collaborationResourceReference(fileId)
      if (reference.location === 'cloud') {
        await cloudApi.deleteFile(reference.resourceId, recursive)
      } else {
        await deliveryApiFor(services, 'local').deleteCloudFile(reference.resourceId, recursive)
      }
    },
    async listExecutions(projectId) {
      const reference = collaborationProjectReference(projectId)
      const executions =
        reference.location === 'cloud'
          ? await cloudApi.listExecutions(reference.projectId)
          : (await deliveryApiFor(services, 'local').listLoopItemExecutions(reference.projectId))
              .items
      return executions.map(execution => mapExecution(execution, reference))
    },
    async stopExecution(projectId, executionId) {
      const reference = collaborationProjectReference(projectId)
      if (reference.location === 'cloud') {
        await cloudApi.stopExecution(reference.projectId, executionId)
      } else {
        await deliveryApiFor(services, 'local').stopExecution(reference.projectId, executionId)
      }
    },
  }
}
