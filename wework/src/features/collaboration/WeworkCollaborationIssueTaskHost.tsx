// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { useCallback, useState } from 'react'
import type {
  CollaborationIssue,
  CollaborationProject,
  SharedWorkspaceApi,
  WorkspaceTaskBinding,
} from '@wegent/collaboration'
import type { CloudLoopItem, CloudProject } from '@/api/deliveries'
import type { WorkbenchServices } from '@/features/workbench/workbenchServices'
import { rememberProjectTaskStore } from '@/features/workbench/projectTaskTracking'
import { hydrateRuntimeTaskAddress } from '@/features/workbench/workbenchRuntimeHelpers'
import type { ProjectWithTasks, RuntimeTaskAddress, RuntimeWorkListResponse } from '@/types/api'
import { AiChatModal } from '@/features/todo/AiChatModal'
import {
  publishProjectSpaceTaskBindingChanged,
  type LocatedProjectSpace,
} from '@/features/todo/projectSpaceSelection'

export interface WeworkIssueTaskStartContext {
  project: CollaborationProject
  issue: CollaborationIssue
  workflowStep?: string
}

interface WorkflowNode {
  id: string
  depends_on?: string[]
  workspace_policy?: string
}

interface IssueTaskRequest extends WeworkIssueTaskStartContext {
  initialInput: string
  inheritFromTask: RuntimeTaskAddress | null
}

export type WeworkIssueTaskStartFailure =
  | {
      kind: 'runtime_unavailable'
      cause: Error
    }
  | {
      kind: 'context_load_failed'
      cause: Error
    }

function workflowNodes(issue: CollaborationIssue): WorkflowNode[] {
  const nodes = issue.workflow?.nodes
  return Array.isArray(nodes)
    ? nodes.filter(
        (node): node is WorkflowNode =>
          typeof node === 'object' &&
          node !== null &&
          typeof (node as { id?: unknown }).id === 'string'
      )
    : []
}

function taskBindingAddress(binding: WorkspaceTaskBinding): RuntimeTaskAddress {
  return {
    deviceId: binding.deviceId,
    taskId: binding.taskId,
  }
}

function stageInstruction(
  context: Awaited<ReturnType<SharedWorkspaceApi['workflowPlans']['getStageContext']>> | null
): string {
  return context?.compiledTaskInstruction ?? ''
}

export function toWeworkCloudExecutionProject(project: CollaborationProject): LocatedProjectSpace {
  const providerConfig: CloudProject['provider_config'] = {}
  const stringKeys = [
    'repository',
    'domain',
    'api_base',
    'base_id',
    'table_id',
    'sheet_id',
    'source_url',
    'view_id',
  ] as const
  for (const key of stringKeys) {
    const value = project.provider_config[key]
    if (typeof value === 'string') providerConfig[key] = value
  }
  if (typeof project.provider_config.credential_configured === 'boolean') {
    providerConfig.credential_configured = project.provider_config.credential_configured
  }
  if (typeof project.provider_config.status_mode === 'string') {
    const statusMode = project.provider_config.status_mode
    if (statusMode === 'mapped' || statusMode === 'custom') {
      providerConfig.status_mode = statusMode
    }
  }
  if (
    Array.isArray(project.provider_config.custom_statuses) &&
    project.provider_config.custom_statuses.every(value => typeof value === 'string')
  ) {
    providerConfig.custom_statuses = project.provider_config.custom_statuses
  }
  if (
    project.provider_config.board_mapping &&
    typeof project.provider_config.board_mapping === 'object' &&
    !Array.isArray(project.provider_config.board_mapping)
  ) {
    const entries = Object.entries(project.provider_config.board_mapping).filter(
      (entry): entry is [string, string] => typeof entry[1] === 'string'
    )
    providerConfig.board_mapping = Object.fromEntries(entries)
  }
  if (
    project.provider_config.status_mapping &&
    typeof project.provider_config.status_mapping === 'object' &&
    !Array.isArray(project.provider_config.status_mapping)
  ) {
    const entries = Object.entries(project.provider_config.status_mapping).filter(
      (entry): entry is [string, string] => typeof entry[1] === 'string'
    )
    providerConfig.status_mapping = Object.fromEntries(entries)
  }

  return {
    id: String(project.id),
    public_id: project.public_id,
    project_key: project.project_key,
    name: project.name,
    description: project.description,
    project_store: 'backend',
    task_provider: project.task_provider,
    provider_config: providerConfig,
    board_config: project.board_config,
    card_display: project.card_display,
    created_by_user_id: project.created_by_user_id,
    current_user_id: project.current_user_id,
    current_user_name: project.current_user_name,
    access_role: project.access_role,
    visibility: project.visibility,
    status: project.status,
    tags: [...project.tags],
    version: project.version,
    created_at: project.created_at,
    updated_at: project.updated_at,
    location: 'cloud',
  }
}

