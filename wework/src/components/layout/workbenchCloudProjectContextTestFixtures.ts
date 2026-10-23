import { renderHook } from '@testing-library/react'
import { vi } from 'vitest'
import type { CloudLoopItem, CloudProject } from '@/api/deliveries'
import type { WorkbenchServices } from '@/features/workbench/workbenchServices'
import type { RuntimeTaskAddress } from '@/types/api'
import { useWorkbenchCloudProjectContext } from './useWorkbenchCloudProjectContext'

export function project(id: string, projectStore: 'local' | 'backend' = 'backend'): CloudProject {
  return {
    id,
    public_id: `public-${id}`,
    project_key: id.toUpperCase(),
    name: `${id} board`,
    description: 'Shared project context',
    project_store: projectStore,
    task_provider: projectStore === 'local' ? 'local' : 'native',
    provider_config: {},
    created_by_user_id: 1,
    status: 'active',
    tags: [],
    version: 1,
    created_at: '2026-08-09T00:00:00Z',
    updated_at: '2026-08-09T00:00:00Z',
  }
}

export function loopItem(projectId: string): CloudLoopItem {
  return {
    id: 'todo-1',
    cloud_project_id: projectId,
    sequence_number: 1,
    parent_id: null,
    created_by_user_id: 1,
    assignee_user_id: null,
    title: 'Ship the refactor',
    description: 'Keep the workbench behavior stable',
    status: 'in_progress',
    priority: 'medium',
    due_at: null,
    tags: [],
    sort_order: 2,
    current_delivery_id: null,
    version: 1,
    created_at: '2026-08-09T00:00:00Z',
    updated_at: '2026-08-09T00:00:00Z',
    completed_at: null,
  }
}

interface RuntimeTestApi {
  findCloudContextForTask?: (
    task: RuntimeTaskAddress
  ) => Promise<{ project: CloudProject; loop_item: CloudLoopItem | null }>
  bindTask?: (issueId: string, task: RuntimeTaskAddress, taskTitle?: string | null) => Promise<void>
  trackProjectTask?: (
    projectId: string,
    task: RuntimeTaskAddress,
    title: string,
    description: string
  ) => Promise<{ item: CloudLoopItem }>
}

export function cloudRuntimePort(
  api: RuntimeTestApi
): NonNullable<WorkbenchServices['workspaceRuntimePort']> {
  const cachedIssues = new Map<string, CloudLoopItem | null>()
  const taskKey = (task: RuntimeTaskAddress) => `${task.deviceId}:${task.taskId}`
  return {
    async findCloudContextForTask(task) {
      if (!api.findCloudContextForTask) throw new Error('Not bound yet')
      const context = await api.findCloudContextForTask(task)
      cachedIssues.set(taskKey(task), context.loop_item)
      return {
        project: context.project,
        issueId: context.loop_item?.id ?? null,
      }
    },
    async findIssueForTask(task) {
      const issue = cachedIssues.get(taskKey(task))
      if (!issue) throw new Error('Task is not linked to an Issue')
      return issue
    },
    bindTask(issueId, task, taskTitle) {
      return api.bindTask?.(issueId, task, taskTitle) ?? Promise.resolve()
    },
    unbindTask: vi.fn().mockResolvedValue(undefined),
    unbindCloudContext: vi.fn().mockResolvedValue(undefined),
    async trackProjectTask(projectId, task, title, description) {
      if (!api.trackProjectTask) throw new Error('Tracking is not configured')
      const result = await api.trackProjectTask(projectId, task, title, description)
      cachedIssues.set(taskKey(task), result.item)
      return { issue: result.item }
    },
    reportExecutionLifecycle: vi.fn().mockResolvedValue(null),
  }
}

export function renderCloudContext(services?: WorkbenchServices) {
  return renderHook(() =>
    useWorkbenchCloudProjectContext({
      active: true,
      currentRuntimeTask: null,
      currentProjectId: 42,
      defaultProjectSpace: null,
      paneKey: 'project:42',
      runtimeTaskTitle: null,
      services,
      userId: 1,
    })
  )
}
