import { createElement, useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { act, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { CollaborationPlatformLocation, SharedWorkspaceApi } from '@wegent/collaboration'
import type { DeliveryApi } from '@/api/deliveries'
import type { createAgentResourceApi } from '@/api/agentResources'
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
  WeworkCollaborationPlatform,
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
      const [resourceNames, setResourceNames] = useState('')
      const [automationNames, setAutomationNames] = useState('')
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
      const createAgent = () => {
        const projectId = host.location.projectId
        if (!projectId) return
        void api.agents
          .create(projectId, {
            name: 'Review Agent',
            runtime: 'wegent',
            wegentTeamId: 91,
          })
          .catch(() => undefined)
      }
      const loadResources = () => {
        void api.resources
          ?.list()
          .then(resources => setResourceNames(resources.agents.map(agent => agent.name).join(',')))
          .catch(() => setResourceNames('error'))
      }
      const loadAutomations = () => {
        const projectId = host.location.projectId
        if (!projectId || !api.automations) {
          setAutomationNames('unavailable')
          return
        }
        void api.automations
          .list(projectId)
          .then(automations => setAutomationNames(automations.map(rule => rule.name).join(',')))
          .catch(() => setAutomationNames('error'))
      }
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
        ),
        createElement(
          'button',
          {
            'data-testid': `collaboration-app-create-agent-${host.location.projectId}`,
            onClick: createAgent,
            type: 'button',
          },
          'Create Agent'
        ),
        createElement(
          'button',
          {
            'data-testid': `collaboration-app-load-resources-${host.location.projectId}`,
            onClick: loadResources,
            type: 'button',
          },
          'Load resources'
        ),
        createElement(
          'span',
          {
            'data-testid': `collaboration-app-resource-names-${host.location.projectId}`,
          },
          resourceNames
        ),
        createElement(
          'button',
          {
            'data-testid': `collaboration-app-load-automations-${host.location.projectId}`,
            onClick: loadAutomations,
            type: 'button',
          },
          'Load automations'
        ),
        createElement(
          'span',
          {
            'data-testid': `collaboration-app-automation-names-${host.location.projectId}`,
          },
          automationNames
        )
      )
    },
    CollaborationPlatformApp: ({
      host,
      navigationApis,
      renderProject,
    }: {
      host: {
        location: CollaborationPlatformLocation
        navigate(next: CollaborationPlatformLocation): void
      }
      navigationApis?: SharedWorkspaceApi[]
      renderProject?(props: {
        project: Record<string, unknown>
        workspace: Record<string, unknown>
      }): ReactNode
    }) => {
      const [showLocalProject, setShowLocalProject] = useState(false)
      return createElement(
        'div',
        {
          'data-testid': 'collaboration-platform-root',
          'data-navigation-source-count': navigationApis?.length ?? 0,
        },
        createElement(
          'span',
          { 'data-testid': 'collaboration-platform-location' },
          host.location.projectId ?? 'workspace'
        ),
        createElement(
          'button',
          {
            'data-testid': 'collaboration-platform-open-local-workspace',
            onClick: () =>
              host.navigate({
                platformView: 'spaces',
                workspaceId: 'wework-local-workspace',
                workspaceView: 'home',
                projectId: null,
                projectView: 'board',
                issueId: null,
              }),
            type: 'button',
          },
          'Open workspace'
        ),
        createElement(
          'button',
          {
            'data-testid': 'collaboration-platform-render-local-project',
            onClick: () => setShowLocalProject(true),
            type: 'button',
          },
          'Render local project'
        ),
        ...['project-a', 'project-b', 'project-missing'].map(projectId =>
          createElement(
            'button',
            {
              'data-testid': `collaboration-platform-open-${projectId}`,
              key: projectId,
              onClick: () =>
                host.navigate({
                  platformView: 'project',
                  workspaceId: 'cloud-workspace',
                  workspaceView: 'projects',
                  projectId,
                  projectView: 'board',
                  issueId: null,
                }),
              type: 'button',
            },
            projectId
          )
        ),
        showLocalProject
          ? renderProject?.({
              project: {
                id: 'local-project',
                name: 'Local project',
                project_store: 'local',
                workspace_id: 'wework-local-workspace',
              },
              workspace: {
                id: 'wework-local-workspace',
                location: 'local',
                name: 'Local workspace',
              },
            })
          : null
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

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, reject, resolve }
}