function toCloudIssue(issue: CollaborationIssue): CloudLoopItem {
  return issue as CloudLoopItem
}

export function useWeworkCollaborationIssueTaskHost({
  api,
  services,
  localProjects,
  runtimeWork,
  onOpenRuntimeTask,
  onError,
}: {
  api: SharedWorkspaceApi
  services: WorkbenchServices
  localProjects: ProjectWithTasks[]
  runtimeWork?: RuntimeWorkListResponse | null
  onOpenRuntimeTask?: (address: RuntimeTaskAddress) => Promise<void> | void
  onError?(failure: WeworkIssueTaskStartFailure): void
}) {
  const [request, setRequest] = useState<IssueTaskRequest | null>(null)
  const runtimePort = services.workspaceRuntimePort

  const onCreateTask = useCallback(
    async (project: CollaborationProject, issue: CollaborationIssue, workflowStep?: string) => {
      try {
        if (!runtimePort) {
          onError?.({
            kind: 'runtime_unavailable',
            cause: new Error('Wework local Task runtime is unavailable'),
          })
          return
        }
        const node = workflowNodes(issue).find(candidate => candidate.id === workflowStep)
        const context = node ? await api.workflowPlans.getStageContext(issue.id, node.id) : null
        let inheritFromTask: RuntimeTaskAddress | null = null

        if (node?.workspace_policy === 'inherit' && (node.depends_on?.length ?? 0) > 0) {
          const bindings = await api.taskBindings.list(issue.id, project.id)
          const predecessor = bindings.find(binding =>
            node.depends_on?.includes(binding.workflowNodeId ?? '')
          )
          if (predecessor) {
            inheritFromTask = hydrateRuntimeTaskAddress(
              runtimeWork,
              taskBindingAddress(predecessor)
            )
          }
        }

        setRequest({
          project,
          issue,
          workflowStep,
          initialInput: stageInstruction(context),
          inheritFromTask,
        })
      } catch (cause) {
        onError?.({
          kind: 'context_load_failed',
          cause: cause instanceof Error ? cause : new Error(String(cause)),
        })
      }
    },
    [api.taskBindings, api.workflowPlans, onError, runtimePort, runtimeWork]
  )

  const prepareTask = useCallback(
    async (address: RuntimeTaskAddress) => {
      if (!request || !runtimePort) return
      await runtimePort.bindTask(
        request.issue.id,
        address,
        request.issue.title,
        request.workflowStep
      )
      rememberProjectTaskStore(address, 'backend')
      publishProjectSpaceTaskBindingChanged(address)
      return async () => {
        await runtimePort.unbindTask(request.issue.id, address)
        publishProjectSpaceTaskBindingChanged(address)
      }
    },
    [request, runtimePort]
  )

  const handleTaskCreated = useCallback(async () => {
    if (!request || request.issue.status !== 'inbox') return
    const latest = await api.issues.get(request.issue.id)
    if (latest.status !== 'inbox') return
    await api.issues.update(latest.id, {
      version: latest.version,
      status: 'pending',
    })
  }, [api.issues, request])

  const launcher = request ? (
    <AiChatModal
      key={`${request.project.id}:${request.issue.id}:${request.workflowStep ?? 'issue'}`}
      project={toWeworkCloudExecutionProject(request.project)}
      localProjects={localProjects}
      task={toCloudIssue(request.issue)}
      open
      initialTaskInput={request.initialInput}
      inheritFromTask={request.inheritFromTask}
      workflowNodeId={request.workflowStep}
      onClose={() => setRequest(null)}
      onOpenRuntimeTask={onOpenRuntimeTask}
      prepareTask={prepareTask}
      onTaskCreated={handleTaskCreated}
    />
  ) : null

  return {
    onCreateTask,
    launcher,
  }
}
