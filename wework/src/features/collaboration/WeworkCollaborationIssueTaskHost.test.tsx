// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { act, renderHook, waitFor } from '@testing-library/react'
import { isValidElement } from 'react'
import { describe, expect, it, vi } from 'vitest'
import type {
  CollaborationIssue,
  CollaborationProject,
  SharedWorkspaceApi,
} from '@wegent/collaboration'
import type { WorkbenchServices } from '@/features/workbench/workbenchServices'
import type { RuntimeTaskAddress } from '@/types/api'
import {
  toWeworkCloudExecutionProject,
  useWeworkCollaborationIssueTaskHost,
} from './WeworkCollaborationIssueTaskHost'

const project = {
  id: 'project-1',
  workspace_id: 'workspace-1',
  public_id: 'public-project-1',
  project_key: 'PROJ',
  project_store: 'backend',
  name: 'Project',
  description: 'Project description',
  task_provider: 'github',
  provider_config: {
    repository: 'wecode/Wegent',
    domain: 'example.test',
    credential_configured: true,
    unsupported_runtime_hint: 42,
  },
  created_by_user_id: 1,
  status: 'active',
  tags: ['desktop'],
  version: 2,
  created_at: '2026-09-12T00:00:00Z',
  updated_at: '2026-09-12T00:00:00Z',
} as CollaborationProject

const issue = {
  id: 'issue-1',
  cloud_project_id: 'project-1',
  title: 'Implement shared Issue start',
  status: 'inbox',
  version: 3,
  workflow: {
    nodes: [
      {
        id: 'implementation',
        depends_on: ['design'],
        workspace_policy: 'inherit',
      },
    ],
  },
} as CollaborationIssue

describe('useWeworkCollaborationIssueTaskHost', () => {
  it('builds the located backend project required by AiChatModal runtime context', () => {
    const executionProject = toWeworkCloudExecutionProject(project)

    expect(executionProject).toMatchObject({
      id: 'project-1',
      project_store: 'backend',
      location: 'cloud',
      task_provider: 'github',
      provider_config: {
        repository: 'wecode/Wegent',
        domain: 'example.test',
        credential_configured: true,
      },
    })
    expect(executionProject.provider_config).not.toHaveProperty('unsupported_runtime_hint')
  })

  it('prepares workflow context, inherits the predecessor workspace, and binds the local Task', async () => {
    const predecessor: RuntimeTaskAddress = {
      deviceId: 'device-1',
      taskId: 'task-1',
    }
    const api = {
      workflowPlans: {
        getStageContext: vi.fn().mockResolvedValue({
          compiledTaskInstruction: 'Implement the approved design',
          source: 'workflow',
        }),
      },
      taskBindings: {
        list: vi.fn().mockResolvedValue([
          {
            id: 'binding-1',
            projectId: 'project-1',
            issueId: 'issue-1',
            taskUserId: 1,
            deviceId: predecessor.deviceId,
            taskId: predecessor.taskId,
            taskTitle: 'Design',
            backendTaskId: null,
            workflowNodeId: 'design',
            bindingType: 'user',
            linkedAt: '2026-09-11T00:00:00Z',
          },
        ]),
      },
      issues: {
        get: vi.fn().mockResolvedValue(issue),
        update: vi.fn().mockResolvedValue({ ...issue, status: 'pending', version: 4 }),
      },
    } as unknown as SharedWorkspaceApi
    const runtimePort = {
      bindTask: vi.fn().mockResolvedValue(undefined),
      unbindTask: vi.fn().mockResolvedValue(undefined),
    }
    const services = {
      workspaceRuntimePort: runtimePort,
    } as unknown as WorkbenchServices
    const { result } = renderHook(() =>
      useWeworkCollaborationIssueTaskHost({
        api,
        services,
        localProjects: [],
      })
    )

    await act(async () => {
      await result.current.onCreateTask(project, issue, 'implementation')
    })

    await waitFor(() => expect(result.current.launcher).not.toBeNull())
    expect(isValidElement(result.current.launcher)).toBe(true)
    const launcherProps = (
      result.current.launcher as React.ReactElement<{
        project: {
          project_store: string
          location: string
          task_provider: string
          provider_config: Record<string, unknown>
        }
        initialTaskInput: string
        inheritFromTask: RuntimeTaskAddress | null
        prepareTask(address: RuntimeTaskAddress): Promise<(() => Promise<void>) | undefined>
        onTaskCreated(): Promise<void>
      }>
    ).props
    expect(launcherProps.project).toMatchObject({
      project_store: 'backend',
      location: 'cloud',
      task_provider: 'github',
      provider_config: {
        repository: 'wecode/Wegent',
        domain: 'example.test',
        credential_configured: true,
      },
    })
    expect(launcherProps.initialTaskInput).toBe('Implement the approved design')
    expect(launcherProps.inheritFromTask).toEqual(predecessor)

    const address = { deviceId: 'device-2', taskId: 'task-2' }
    const rollback = await launcherProps.prepareTask(address)
    expect(runtimePort.bindTask).toHaveBeenCalledWith(
      'issue-1',
      address,
      'Implement shared Issue start',
      'implementation'
    )
    await rollback?.()
    expect(runtimePort.unbindTask).toHaveBeenCalledWith('issue-1', address)

    await launcherProps.onTaskCreated()
    expect(api.issues.update).toHaveBeenCalledWith('issue-1', {
      version: 3,
      status: 'pending',
    })
  })

  it('reports a typed failure when the local runtime is unavailable', async () => {
    const onError = vi.fn()
    const { result } = renderHook(() =>
      useWeworkCollaborationIssueTaskHost({
        api: {
          workflowPlans: { getStageContext: vi.fn() },
          taskBindings: { list: vi.fn() },
          issues: { get: vi.fn(), update: vi.fn() },
        } as unknown as SharedWorkspaceApi,
        services: {} as WorkbenchServices,
        localProjects: [],
        onError,
      })
    )

    await act(async () => {
      await result.current.onCreateTask(project, issue, 'implementation')
    })

    expect(onError).toHaveBeenCalledWith({
      kind: 'runtime_unavailable',
      cause: expect.objectContaining({
        message: 'Wework local Task runtime is unavailable',
      }),
    })
    expect(result.current.launcher).toBeNull()
  })

  it('reports a typed failure when workflow context loading fails', async () => {
    const contextError = new Error('Workflow context unavailable')
    const onError = vi.fn()
    const { result } = renderHook(() =>
      useWeworkCollaborationIssueTaskHost({
        api: {
          workflowPlans: {
            getStageContext: vi.fn().mockRejectedValue(contextError),
          },
          taskBindings: { list: vi.fn() },
          issues: { get: vi.fn(), update: vi.fn() },
        } as unknown as SharedWorkspaceApi,
        services: {
          workspaceRuntimePort: {
            bindTask: vi.fn(),
            unbindTask: vi.fn(),
          },
        } as unknown as WorkbenchServices,
        localProjects: [],
        onError,
      })
    )

    await act(async () => {
      await result.current.onCreateTask(project, issue, 'implementation')
    })

    expect(onError).toHaveBeenCalledWith({
      kind: 'context_load_failed',
      cause: contextError,
    })
    expect(result.current.launcher).toBeNull()
  })
})