describe('Wework collaboration workspace API', () => {
  it('provides local and cloud navigation as independent data sources', () => {
    render(
      createElement(WeworkCollaborationPlatform, {
        user: {
          id: 1,
          user_name: 'admin',
          email: 'admin@example.com',
        } as never,
        localProjects: [],
        services: {
          sharedWorkspaceApi: {
            workspaces: {},
            projects: {},
          },
          projectSpaceApis: {
            local: createLocalDeliveryApi(),
          },
        } as never,
      })
    )

    expect(screen.getByTestId('collaboration-platform-root')).toHaveAttribute(
      'data-navigation-source-count',
      '2'
    )
  })

  it('uses the combined platform API inside local project details', async () => {
    const createLocalAgent = vi.fn(async (_projectId: string, input: Record<string, unknown>) => ({
      id: 'LA-1',
      projectId: 'local-project',
      status: 'active',
      version: 1,
      ...input,
    }))
    const localDetailServices = {
      ...createLocalDetailServices(),
      projectChatAgentApi: {
        list: vi.fn(async () => []),
        create: createLocalAgent,
        update: vi.fn(),
      },
    } as unknown as ProjectSpaceDetailServices
    const listCloudResources = vi.fn(async () => ({
      agents: [
        {
          name: 'Review Agent',
          status: 'available',
          team_id: 91,
        },
      ],
      execution_environments: [],
    }))
    const listCloudAutomations = vi.fn().mockRejectedValue(new Error('Cloud project not found'))
    const localDeliveryApi = createLocalDeliveryApi()
    vi.mocked(localDeliveryApi.listCloudProjects).mockResolvedValue({
      items: [
        {
          id: 'local-project',
          name: 'Local project',
          project_store: 'local',
          automatic_processing_rules: [
            {
              id: 'local-automation',
              projectId: 'local-project',
              name: 'Local automation',
              enabled: true,
              version: 1,
            },
          ],
        },
      ],
    } as never)
    const getAgent = vi.fn(async () => ({
      teamId: 91,
      botId: 92,
      name: 'review-agent',
      displayName: 'Review Agent',
      namespace: 'default',
      runtime: 'Codex' as const,
      shellName: 'Codex',
      model: { name: 'gpt-5.6-sol', type: 'public' as const, namespace: 'default' },
      systemPrompt: 'Review carefully.',
      skills: [],
      mcpServers: {},
    }))

    render(
      createElement(WeworkCollaborationPlatform, {
        user: {
          id: 1,
          user_name: 'admin',
          email: 'admin@example.com',
        } as never,
        localProjects: [],
        services: {
          sharedWorkspaceApi: {
            workspaces: {},
            projects: {},
            agents: { create: vi.fn() },
            resources: { list: listCloudResources },
            automations: { list: listCloudAutomations },
          },
          projectSpaceApis: {
            local: localDeliveryApi,
          },
          projectSpaceDetailServices: {
            local: localDetailServices,
          },
          agentResourceApi: { getAgent },
        } as never,
      })
    )

    await act(async () => {
      screen.getByTestId('collaboration-platform-render-local-project').click()
    })
    await act(async () => {
      screen.getByTestId('collaboration-app-create-agent-local-project').click()
    })

    await waitFor(() => expect(createLocalAgent).toHaveBeenCalledOnce())
    expect(getAgent).toHaveBeenCalledWith(91)
    expect(createLocalAgent).toHaveBeenCalledWith(
      'local-project',
      expect.objectContaining({
        runtime: 'codex',
        wegentTeamId: 91,
        model: 'gpt-5.6-sol',
        systemPrompt: 'Review carefully.',
      })
    )

    await act(async () => {
      screen.getByTestId('collaboration-app-load-resources-local-project').click()
    })
    await waitFor(() =>
      expect(
        screen.getByTestId('collaboration-app-resource-names-local-project')
      ).toHaveTextContent('Review Agent')
    )
    expect(listCloudResources).toHaveBeenCalledOnce()

    await act(async () => {
      screen.getByTestId('collaboration-app-load-automations-local-project').click()
    })
    await waitFor(() =>
      expect(
        screen.getByTestId('collaboration-app-automation-names-local-project')
      ).toHaveTextContent('Local automation')
    )
    expect(listCloudAutomations).not.toHaveBeenCalled()
  })

  it('does not restore the system My Tasks project inside collaboration', async () => {
    const getProject = vi.fn()

    render(
      createElement(WeworkCollaborationPlatform, {
        user: {
          id: 1,
          user_name: 'admin',
          email: 'admin@example.com',
        } as never,
        localProjects: [],
        services: {
          sharedWorkspaceApi: {
            projects: {
              get: getProject,
              list: vi.fn(async () => []),
            },
          },
        } as never,
        activeProjectRef: {
          projectStore: 'local',
          projectId: 'default-work-items',
        },
        onActiveProjectChange: vi.fn(),
      })
    )

    expect(screen.getByTestId('collaboration-platform-location')).toHaveTextContent('workspace')
    expect(getProject).not.toHaveBeenCalled()
  })

  it('does not restore a stale controlled project while workspace navigation propagates', async () => {
    const getProject = vi.fn().mockResolvedValue({
      id: 'active-project',
      name: 'Active project',
      workspace_id: 'cloud-workspace',
      project_store: 'backend',
    })
    const onActiveProjectChange = vi.fn()

    render(
      createElement(WeworkCollaborationPlatform, {
        user: {
          id: 1,
          user_name: 'admin',
          email: 'admin@example.com',
        } as never,
        localProjects: [],
        services: {
          sharedWorkspaceApi: {
            projects: {
              get: getProject,
            },
          },
        } as never,
        activeProjectRef: {
          projectStore: 'backend',
          projectId: 'active-project',
        },
        onActiveProjectChange,
      })
    )

    await screen.findByText('active-project')
    await act(async () => {
      screen.getByTestId('collaboration-platform-open-local-workspace').click()
    })

    expect(onActiveProjectChange).toHaveBeenCalledWith(null)
    expect(getProject).toHaveBeenCalledTimes(1)
    expect(screen.getByTestId('collaboration-platform-location')).toHaveTextContent('workspace')
  })

  it('resumes controlled project synchronization after navigation loading fails', async () => {
    const getProject = vi.fn(async (projectId: string) => {
      if (projectId === 'project-missing') throw new Error('Project was not found')
      return {
        id: projectId,
        name: projectId,
        workspace_id: 'cloud-workspace',
        project_store: 'backend',
      }
    })

    render(
      createElement(WeworkCollaborationPlatform, {
        user: {
          id: 1,
          user_name: 'admin',
          email: 'admin@example.com',
        } as never,
        localProjects: [],
        services: {
          sharedWorkspaceApi: {
            projects: {
              get: getProject,
            },
          },
        } as never,
        activeProjectRef: {
          projectStore: 'backend',
          projectId: 'active-project',
        },
        onActiveProjectChange: vi.fn(),
      })
    )

    await screen.findByText('active-project')
    await act(async () => {
      screen.getByTestId('collaboration-platform-open-project-missing').click()
    })

    await waitFor(() => {
      expect(screen.getByTestId('collaboration-platform-location')).toHaveTextContent(
        'active-project'
      )
    })
    expect(getProject).toHaveBeenCalledWith('project-missing')
    expect(getProject).toHaveBeenCalledTimes(3)
  })

  it('ignores stale project navigation completions', async () => {
    const projectA = deferred<{
      id: string
      name: string
      workspace_id: string
      project_store: string
    }>()
    const projectB = deferred<{
      id: string
      name: string
      workspace_id: string
      project_store: string
    }>()
    const getProject = vi.fn((projectId: string) => {
      if (projectId === 'project-a') return projectA.promise
      if (projectId === 'project-b') return projectB.promise
      return Promise.resolve({
        id: projectId,
        name: projectId,
        workspace_id: 'cloud-workspace',
        project_store: 'backend',
      })
    })
    const onActiveProjectChange = vi.fn()

    render(
      createElement(WeworkCollaborationPlatform, {
        user: {
          id: 1,
          user_name: 'admin',
          email: 'admin@example.com',
        } as never,
        localProjects: [],
        services: {
          sharedWorkspaceApi: {
            projects: {
              get: getProject,
            },
          },
        } as never,
        activeProjectRef: {
          projectStore: 'backend',
          projectId: 'active-project',
        },
        onActiveProjectChange,
      })
    )

    await screen.findByText('active-project')
    act(() => {
      screen.getByTestId('collaboration-platform-open-project-a').click()
      screen.getByTestId('collaboration-platform-open-project-b').click()
    })
    await act(async () => {
      projectA.resolve({
        id: 'project-a',
        name: 'Project A',
        workspace_id: 'cloud-workspace',
        project_store: 'backend',
      })
    })
    expect(onActiveProjectChange).not.toHaveBeenCalled()

    await act(async () => {
      projectB.resolve({
        id: 'project-b',
        name: 'Project B',
        workspace_id: 'cloud-workspace',
        project_store: 'backend',
      })
    })
    expect(onActiveProjectChange).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'project-b',
        location: 'cloud',
      })
    )
  })

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

  it('omits the git repository catalog capability from the local workspace api', () => {
    const api = createLocalWorkspaceApi(
      createLocalDeliveryApi(),
      1,
      'admin',
      null,
      createLocalDetailServices()
    )

    expect(api?.gitRepositories).toBeUndefined()
  })

  it('routes local automatic processing CRUD through the combined platform API', async () => {
    let project = {
      id: 'local-project',
      name: 'Local project',
      project_store: 'local' as const,
      version: 1,
      automatic_processing_rules: [],
    }
    const deliveryApi = {
      listCloudProjects: vi.fn(async () => ({ items: [project] })),
      updateCloudProject: vi.fn(async (_projectId: string, input: Record<string, unknown>) => {
        project = {
          ...project,
          version: project.version + 1,
          automatic_processing_rules:
            (input.automatic_processing_rules as typeof project.automatic_processing_rules) ?? [],
        }
        return project
      }),
    } as unknown as DeliveryApi
    const api = createWeworkPlatformApi(
      { workspaces: {}, projects: {} } as unknown as SharedWorkspaceApi,
      deliveryApi,
      1,
      'admin',
      null
    )

    const created = await api?.automations?.create('local-project', {
      name: '新 Issue 自动处理',
      enabled: true,
      triggerType: 'event',
      eventType: 'task.created',
      eventConfig: { executionTarget: 'existing_issue' },
      targetKind: 'agent',
      targetId: 'agent-1',
    })

    expect(created).toMatchObject({
      projectId: 'local-project',
      name: '新 Issue 自动处理',
      targetKind: 'agent',
      targetId: 'agent-1',
      version: 1,
    })
    await expect(api?.automations?.list('local-project')).resolves.toEqual([created])
    expect(deliveryApi.updateCloudProject).toHaveBeenCalledWith(
      'local-project',
      expect.objectContaining({
        version: 1,
        automatic_processing_rules: [created],
      })
    )

    const updated = await api?.automations?.update('local-project', created!.id, {
      name: '更新后的自动处理',
      version: created!.version,
    })

    expect(updated).toMatchObject({
      id: created!.id,
      name: '更新后的自动处理',
      version: 2,
    })
    await expect(api?.automations?.remove('local-project', created!.id)).resolves.toEqual({
      projectVersion: 4,
      workflowAutomationId: null,
    })
    await expect(api?.automations?.list('local-project')).resolves.toEqual([])
  })

  it('routes every cloud automation operation to the cloud API', async () => {
    const cloudAutomations = {
      list: vi.fn(async () => []),
      create: vi.fn(async () => ({})),
      migrateWorkflow: vi.fn(async () => ({ automation: {}, projectVersion: 2 })),
      update: vi.fn(async () => ({})),
      remove: vi.fn(async () => ({ projectVersion: 2, workflowAutomationId: null })),
      runNow: vi.fn(async () => ({})),
      runWorkflowNode: vi.fn(async () => ({})),
      listRuns: vi.fn(async () => []),
      cancelRun: vi.fn(async () => ({})),
      retryRun: vi.fn(async () => ({})),
    }
    const api = createWeworkPlatformApi(
      {
        workspaces: {},
        projects: {},
        automations: cloudAutomations,
      } as unknown as SharedWorkspaceApi,
      createLocalDeliveryApi(),
      1,
      'admin',
      null
    )

    await api!.automations!.list('cloud-project')
    await api!.automations!.create('cloud-project', { name: 'Cloud automation' })
    await api!.automations!.migrateWorkflow('cloud-project', { version: 1 })
    await api!.automations!.update('cloud-project', 'automation-1', { version: 1 })
    await api!.automations!.remove('cloud-project', 'automation-1')
    await api!.automations!.runNow('cloud-project', 'automation-1')
    await api!.automations!.runWorkflowNode(
      'cloud-project',
      'issue-1',
      'workflow-node-1',
      'automation-1'
    )
    await api!.automations!.listRuns('cloud-project', 'automation-1')
    await api!.automations!.cancelRun('cloud-project', 'run-1')
    await api!.automations!.retryRun('cloud-project', 'run-1')

    expect(cloudAutomations.list).toHaveBeenCalledWith('cloud-project')
    expect(cloudAutomations.create).toHaveBeenCalledWith('cloud-project', {
      name: 'Cloud automation',
    })
    expect(cloudAutomations.migrateWorkflow).toHaveBeenCalledWith('cloud-project', { version: 1 })
    expect(cloudAutomations.update).toHaveBeenCalledWith('cloud-project', 'automation-1', {
      version: 1,
    })
    expect(cloudAutomations.remove).toHaveBeenCalledWith('cloud-project', 'automation-1')
    expect(cloudAutomations.runNow).toHaveBeenCalledWith('cloud-project', 'automation-1')
    expect(cloudAutomations.runWorkflowNode).toHaveBeenCalledWith(
      'cloud-project',
      'issue-1',
      'workflow-node-1',
      'automation-1'
    )
    expect(cloudAutomations.listRuns).toHaveBeenCalledWith('cloud-project', 'automation-1')
    expect(cloudAutomations.cancelRun).toHaveBeenCalledWith('cloud-project', 'run-1')
    expect(cloudAutomations.retryRun).toHaveBeenCalledWith('cloud-project', 'run-1')
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

  it('keeps local collaboration group requests off the cloud API', async () => {
    const listCloudCollaborationGroups = vi.fn()
    const cloudApi = {
      workspaces: {
        listCollaborationGroups: listCloudCollaborationGroups,
      },
      projects: {},
    } as unknown as SharedWorkspaceApi
    const api = createWeworkPlatformApi(
      cloudApi,
      createLocalDeliveryApi(),
      1,
      'admin',
      null,
      createLocalDetailServices()
    )

    await expect(
      api?.workspaces?.listCollaborationGroups('wework-local-workspace')
    ).resolves.toEqual([])
    expect(listCloudCollaborationGroups).not.toHaveBeenCalled()
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

  it('materializes a Wegent Agent resource into a runnable local project agent', async () => {
    const createLocalAgent = vi.fn(async (_projectId: string, input: Record<string, unknown>) => ({
      id: 'LA-1',
      projectId: 'local-project',
      status: 'active',
      version: 1,
      ...input,
    }))
    const localDetails = {
      ...createLocalDetailServices(),
      projectChatAgentApi: {
        list: vi.fn(async () => []),
        create: createLocalAgent,
        update: vi.fn(),
      },
    } as unknown as ProjectSpaceDetailServices
    const getAgent = vi.fn(async () => ({
      teamId: 91,
      botId: 92,
      name: 'review-agent',
      displayName: 'Review Agent',
      namespace: 'default',
      runtime: 'Codex' as const,
      shellName: 'Codex',
      model: { name: 'gpt-5.6-sol', type: 'public' as const, namespace: 'default' },
      systemPrompt: 'Review carefully.',
      skills: [{ skillId: 7, name: 'code-review', namespace: 'default', isPublic: false }],
      mcpServers: { github: { command: 'github-mcp' } },
    }))
    const agentResourceApi = {
      getAgent,
    } as unknown as ReturnType<typeof createAgentResourceApi>
    const createCloudAgent = vi.fn()
    const api = createWeworkPlatformApi(
      {
        workspaces: {},
        projects: {},
        agents: { create: createCloudAgent },
      } as unknown as SharedWorkspaceApi,
      createLocalDeliveryApi(),
      1,
      'admin',
      null,
      localDetails,
      'zh-CN',
      agentResourceApi
    )

    await expect(
      api?.agents.create('local-project', {
        name: 'Review Agent',
        runtime: 'wegent',
        wegentTeamId: 91,
      })
    ).resolves.toMatchObject({
      runtime: 'codex',
      wegentTeamId: 91,
      model: 'gpt-5.6-sol',
    })
    expect(getAgent).toHaveBeenCalledWith(91)
    expect(createLocalAgent).toHaveBeenCalledWith(
      'local-project',
      expect.objectContaining({
        runtime: 'codex',
        wegentTeamId: 91,
        model: 'gpt-5.6-sol',
        systemPrompt: 'Review carefully.',
        additionalSkills: [
          { skillId: 7, name: 'code-review', namespace: 'default', isPublic: false },
        ],
        mcpServers: { github: { command: 'github-mcp' } },
      })
    )
    expect(createCloudAgent).not.toHaveBeenCalled()
  })

  it('routes local workspace overview snapshots to the local project API', async () => {
    const localDeliveryApi = createLocalDeliveryApi()
    const getCloudBoardSnapshot = vi.fn()
    const cloudApi = {
      workspaces: {},
      projects: {},
      issues: {
        getBoardSnapshot: getCloudBoardSnapshot,
      },
    } as unknown as SharedWorkspaceApi
    const api = createWeworkPlatformApi(
      cloudApi,
      localDeliveryApi,
      1,
      'admin',
      null,
      createLocalDetailServices()
    )

    await expect(api?.issues.getBoardSnapshot('local-project')).resolves.toEqual(
      expect.objectContaining({ items: [] })
    )
    expect(localDeliveryApi.getBoardSnapshot).toHaveBeenCalledWith('local-project')
    expect(getCloudBoardSnapshot).not.toHaveBeenCalled()
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

  it('filters the system My Tasks project from local and cloud collaboration lists', async () => {
    const localDeliveryApi = createLocalDeliveryApi()
    vi.mocked(localDeliveryApi.listCloudProjects).mockResolvedValue({
      items: [
        {
          id: 'default-work-items',
          project_key: 'WORK',
          name: '我的任务',
          project_store: 'local',
          metadata: { system_kind: 'default_work_items' },
        },
        {
          id: 'local-project',
          project_key: 'LOCAL',
          name: 'Local project',
          project_store: 'local',
        },
      ],
    } as never)
    const listCloudProjects = vi.fn().mockResolvedValue([
      {
        id: 'default-work-items',
        project_key: 'WORK',
        name: 'My Tasks',
        project_store: 'backend',
        metadata: { system_kind: 'default_work_items' },
      },
      {
        id: 'cloud-project',
        project_key: 'CLOUD',
        name: 'Cloud project',
        project_store: 'backend',
        workspace_id: 'cloud-workspace',
      },
    ])
    const api = createWeworkPlatformApi(
      {
        workspaces: {},
        projects: {
          list: listCloudProjects,
        },
      } as unknown as SharedWorkspaceApi,
      localDeliveryApi,
      1,
      'admin',
      null,
      createLocalDetailServices()
    )

    await expect(api?.projects.list()).resolves.toEqual([
      expect.objectContaining({ id: 'local-project' }),
      expect.objectContaining({ id: 'cloud-project' }),
    ])
    await expect(api?.projects.list('wework-local-workspace')).resolves.toEqual([
      expect.objectContaining({ id: 'local-project' }),
    ])
    await expect(api?.workspaces?.get('wework-local-workspace')).resolves.toEqual(
      expect.objectContaining({ project_count: 1 })
    )
  })
})
