import { createElement, useCallback, useEffect, useRef, useState } from 'react'
import { act, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SharedWorkspaceApi } from '@wegent/collaboration'
import type { DeliveryApi } from '@/api/deliveries'
import { RuntimeTaskLifecycleStore } from '@/features/workbench/runtimeTaskLifecycle'
import type { ProjectSpaceDetailServices } from '@/features/workbench/workbenchServices'
import type { RuntimeTaskSummary, RuntimeWorkListResponse } from '@/types/api'
import {
  projectSpaceForRuntimeTask,
  publishProjectSpaceTaskBindingChanged,
  publishProjectSpaceTaskContextChanged,
  rememberProjectSpaceTaskBinding,
} from './projectSpaceSelection'
import {
  createLocalWorkspaceApi,
  createWeworkPlatformApi,
  projectRuntimeStatusSignature,
  toWeworkIssueTaskBinding,
  WeworkSharedProject,
} from './WeworkCollaborationPlatform'

vi.mock('@wegent/collaboration', async importOriginal => {
  const actual = await importOriginal<typeof import('@wegent/collaboration')>()
  return {
    ...actual,
    CollaborationApp: ({
      api,
      host,
      refreshProjectRequestKey = 0,
    }: {
      api: SharedWorkspaceApi
      host: { location: { projectId: string | null } }
      refreshProjectRequestKey?: number
    }) => {
      const renderCount = useRef(0)
      const [projectIds, setProjectIds] = useState('')
      const [snapshotStatuses, setSnapshotStatuses] = useState('')
      renderCount.current += 1
      const loadSnapshot = useCallback(() => {
        const projectId = host.location.projectId
        if (!projectId || !api.issues.getBoardSnapshot) return
        void api.issues
          .getBoardSnapshot(projectId)
          .then(snapshot => setSnapshotStatuses(snapshot.items.map(item => item.status).join(',')))
          .catch(() => undefined)
      }, [api.issues, host.location.projectId])
      useEffect(() => {
        loadSnapshot()
      }, [loadSnapshot, refreshProjectRequestKey])
      useEffect(() => {
        if (typeof api.projects.list !== 'function') return
        void api.projects
          .list()
          .then(projects => setProjectIds(projects.map(project => String(project.id)).join(',')))
          .catch(() => setProjectIds('error'))
      }, [api])
      return createElement(
        'div',
        {
          'data-testid': `collaboration-app-refresh-probe-${host.location.projectId}`,
          'data-refresh-key': refreshProjectRequestKey,
          'data-render-count': renderCount.current,
          'data-project-ids': projectIds,
          'data-snapshot-statuses': snapshotStatuses,
        },
        createElement(
          'button',
          {
            'data-testid': `collaboration-app-snapshot-reload-${host.location.projectId}`,
            onClick: loadSnapshot,
            type: 'button',
          },
          'Reload snapshot'
        )
      )
    },
  }
})

afterEach(() => {
  vi.useRealTimers()
})

function createLocalDeliveryApi() {
  return {
    listCloudProjects: vi.fn().mockResolvedValue({
      items: [
        {
          id: 'local-project',
          name: 'Local project',
          project_store: 'local',
        },
      ],
    }),
    getBoardSnapshot: vi.fn().mockResolvedValue({
      items: [],
      task_bindings: [],
      members: [],
      agents: [],
    }),
  } as unknown as DeliveryApi
}

function createLocalDetailServices() {
  return {
    deviceApi: {
      listDevices: vi.fn().mockResolvedValue([
        {
          id: 7,
          device_id: 'local-device',
          name: 'Local device',
          device_type: 'local',
          status: 'online',
          capabilities: ['codex'],
        },
      ]),
    },
  } as unknown as ProjectSpaceDetailServices
}

function runtimeTask(overrides: Partial<RuntimeTaskSummary> = {}): RuntimeTaskSummary {
  return {
    taskId: 'runtime-task',
    workspacePath: '/tmp/project',
    title: 'Runtime task',
    runtime: 'codex',
    ...overrides,
  }
}

function runtimeWork(tasks: RuntimeTaskSummary[]): RuntimeWorkListResponse {
  return {
    projects: [
      {
        project: { id: 1, key: 'project', name: 'Project' },
        deviceWorkspaces: [
          {
            deviceId: 'local-device',
            workspacePath: '/tmp/project',
            available: true,
            tasks,
          },
        ],
      },
    ],
    chats: [],
    totalTasks: tasks.length,
  }
}

describe('Wework collaboration workspace API', () => {
  it('maps shared board task bindings into the Issue drawer initial context', () => {
    expect(
      toWeworkIssueTaskBinding({
        id: 'binding-1',
        projectId: 'project-1',
        issueId: 'issue-1',
        taskUserId: 1,
        deviceId: 'device-1',
        taskId: 'task-1',
        taskTitle: 'Runtime task',
        backendTaskId: null,
        modelSelection: {
          modelName: 'gpt-5.6-luna',
          modelType: 'codex',
          options: {},
        },
        workflowNodeId: 'node-1',
        bindingType: 'system',
        linkedAt: '2026-09-14T00:00:00Z',
      })
    ).toEqual({
      id: 'binding-1',
      cloud_project_id: 'project-1',
      loop_item_id: 'issue-1',
      task_user_id: 1,
      device_id: 'device-1',
      task_id: 'task-1',
      task_title: 'Runtime task',
      backend_task_id: null,
      modelSelection: {
        modelName: 'gpt-5.6-luna',
        modelType: 'codex',
        options: {},
      },
      workflow_node_id: 'node-1',
      binding_type: 'system',
      linked_at: '2026-09-14T00:00:00Z',
    })
  })

  it('detects running and terminal Runtime transitions for project board refreshes', () => {
    const project = {
      projectStore: 'backend' as const,
      projectId: 'signature-project',
    }
    const lifecycleStore = new RuntimeTaskLifecycleStore('wework-collaboration-status-refresh')
    lifecycleStore.syncRuntimeWork(
      runtimeWork([
        runtimeTask({
          taskId: 'signature-runtime-task',
          running: false,
          status: 'done',
          completedAt: 1_700_000_000,
        }),
      ])
    )
    rememberProjectSpaceTaskBinding(
      {
        deviceId: 'local-device',
        taskId: 'signature-runtime-task',
      },
      project
    )
    const terminalSignature = projectRuntimeStatusSignature(lifecycleStore.getSnapshot(), project)

    lifecycleStore.executorStarted({
      deviceId: 'local-device',
      taskId: 'signature-runtime-task',
      runtime: 'codex',
      workspacePath: '/tmp/project',
    })
    const runningSignature = projectRuntimeStatusSignature(lifecycleStore.getSnapshot(), project)

    expect(terminalSignature).toContain(':succeeded')
    expect(runningSignature).toContain(':running')
    expect(runningSignature).not.toBe(terminalSignature)
  })

  it('refreshes only the cloud project bound to a changed Runtime task', async () => {
    vi.useFakeTimers()
    const lifecycleStore = new RuntimeTaskLifecycleStore('wework-cloud-status-refresh')
    const projectA = {
      projectStore: 'backend' as const,
      projectId: 'cloud-project-a',
    }
    const projectB = {
      projectStore: 'backend' as const,
      projectId: 'cloud-project-b',
    }
    lifecycleStore.syncRuntimeWork(
      runtimeWork([
        runtimeTask({
          taskId: 'cloud-project-a-task',
          running: true,
          status: 'running',
        }),
      ])
    )
    rememberProjectSpaceTaskBinding(
      {
        deviceId: 'local-device',
        taskId: 'cloud-project-a-task',
      },
      projectA
    )
    const projectProps = (projectId: string) => ({
      api: {
        projects: {},
        issues: {},
      } as unknown as SharedWorkspaceApi,
      localProjects: [],
      locale: 'zh-CN' as const,
      location: {
        platformView: 'project' as const,
        workspaceId: 'cloud-workspace',
        workspaceView: 'projects' as const,
        projectId,
        projectView: 'board' as const,
        issueId: null,
      },
      project: {
        id: projectId,
        name: projectId,
        project_store: 'backend',
      } as never,
      services: {} as never,
      setLocation: vi.fn(),
      userId: 1,
      workspace: {
        id: 'cloud-workspace',
        name: 'Cloud workspace',
      } as never,
    })
    const projects = (snapshot: ReturnType<RuntimeTaskLifecycleStore['getSnapshot']>) =>
      createElement(
        'div',
        null,
        createElement(WeworkSharedProject, {
          ...projectProps(projectA.projectId),
          runtimeTaskLifecycle: snapshot,
        }),
        createElement(WeworkSharedProject, {
          ...projectProps(projectB.projectId),
          runtimeTaskLifecycle: snapshot,
        })
      )
    const { rerender } = render(projects(lifecycleStore.getSnapshot()))

    await act(async () => {
      vi.runAllTimers()
    })
    expect(
      screen.getByTestId(`collaboration-app-refresh-probe-${projectA.projectId}`)
    ).toHaveAttribute('data-refresh-key', '3')
    expect(
      screen.getByTestId(`collaboration-app-refresh-probe-${projectB.projectId}`)
    ).toHaveAttribute('data-refresh-key', '0')

    lifecycleStore.syncRuntimeWork(
      runtimeWork([
        runtimeTask({
          taskId: 'cloud-project-a-task',
          running: false,
          status: 'done',
          completedAt: 1_700_000_000,
        }),
      ])
    )
    rerender(projects(lifecycleStore.getSnapshot()))

    await act(async () => {
      vi.runAllTimers()
    })

    expect(
      screen.getByTestId(`collaboration-app-refresh-probe-${projectA.projectId}`)
    ).toHaveAttribute('data-refresh-key', '6')
    expect(
      screen.getByTestId(`collaboration-app-refresh-probe-${projectB.projectId}`)
    ).toHaveAttribute('data-refresh-key', '0')
  })

  it('observes snapshot bindings before refreshing an already terminal Runtime lifecycle', async () => {
    vi.useFakeTimers()
    const task = {
      deviceId: 'local-device',
      taskId: 'snapshot-terminal-task',
    }
    const project = {
      projectStore: 'backend' as const,
      projectId: 'snapshot-terminal-project',
    }
    const lifecycleStore = new RuntimeTaskLifecycleStore('wework-snapshot-binding-refresh')
    lifecycleStore.syncRuntimeWork(
      runtimeWork([
        runtimeTask({
          taskId: task.taskId,
          running: false,
          status: 'done',
          completedAt: 1_700_000_000,
        }),
      ])
    )
    let resolveSnapshot:
      | ((snapshot: {
          items: []
          members: []
          agents: []
          taskBindings: Array<{
            issueId: string
            deviceId: string
            taskId: string
            projectId: string
          }>
        }) => void)
      | undefined
    const getBoardSnapshot = vi.fn(
      () =>
        new Promise<{
          items: []
          members: []
          agents: []
          taskBindings: Array<{
            issueId: string
            deviceId: string
            taskId: string
            projectId: string
          }>
        }>(resolve => {
          resolveSnapshot = resolve
        })
    )
    render(
      createElement(WeworkSharedProject, {
        api: {
          projects: {},
          issues: { getBoardSnapshot },
        } as unknown as SharedWorkspaceApi,
        localProjects: [],
        locale: 'zh-CN',
        location: {
          platformView: 'project',
          workspaceId: 'cloud-workspace',
          workspaceView: 'projects',
          projectId: project.projectId,
          projectView: 'board',
          issueId: null,
        },
        project: {
          id: project.projectId,
          name: 'Snapshot terminal project',
          project_store: project.projectStore,
        } as never,
        runtimeTaskLifecycle: lifecycleStore.getSnapshot(),
        services: {} as never,
        setLocation: vi.fn(),
        userId: 1,
        workspace: {
          id: 'cloud-workspace',
          name: 'Cloud workspace',
        } as never,
      })
    )

    expect(
      screen.getByTestId(`collaboration-app-refresh-probe-${project.projectId}`)
    ).toHaveAttribute('data-refresh-key', '0')
    expect(projectSpaceForRuntimeTask(task)).toBeUndefined()

    await act(async () => {
      resolveSnapshot?.({
        items: [],
        members: [],
        agents: [],
        taskBindings: [
          {
            issueId: 'snapshot-terminal-issue',
            deviceId: task.deviceId,
            taskId: task.taskId,
            projectId: project.projectId,
          },
        ],
      })
      await Promise.resolve()
    })
    await act(async () => {
      vi.runAllTimers()
    })

    expect(projectSpaceForRuntimeTask(task)).toEqual(project)
    expect(
      screen.getByTestId(`collaboration-app-refresh-probe-${project.projectId}`)
    ).toHaveAttribute('data-refresh-key', '3')
  })

  it('reconciles removed snapshot bindings without deleting another project mapping', async () => {
    const removedTask = {
      deviceId: 'snapshot-reconcile-device',
      taskId: 'snapshot-reconcile-removed-task',
    }
    const otherProjectTask = {
      deviceId: 'snapshot-reconcile-device',
      taskId: 'snapshot-reconcile-other-project-task',
    }
    const project = {
      projectStore: 'backend' as const,
      projectId: 'snapshot-reconcile-project',
    }
    const otherProject = {
      projectStore: 'backend' as const,
      projectId: 'snapshot-reconcile-other-project',
    }
    rememberProjectSpaceTaskBinding(otherProjectTask, otherProject)
    const getBoardSnapshot = vi
      .fn()
      .mockResolvedValueOnce({
        items: [],
        members: [],
        agents: [],
        taskBindings: [
          {
            issueId: 'snapshot-reconcile-issue',
            deviceId: removedTask.deviceId,
            taskId: removedTask.taskId,
            projectId: project.projectId,
          },
        ],
      })
      .mockResolvedValue({
        items: [],
        members: [],
        agents: [],
        taskBindings: [],
      })

    render(
      createElement(WeworkSharedProject, {
        api: {
          projects: {},
          issues: { getBoardSnapshot },
        } as unknown as SharedWorkspaceApi,
        localProjects: [],
        locale: 'zh-CN',
        location: {
          platformView: 'project',
          workspaceId: 'snapshot-reconcile-workspace',
          workspaceView: 'projects',
          projectId: project.projectId,
          projectView: 'board',
          issueId: null,
        },
        project: {
          id: project.projectId,
          name: 'Snapshot reconcile project',
          project_store: project.projectStore,
        } as never,
        services: {} as never,
        setLocation: vi.fn(),
        userId: 1,
        workspace: {
          id: 'snapshot-reconcile-workspace',
          name: 'Snapshot reconcile workspace',
        } as never,
      })
    )

    await act(async () => {
      await Promise.resolve()
    })
    expect(projectSpaceForRuntimeTask(removedTask)).toEqual(project)
    expect(projectSpaceForRuntimeTask(otherProjectTask)).toEqual(otherProject)
    const renderCountAfterFirstSnapshot = Number(
      screen
        .getByTestId(`collaboration-app-refresh-probe-${project.projectId}`)
        .getAttribute('data-render-count')
    )

    await act(async () => {
      screen.getByTestId(`collaboration-app-snapshot-reload-${project.projectId}`).click()
      await Promise.resolve()
    })

    expect(projectSpaceForRuntimeTask(removedTask)).toBeUndefined()
    expect(projectSpaceForRuntimeTask(otherProjectTask)).toEqual(otherProject)
    expect(
      Number(
        screen
          .getByTestId(`collaboration-app-refresh-probe-${project.projectId}`)
          .getAttribute('data-render-count')
      )
    ).toBeGreaterThan(renderCountAfterFirstSnapshot)
  })

  it('uses the accessible project directory for a minimal workspace navigation context', async () => {
    const currentProject = {
      id: 'restricted-current-project',
      name: 'Restricted current project',
      project_store: 'backend',
    }
    const listProjects = vi.fn(async (workspaceId?: string) => {
      if (workspaceId) throw new Error('workspace-scoped project list is forbidden')
      return [currentProject, { ...currentProject, id: 'another-accessible-project' }]
    })

    render(
      createElement(WeworkSharedProject, {
        api: {
          projects: { list: listProjects },
          issues: {},
        } as unknown as SharedWorkspaceApi,
        localProjects: [],
        locale: 'zh-CN',
        location: {
          platformView: 'project',
          workspaceId: 'restricted-workspace',
          workspaceView: 'projects',
          projectId: currentProject.id,
          projectView: 'board',
          issueId: null,
        },
        project: currentProject as never,
        services: {} as never,
        setLocation: vi.fn(),
        userId: 1,
        workspace: {
          id: 'restricted-workspace',
          public_id: 'restricted-workspace-public-id',
          location: 'cloud',
          name: 'Restricted workspace',
        },
      })
    )

    await act(async () => {
      await Promise.resolve()
    })

    expect(listProjects).toHaveBeenCalledWith()
    expect(listProjects).not.toHaveBeenCalledWith('restricted-workspace')
    expect(
      screen.getByTestId(`collaboration-app-refresh-probe-${currentProject.id}`)
    ).toHaveAttribute('data-project-ids', currentProject.id)
  })

  it('refreshes only the open project targeted by task context and binding changes', () => {
    const projectProps = (projectId: string) => ({
      api: {
        projects: {},
        issues: {},
      } as unknown as SharedWorkspaceApi,
      localProjects: [],
      locale: 'zh-CN' as const,
      location: {
        platformView: 'project' as const,
        workspaceId: 'local-workspace',
        workspaceView: 'projects' as const,
        projectId,
        projectView: 'board' as const,
        issueId: null,
      },
      project: {
        id: projectId,
        name: projectId,
        project_store: 'local',
      } as never,
      services: {} as never,
      setLocation: vi.fn(),
      userId: 1,
      workspace: {
        id: 'local-workspace',
        name: 'Local workspace',
      } as never,
    })
    render(
      createElement(
        'div',
        null,
        createElement(WeworkSharedProject, projectProps('local-project-a')),
        createElement(WeworkSharedProject, projectProps('local-project-b'))
      )
    )

    act(() => {
      publishProjectSpaceTaskContextChanged({
        task: {
          deviceId: 'local-device',
          taskId: 'runtime-moved-to-project-a',
        },
        project: {
          projectStore: 'local',
          projectId: 'local-project-a',
        },
      })
    })

    expect(screen.getByTestId('collaboration-app-refresh-probe-local-project-a')).toHaveAttribute(
      'data-refresh-key',
      '1'
    )
    expect(screen.getByTestId('collaboration-app-refresh-probe-local-project-b')).toHaveAttribute(
      'data-refresh-key',
      '0'
    )

    act(() => {
      publishProjectSpaceTaskBindingChanged({
        task: {
          deviceId: 'local-device',
          taskId: 'runtime-moved-to-project-a',
        },
        project: {
          projectStore: 'local',
          projectId: 'local-project-a',
        },
        type: 'bound',
      })
    })

    expect(screen.getByTestId('collaboration-app-refresh-probe-local-project-a')).toHaveAttribute(
      'data-refresh-key',
      '2'
    )
    expect(screen.getByTestId('collaboration-app-refresh-probe-local-project-b')).toHaveAttribute(
      'data-refresh-key',
      '0'
    )

    act(() => {
      publishProjectSpaceTaskBindingChanged({
        task: {
          deviceId: 'local-device',
          taskId: 'runtime-moved-to-project-a',
        },
        project: {
          projectStore: 'local',
          projectId: 'local-project-a',
        },
        type: 'unbound',
      })
    })

    expect(
      projectSpaceForRuntimeTask({
        deviceId: 'local-device',
        taskId: 'runtime-moved-to-project-a',
      })
    ).toBeUndefined()
    expect(screen.getByTestId('collaboration-app-refresh-probe-local-project-a')).toHaveAttribute(
      'data-refresh-key',
      '3'
    )
    expect(screen.getByTestId('collaboration-app-refresh-probe-local-project-b')).toHaveAttribute(
      'data-refresh-key',
      '0'
    )
  })

  it('refreshes an open local project for background Runtime lifecycle changes', async () => {
    vi.useFakeTimers()
    const lifecycleStore = new RuntimeTaskLifecycleStore('wework-local-background-refresh')
    const getBoardSnapshot = vi
      .fn()
      .mockResolvedValueOnce({
        items: [{ id: 'issue-1', status: 'in_progress' }],
        taskBindings: [],
      })
      .mockResolvedValue({
        items: [{ id: 'issue-1', status: 'completed' }],
        taskBindings: [],
      })
    const projectProps = {
      api: {
        projects: {},
        issues: { getBoardSnapshot },
      } as unknown as SharedWorkspaceApi,
      localProjects: [],
      locale: 'zh-CN' as const,
      location: {
        platformView: 'project' as const,
        workspaceId: 'local-workspace',
        workspaceView: 'projects' as const,
        projectId: 'local-project',
        projectView: 'board' as const,
        issueId: null,
      },
      project: {
        id: 'local-project',
        name: 'Local project',
        project_store: 'local',
      } as never,
      services: {} as never,
      setLocation: vi.fn(),
      userId: 1,
      workspace: {
        id: 'local-workspace',
        name: 'Local workspace',
      } as never,
    }
    const { rerender } = render(
      createElement(WeworkSharedProject, {
        ...projectProps,
        runtimeTaskLifecycle: lifecycleStore.getSnapshot(),
      })
    )

    await act(async () => {
      await Promise.resolve()
    })
    expect(getBoardSnapshot).toHaveBeenCalledOnce()
    expect(screen.getByTestId('collaboration-app-refresh-probe-local-project')).toHaveAttribute(
      'data-refresh-key',
      '0'
    )
    expect(screen.getByTestId('collaboration-app-refresh-probe-local-project')).toHaveAttribute(
      'data-snapshot-statuses',
      'in_progress'
    )

    act(() => {
      lifecycleStore.syncRuntimeWork(
        runtimeWork([
          runtimeTask({
            taskId: 'background-automation-task',
            running: false,
            status: 'done',
            completedAt: 1_700_000_000,
          }),
        ])
      )
      rerender(
        createElement(WeworkSharedProject, {
          ...projectProps,
          runtimeTaskLifecycle: lifecycleStore.getSnapshot(),
        })
      )
    })
    await act(async () => {
      vi.runAllTimers()
      await Promise.resolve()
    })

    expect(getBoardSnapshot).toHaveBeenCalledTimes(2)
    expect(screen.getByTestId('collaboration-app-refresh-probe-local-project')).toHaveAttribute(
      'data-refresh-key',
      '3'
    )
    expect(screen.getByTestId('collaboration-app-refresh-probe-local-project')).toHaveAttribute(
      'data-snapshot-statuses',
      'completed'
    )
  })

  it('does not refresh a cloud project for unrelated local Runtime lifecycle changes', () => {
    vi.useFakeTimers()
    const lifecycleStore = new RuntimeTaskLifecycleStore('wework-cloud-background-isolation')
    const projectProps = {
      api: {
        projects: {},
        issues: {},
      } as unknown as SharedWorkspaceApi,
      localProjects: [],
      locale: 'zh-CN' as const,
      location: {
        platformView: 'project' as const,
        workspaceId: 'cloud-workspace',
        workspaceView: 'projects' as const,
        projectId: 'cloud-project',
        projectView: 'board' as const,
        issueId: null,
      },
      project: {
        id: 'cloud-project',
        name: 'Cloud project',
        project_store: 'backend',
      } as never,
      services: {} as never,
      setLocation: vi.fn(),
      userId: 1,
      workspace: {
        id: 'cloud-workspace',
        name: 'Cloud workspace',
      } as never,
    }
    const { rerender } = render(
      createElement(WeworkSharedProject, {
        ...projectProps,
        runtimeTaskLifecycle: lifecycleStore.getSnapshot(),
      })
    )

    lifecycleStore.syncRuntimeWork(
      runtimeWork([
        runtimeTask({
          taskId: 'unrelated-local-runtime-task',
          running: false,
          status: 'done',
          completedAt: 1_700_000_000,
        }),
      ])
    )
    rerender(
      createElement(WeworkSharedProject, {
        ...projectProps,
        runtimeTaskLifecycle: lifecycleStore.getSnapshot(),
      })
    )
    act(() => {
      vi.runAllTimers()
    })

    expect(screen.getByTestId('collaboration-app-refresh-probe-cloud-project')).toHaveAttribute(
      'data-refresh-key',
      '0'
    )
  })

  it('refreshes only the cloud project named by a live Issue change and cleans up subscriptions', async () => {
    const listeners: Array<(event: { projectId: string }) => void> = []
    const releases = [vi.fn(), vi.fn()]
    const subscribeLoopItemChanges = vi.fn(
      async (listener: (event: { projectId: string }) => void) => {
        listeners.push(listener)
        return releases[listeners.length - 1]
      }
    )
    const projectProps = (projectId: string) => ({
      api: {
        projects: {},
        issues: {},
      } as unknown as SharedWorkspaceApi,
      detailServices: {
        projectChatClient: {
          subscribeLoopItemChanges,
        },
      } as unknown as ProjectSpaceDetailServices,
      localProjects: [],
      locale: 'zh-CN' as const,
      location: {
        platformView: 'project' as const,
        workspaceId: 'cloud-workspace',
        workspaceView: 'projects' as const,
        projectId,
        projectView: 'board' as const,
        issueId: null,
      },
      project: {
        id: projectId,
        name: projectId,
        project_store: 'backend',
      } as never,
      services: {} as never,
      setLocation: vi.fn(),
      userId: 1,
      workspace: {
        id: 'cloud-workspace',
        name: 'Cloud workspace',
      } as never,
    })
    const { unmount } = render(
      createElement(
        'div',
        null,
        createElement(WeworkSharedProject, projectProps('cloud-project-a')),
        createElement(WeworkSharedProject, projectProps('cloud-project-b'))
      )
    )

    await act(async () => {
      await Promise.resolve()
    })
    expect(subscribeLoopItemChanges).toHaveBeenCalledTimes(2)

    act(() => {
      for (const listener of listeners) {
        listener({ projectId: 'cloud-project-a' })
      }
    })

    expect(screen.getByTestId('collaboration-app-refresh-probe-cloud-project-a')).toHaveAttribute(
      'data-refresh-key',
      '1'
    )
    expect(screen.getByTestId('collaboration-app-refresh-probe-cloud-project-b')).toHaveAttribute(
      'data-refresh-key',
      '0'
    )

    unmount()
    expect(releases[0]).toHaveBeenCalledOnce()
    expect(releases[1]).toHaveBeenCalledOnce()
  })

  it('exposes local project execution environments through the shared project contract', async () => {
    const api = createLocalWorkspaceApi(
      createLocalDeliveryApi(),
      1,
      'admin',
      null,
      createLocalDetailServices()
    )

    await expect(api?.projects.listExecutionEnvironments('local-project')).resolves.toEqual([
      expect.objectContaining({
        id: 'device:local-device',
        device_id: 7,
        device_key: 'local-device',
        name: 'Local device',
        coding_tools: ['codex'],
        kind: 'local_device',
        status: 'online',
      }),
    ])
  })

  it('keeps project execution environment methods when local and cloud APIs are combined', async () => {
    const cloudEnvironment = {
      id: 'cloud-environment',
      device_id: 8,
      device_key: 'cloud-device',
      name: 'Cloud device',
      coding_tools: ['codex'],
      kind: 'cloud_host' as const,
      owner_type: 'user' as const,
      owner_id: '1',
      owner_name: 'admin',
      status: 'online' as const,
      updated_at: '2026-09-14T00:00:00.000Z',
    }
    const listCloudExecutionEnvironments = vi.fn().mockResolvedValue([cloudEnvironment])
    const cloudApi = {
      workspaces: {},
      projects: {
        listExecutionEnvironments: listCloudExecutionEnvironments,
      },
    } as unknown as SharedWorkspaceApi
    const api = createWeworkPlatformApi(
      cloudApi,
      createLocalDeliveryApi(),
      1,
      'admin',
      null,
      createLocalDetailServices()
    )

    await expect(api?.projects.listExecutionEnvironments('cloud-project')).resolves.toEqual([
      cloudEnvironment,
    ])
    expect(listCloudExecutionEnvironments).toHaveBeenCalledWith('cloud-project')
  })

  it('keeps local project resource setup on the local API after creation', async () => {
    const listCloudMembers = vi.fn()
    const cloudApi = {
      workspaces: {},
      projects: {},
      members: {
        list: listCloudMembers,
      },
      agents: {},
    } as unknown as SharedWorkspaceApi
    const api = createWeworkPlatformApi(
      cloudApi,
      createLocalDeliveryApi(),
      1,
      'admin',
      null,
      createLocalDetailServices()
    )

    await expect(api?.members.list('local-project')).resolves.toEqual([
      expect.objectContaining({
        user_id: 1,
        user_name: 'admin',
        role: 'Owner',
      }),
    ])
    expect(listCloudMembers).not.toHaveBeenCalled()
  })

  it('keeps local navigation projects available when the cloud project list fails', async () => {
    const listCloudProjects = vi.fn().mockRejectedValue(new Error('cloud unavailable'))
    const listCloudWorkspaces = vi.fn().mockRejectedValue(new Error('cloud unavailable'))
    const cloudApi = {
      workspaces: {
        list: listCloudWorkspaces,
      },
      projects: {
        list: listCloudProjects,
      },
    } as unknown as SharedWorkspaceApi
    const api = createWeworkPlatformApi(
      cloudApi,
      createLocalDeliveryApi(),
      1,
      'admin',
      null,
      createLocalDetailServices()
    )

    const [workspaces, projects] = await Promise.all([
      api!.workspaces!.list(),
      api!.projects.list(),
    ])

    expect(workspaces).toEqual([
      expect.objectContaining({
        id: 'wework-local-workspace',
        name: '本地空间',
      }),
    ])
    expect(projects).toEqual([
      expect.objectContaining({
        id: 'local-project',
        name: 'Local project',
        workspace_id: 'wework-local-workspace',
      }),
    ])
    expect(listCloudWorkspaces).toHaveBeenCalledWith()
    expect(listCloudProjects).toHaveBeenCalledWith()
  })

  it('combines local and cloud projects for the platform navigation list', async () => {
    const listCloudProjects = vi.fn().mockResolvedValue([
      {
        id: 'cloud-project',
        name: 'Cloud project',
        workspace_id: 'cloud-workspace',
      },
    ])
    const cloudApi = {
      workspaces: {},
      projects: {
        list: listCloudProjects,
      },
    } as unknown as SharedWorkspaceApi
    const api = createWeworkPlatformApi(
      cloudApi,
      createLocalDeliveryApi(),
      1,
      'admin',
      null,
      createLocalDetailServices()
    )

    await expect(api?.projects.list()).resolves.toEqual([
      expect.objectContaining({
        id: 'local-project',
        workspace_id: 'wework-local-workspace',
      }),
      expect.objectContaining({
        id: 'cloud-project',
        workspace_id: 'cloud-workspace',
      }),
    ])
    expect(listCloudProjects).toHaveBeenCalledWith()
  })

  it('keeps workspace operation snapshots on the project storage owner', async () => {
    const localDeliveryApi = createLocalDeliveryApi()
    const getCloudBoardSnapshot = vi.fn().mockResolvedValue({
      items: [],
      taskBindings: [],
      members: [],
      agents: [],
    })
    const cloudApi = {
      workspaces: {},
      projects: {},
      issues: { getBoardSnapshot: getCloudBoardSnapshot },
    } as unknown as SharedWorkspaceApi
    const api = createWeworkPlatformApi(
      cloudApi,
      localDeliveryApi,
      1,
      'admin',
      null,
      createLocalDetailServices()
    )

    await api?.issues.getBoardSnapshot('local-project')
    await api?.issues.getBoardSnapshot('cloud-project')

    expect(localDeliveryApi.getBoardSnapshot).toHaveBeenCalledOnce()
    expect(localDeliveryApi.getBoardSnapshot).toHaveBeenCalledWith('local-project')
    expect(getCloudBoardSnapshot).toHaveBeenCalledOnce()
    expect(getCloudBoardSnapshot).toHaveBeenCalledWith('cloud-project')
  })
})
