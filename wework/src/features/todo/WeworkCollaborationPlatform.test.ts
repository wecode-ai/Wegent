import { DEFAULT_WORK_ITEM_PROJECT_ID, type DeliveryApi } from '@/api/deliveries'
import { ApiError } from '@/api/http'
import { createLocalProjectChatAgentApi } from '@/api/local/localDelivery'
import {
  CloudConnectionContext,
  DISCONNECTED_STATE,
  type CloudConnectionContextValue,
} from '@/features/cloud-connection/CloudConnectionContext'
import { clearRuntimeConversationCacheForTests } from '@/features/workbench/runtimeConversationCache'
import { RuntimeTaskLifecycleStore } from '@/features/workbench/runtimeTaskLifecycle'
import type {
  LocalProjectSpaceApi,
  ProjectSpaceDetailServices,
} from '@/features/workbench/workbenchServices'
import i18n from '@/i18n'
import type { RuntimeTaskSummary, RuntimeWorkListResponse } from '@/types/api'
import { act, render, screen, waitFor } from '@testing-library/react'
import type {
  CollaborationApp,
  CollaborationPlatformLocation,
  SharedWorkspaceApi,
} from '@wegent/collaboration'
import {
  createElement,
  useCallback,
  useEffect,
  useRef,
  useState,
  type ComponentProps,
  type ReactNode,
} from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { TodoEditor } from './TodoEditor'
import {
  createLocalWorkspaceApi,
  createWeworkPlatformApi,
  toWeworkIssueTaskBinding,
  WeworkCollaborationPlatform,
  WeworkSharedProject,
} from './WeworkCollaborationPlatform'
import { resolveDeviceResourceSettingsOptions } from './deviceResourceSettings'
import {
  projectSpaceForRuntimeTask,
  publishProjectSpaceTaskBindingChanged,
  publishProjectSpaceTaskContextChanged,
  rememberProjectSpaceTaskBinding,
} from './projectSpaceSelection'
import { updateIssueWhenPersonalTaskStarts } from './workItemTaskInput'

type BoardIssueCardRenderer = NonNullable<
  ComponentProps<typeof CollaborationApp>['renderBoardIssueCard']
>

const renderedProjectApis = vi.hoisted(() => new Map<string, SharedWorkspaceApi>())
const renderedProjectControls = vi.hoisted(
  () =>
    new Map<
      string,
      {
        onCreateTask?: (project: unknown, issue: unknown) => Promise<void> | void
        onProjectChange?: (project: unknown) => void
        renderIssueDetail?: (context: unknown) => unknown
        renderBoardIssueCard?: BoardIssueCardRenderer
      }
    >()
)

vi.mock('@wegent/collaboration', async importOriginal => {
  const actual = await importOriginal<typeof import('@wegent/collaboration')>()
  return {
    ...actual,
    CollaborationApp: ({
      api,
      host,
      initialProject,
      onCreateTask,
      onProjectChange,
      refreshProjectRequestKey = 0,
      renderIssueDetail,
      renderBoardIssueCard,
    }: {
      api: SharedWorkspaceApi
      host: {
        location: { projectId: string | null }
        manageResource?(kind: 'agents' | 'environments', resourceId?: string): void
      }
      initialProject?: { id: string }
      onCreateTask?: (project: unknown, issue: unknown) => Promise<void> | void
      onProjectChange?: (project: unknown) => void
      refreshProjectRequestKey?: number
      renderIssueDetail?: (context: unknown) => unknown
      renderBoardIssueCard?: BoardIssueCardRenderer
    }) => {
      if (host.location.projectId) renderedProjectApis.set(host.location.projectId, api)
      if (initialProject) {
        renderedProjectControls.set(String(initialProject.id), {
          onCreateTask,
          onProjectChange,
          renderIssueDetail,
          renderBoardIssueCard,
        })
      }
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
            runtime: 'codex',
            model: 'gpt-5.6-sol',
            systemPrompt: 'Review carefully.',
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
        ),
        createElement(
          'button',
          {
            'data-testid': `collaboration-app-manage-environments-${host.location.projectId}`,
            onClick: () => host.manageResource?.('environments'),
            type: 'button',
          },
          'Manage environments'
        )
      )
    },
    CollaborationPlatformApp: ({
      host,
      navigationApis,
      refreshKey,
      renderProject,
    }: {
      host: {
        accountScope: string
        location: CollaborationPlatformLocation
        capabilities: {
          workspaceLocations?: readonly ('local' | 'cloud')[]
        }
        navigate(next: CollaborationPlatformLocation): void
        renderProjectImporter?: (input: {
          workspace: Record<string, unknown>
          mode: 'folder' | 'existing'
          projects: Record<string, unknown>[]
          onClose(): void
          onImported(project: Record<string, unknown>): Promise<void>
        }) => ReactNode
      }
      navigationApis?: SharedWorkspaceApi[]
      refreshKey?: string
      renderProject?(props: {
        project: Record<string, unknown>
        workspace: Record<string, unknown>
      }): ReactNode
    }) => {
      const [showLocalProject, setShowLocalProject] = useState(false)
      const [showProjectImporter, setShowProjectImporter] = useState(false)
      return createElement(
        'div',
        {
          'data-testid': 'collaboration-platform-root',
          'data-account-scope': host.accountScope,
          'data-navigation-source-count': navigationApis?.length ?? 0,
          'data-refresh-key': refreshKey ?? '',
          'data-workspace-locations': host.capabilities.workspaceLocations?.join(',') ?? '',
          'data-issue-id': host.location.issueId ?? '',
          'data-project-view': host.location.projectView,
          'data-project-settings-section': host.location.projectSettingsSection ?? '',
        },
        createElement(
          'span',
          {
            'data-testid': 'collaboration-platform-location',
            'data-workspace-id': host.location.workspaceId ?? '',
          },
          host.location.rootView ?? host.location.projectId ?? 'workspace'
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
        createElement(
          'button',
          {
            'data-testid': 'collaboration-platform-import-local-project',
            onClick: () => setShowProjectImporter(true),
            type: 'button',
          },
          'Import local project'
        ),
        ...(['agents', 'teams', 'devices'] as const).map(destination =>
          createElement(
            'button',
            {
              'data-testid': `collaboration-platform-open-${destination}`,
              key: destination,
              onClick: () =>
                host.navigate({
                  platformView: 'spaces',
                  rootView: destination,
                  workspaceId: null,
                  workspaceView: 'home',
                  projectId: null,
                  projectView: 'board',
                  issueId: null,
                }),
              type: 'button',
            },
            destination
          )
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
        createElement(
          'button',
          {
            'data-testid': 'collaboration-platform-open-issue',
            onClick: () => host.navigate({ ...host.location, issueId: 'issue-1' }),
            type: 'button',
          },
          'Open issue'
        ),
        createElement(
          'button',
          {
            'data-testid': 'collaboration-platform-manage-project',
            onClick: () =>
              host.navigate({
                ...host.location,
                projectView: 'manage',
                projectSettingsSection: 'environments',
              }),
            type: 'button',
          },
          'Manage project'
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
          : null,
        showProjectImporter
          ? host.renderProjectImporter?.({
              workspace: {
                id: 'wework-local-workspace',
                location: 'local',
                name: 'Local workspace',
              },
              mode: 'existing',
              projects: [
                {
                  id: 'local-project',
                  metadata: {
                    code_project_key: 'runtime-project',
                    workspace_roots: ['/workspace/imported', 'c:/work/repo'],
                  },
                },
              ],
              onClose: () => setShowProjectImporter(false),
              onImported: async project => {
                setShowProjectImporter(false)
                host.navigate({
                  platformView: 'spaces',
                  workspaceId: String(project.workspace_id),
                  workspaceView: 'projects',
                  projectId: String(project.id),
                  projectView: 'board',
                  issueId: null,
                })
              },
            })
          : null
      )
    },
  }
})

afterEach(() => {
  vi.useRealTimers()
  clearRuntimeConversationCacheForTests()
  renderedProjectControls.clear()
  renderedProjectApis.clear()
  localStorage.clear()
})

function createLocalDeliveryApi() {
  return {
    listCloudProjects: vi.fn().mockResolvedValue({
      items: [
        {
          id: DEFAULT_WORK_ITEM_PROJECT_ID,
          project_key: 'WORK',
          name: 'My Tasks',
          project_store: 'local',
          metadata: { system_kind: 'default_work_items' },
          collaboration_groups: [],
        },
        {
          id: 'local-project',
          name: 'Local project',
          project_store: 'local',
          metadata: { code_project_key: 'runtime-project' },
        },
      ],
    }),
    getBoardSnapshot: vi.fn().mockResolvedValue({
      items: [],
      task_bindings: [],
      members: [],
      agents: [],
    }),
    importLocalCodeProject: vi.fn().mockResolvedValue({
      id: 'local-project',
      name: 'Local project',
      project_store: 'local',
      metadata: {
        code_project_key: 'runtime-project',
        workspace_roots: ['/workspace/imported'],
      },
    }),
  } as unknown as LocalProjectSpaceApi
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
          capabilities: ['runtime-work', 'device-commands'],
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
  it('does not reject task creation when the Issue start update fails', async () => {
    const issues = {
      get: vi.fn().mockResolvedValue({
        id: 'ISSUE-1',
        status: 'pending',
        tags: [],
        version: 4,
      }),
      update: vi.fn().mockRejectedValue(new Error('没有权限更新 Issue')),
    }

    await expect(updateIssueWhenPersonalTaskStarts(issues, 'ISSUE-1')).resolves.toBe(
      '没有权限更新 Issue'
    )
    expect(issues.update).toHaveBeenCalledWith('ISSUE-1', {
      status: 'in_progress',
      version: 4,
    })
  })

  it('keeps the cloud project choice available before cloud login', () => {
    render(
      createElement(WeworkCollaborationPlatform, {
        user: {
          id: 1,
          user_name: 'admin',
          email: 'admin@example.com',
        } as never,
        localProjects: [],
        services: {
          projectSpaceApis: {
            local: createLocalDeliveryApi(),
          },
        } as never,
      })
    )

    expect(screen.getByTestId('collaboration-platform-root')).toHaveAttribute(
      'data-workspace-locations',
      'local,cloud'
    )
  })

  it.each([
    ['https://first.example/api', null, 'https://first.example/api:local:7'],
    ['https://first.example/api', 42, 'https://first.example/api:account:42'],
    ['https://first.example/api', 43, 'https://first.example/api:account:43'],
    ['https://second.example/api', 42, 'https://second.example/api:account:42'],
  ] as const)(
    'publishes the account scope for backend %s and cloud owner %s',
    async (backend, ownerId, scope) => {
      const cloudConnection: CloudConnectionContextValue = {
        ...DISCONNECTED_STATE,
        status: ownerId ? 'connected' : 'disconnected',
        apiBaseUrl: backend,
        token: ownerId ? 'synthetic-cloud-token' : null,
        user: ownerId ? { id: ownerId, user_name: 'cloud-owner', email: '' } : null,
        isConnected: Boolean(ownerId),
        serviceKey: scope,
        connectWithAuthorization: vi.fn(),
        refreshUser: vi.fn(),
        disconnect: vi.fn(),
      }
      await act(async () => {
        render(
          createElement(
            CloudConnectionContext.Provider,
            { value: cloudConnection },
            createElement(WeworkCollaborationPlatform, {
              user: { id: 7, user_name: 'local-owner', email: '' } as never,
              localProjects: [],
              services: { projectSpaceApis: { local: createLocalDeliveryApi() } } as never,
            })
          )
        )
      })

      expect(screen.getByTestId('collaboration-platform-root')).toHaveAttribute(
        'data-account-scope',
        scope
      )
    }
  )

  it('keeps local project data and Agent configuration independent of cloud resources', async () => {
    const createLocalAgent = vi.fn(async (_projectId: string, input: Record<string, unknown>) => ({
      id: 'LA-1',
      projectId: 'local-project',
      status: 'active',
      version: 1,
      ...input,
    }))
    const localDetailServices = {
      ...createLocalDetailServices(),
      localProjectChatAgentApi: {
        list: vi.fn(async () => []),
        ensureDefault: vi.fn(async (_projectId: string, input: Record<string, unknown>) => ({
          id: 'LA-default',
          projectId: 'default-work-items',
          status: 'active',
          version: 1,
          ...input,
        })),
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
    const issue = { id: 'LOCAL-1', cloud_project_id: 'local-project', title: '执行pwd', version: 1 }
    localDeliveryApi.createLoopItem = vi.fn().mockResolvedValue(issue)
    localDeliveryApi.getLoopItem = vi.fn().mockResolvedValue(issue)
    localDeliveryApi.updateLoopItem = vi.fn().mockResolvedValue({ ...issue, version: 2 })
    localDeliveryApi.archiveLoopItem = vi.fn().mockResolvedValue(undefined)
    const cloudIssues = {
      create: vi.fn().mockRejectedValue(new Error('Request parameter validation failed')),
      get: vi.fn().mockRejectedValue(new Error('Local Issue sent to cloud')),
      update: vi.fn().mockRejectedValue(new Error('Local Issue sent to cloud')),
      archive: vi.fn().mockRejectedValue(new Error('Local Issue sent to cloud')),
    }
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
            issues: cloudIssues,
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
    expect(getAgent).not.toHaveBeenCalled()
    expect(createLocalAgent).toHaveBeenCalledWith(
      'local-project',
      expect.objectContaining({
        runtime: 'codex',
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
      ).toHaveTextContent('当前设备智能体')
    )
    expect(listCloudResources).not.toHaveBeenCalled()

    await act(async () => {
      screen.getByTestId('collaboration-app-load-automations-local-project').click()
    })
    await waitFor(() =>
      expect(
        screen.getByTestId('collaboration-app-automation-names-local-project')
      ).toHaveTextContent('Local automation')
    )
    expect(listCloudAutomations).not.toHaveBeenCalled()

    const projectApi = renderedProjectApis.get('local-project')!
    await expect(
      projectApi.issues.create('local-project', { title: '执行pwd' })
    ).resolves.toMatchObject(issue)
    await expect(projectApi.issues.get('LOCAL-1')).resolves.toMatchObject(issue)
    await projectApi.issues.update('LOCAL-1', { version: 1, title: '执行ls' })
    await projectApi.issues.archive('LOCAL-1')
    expect(localDeliveryApi.createLoopItem).toHaveBeenCalledWith('local-project', {
      title: '执行pwd',
    })
    expect(localDeliveryApi.getLoopItem).toHaveBeenCalledWith('LOCAL-1')
    expect(localDeliveryApi.updateLoopItem).toHaveBeenCalledWith('LOCAL-1', {
      version: 1,
      title: '执行ls',
    })
    expect(localDeliveryApi.archiveLoopItem).toHaveBeenCalledWith('LOCAL-1')
    for (const request of Object.values(cloudIssues)) expect(request).not.toHaveBeenCalled()
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
    // The route already names the project the failed navigation fell back to,
    // so recovering it costs no second lookup of that project.
    expect(getProject).toHaveBeenCalledTimes(2)
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

  it('preserves project settings when changing locale without a routed Issue focus', async () => {
    const previousLanguage = i18n.language
    const project = {
      id: 'project-a',
      name: 'Project A',
      workspace_id: 'cloud-workspace',
      project_store: 'backend',
    }
    render(
      createElement(WeworkCollaborationPlatform, {
        user: { id: 1, user_name: 'admin', email: 'admin@example.com' } as never,
        localProjects: [],
        services: {
          sharedWorkspaceApi: {
            workspaces: {},
            projects: { get: vi.fn().mockResolvedValue(project) },
          },
          projectSpaceApis: { local: createLocalDeliveryApi() },
        } as never,
        activeProjectRef: { projectStore: 'backend', projectId: project.id },
      })
    )
    await act(async () => {
      await Promise.resolve()
    })
    await act(async () => screen.getByTestId('collaboration-platform-manage-project').click())
    expect(screen.getByTestId('collaboration-platform-root')).toHaveAttribute(
      'data-project-view',
      'manage'
    )
    try {
      await act(async () => {
        await i18n.changeLanguage(previousLanguage.startsWith('zh') ? 'en' : 'zh-CN')
      })
      expect(screen.getByTestId('collaboration-platform-root')).toHaveAttribute(
        'data-project-view',
        'manage'
      )
      expect(screen.getByTestId('collaboration-platform-root')).toHaveAttribute(
        'data-project-settings-section',
        'environments'
      )
    } finally {
      await act(async () => {
        await i18n.changeLanguage(previousLanguage)
      })
    }
  })

  it.each([
    { destination: 'an Issue in the same project', projectId: 'project-a' },
    { destination: 'an Issue in another project', projectId: 'project-b' },
    {
      destination: 'another comment in the same Issue',
      projectId: 'project-a',
      initialIssueId: 'notification-issue',
      initialCommentId: 'previous-comment',
    },
    {
      destination: 'a repeated notification for the same comment',
      projectId: 'project-a',
      initialIssueId: 'notification-issue',
      initialCommentId: 'notification-comment',
    },
  ])(
    'does not complete old board navigation after an external focus on $destination',
    async route => {
      const project = {
        id: 'project-a',
        name: 'Project A',
        workspace_id: 'cloud-workspace',
        project_store: 'backend',
      }
      const pendingProject = deferred<typeof project>()
      const getProject = vi
        .fn()
        .mockResolvedValueOnce(project)
        .mockImplementation((projectId: string) =>
          projectId === project.id
            ? pendingProject.promise
            : Promise.resolve({ ...project, id: projectId })
        )
      const onActiveProjectChange = vi.fn()
      const props = {
        user: {
          id: 1,
          user_name: 'admin',
          email: 'admin@example.com',
        } as never,
        localProjects: [],
        services: {
          sharedWorkspaceApi: {
            projects: { get: getProject },
          },
        } as never,
        activeProjectRef: {
          projectStore: 'backend' as const,
          projectId: project.id,
        },
        focusedItemId: route.initialIssueId,
        focusedCommentId: route.initialCommentId,
        focusedCommentRequestKey: route.initialCommentId ? 'previous-request' : undefined,
        onActiveProjectChange,
      }
      const view = render(createElement(WeworkCollaborationPlatform, props))
      await waitFor(() => expect(getProject).toHaveBeenCalledTimes(1))

      await act(async () => {
        screen.getByTestId('collaboration-platform-open-project-a').click()
      })
      expect(getProject).toHaveBeenCalledTimes(2)
      expect(onActiveProjectChange).not.toHaveBeenCalled()

      view.rerender(
        createElement(WeworkCollaborationPlatform, {
          ...props,
          activeProjectRef: { ...props.activeProjectRef, projectId: route.projectId },
          focusedItemId: 'notification-issue',
          focusedCommentId: 'notification-comment',
          focusedCommentRequestKey: 'notification-request',
        })
      )
      await waitFor(() =>
        expect(screen.getByTestId('collaboration-platform-root')).toHaveAttribute(
          'data-issue-id',
          'notification-issue'
        )
      )
      expect(screen.getByTestId('collaboration-platform-location')).toHaveTextContent(
        route.projectId
      )

      await act(async () => {
        pendingProject.resolve(project)
      })

      expect(onActiveProjectChange).not.toHaveBeenCalled()
      expect(screen.getByTestId('collaboration-platform-root')).toHaveAttribute(
        'data-issue-id',
        'notification-issue'
      )
    }
  )

  it.each([
    'active',
    'archived',
    'foreign',
    'unlinked',
    'ambiguous-alias',
    'local',
    'superseded',
    'superseded-error',
    'dismissed',
  ] as const)(
    'checks %s linked task availability through the shared project drawer',
    async status => {
      const project = {
        id: `availability-${status}`,
        name: 'Availability',
        project_store: status === 'local' ? 'local' : 'backend',
      }
      const issue = { id: 'ISSUE-AVAILABILITY', title: 'Availability', sequence_number: 1 }
      const binding = {
        id: 'binding',
        projectId: project.id,
        issueId: issue.id,
        taskUserId: status === 'local' ? 0 : status === 'foreign' ? 2 : 1,
        deviceId: 'device',
        taskId: 'task',
        taskTitle: 'Personal task',
        backendTaskId: null,
        linkedAt: '2026-10-20T00:00:00Z',
      }
      const pendingRead = deferred<{ success: boolean; code?: string }>()
      const delayed =
        status === 'superseded' || status === 'superseded-error' || status === 'dismissed'
      const laterBinding = { ...binding, id: 'later', taskId: 'later-task' }
      const readTask = vi.fn((_deviceId: string, taskId: string) =>
        delayed && taskId === binding.taskId
          ? pendingRead.promise
          : Promise.resolve(
              status === 'archived' ? { success: false, code: 'task_archived' } : { success: true }
            )
      )
      render(
        createElement(WeworkSharedProject, {
          api: {
            projects: { list: vi.fn().mockResolvedValue([project]) },
            issues: {},
            taskBindings: {
              list: vi.fn().mockResolvedValue(status === 'unlinked' ? [] : [binding, laterBinding]),
            },
          } as unknown as SharedWorkspaceApi,
          localProjects: [],
          locale: 'zh-CN',
          location: {
            platformView: 'project',
            workspaceId: 'workspace',
            workspaceView: 'projects',
            projectId: project.id,
            projectView: 'board',
            issueId: issue.id,
          },
          project: project as never,
          runtimePort: { bindTask: vi.fn(), unbindTask: vi.fn() },
          services: {
            standInApi: {
              readTask,
              deviceIdentity: vi.fn(async (deviceId: string) => ({
                deviceId,
                backendDeviceId: status === 'ambiguous-alias' ? 'app-record-42' : deviceId,
              })),
            },
          } as never,
          setLocation: vi.fn(),
          userId: 1,
          workspace: { id: 'workspace', name: 'Workspace' } as never,
        })
      )
      const detail = () =>
        renderedProjectControls.get(project.id)!.renderIssueDetail!({
          api: { issues: {} },
          issue,
          allIssues: [issue],
          assignments: [],
          taskBindings: [],
          onChange: vi.fn(),
          onClose: vi.fn(),
          onCreateTask: vi.fn(),
          onDelete: vi.fn(),
        }) as {
          props: {
            conversation: ReactNode
            onClose(): void
            children(close: () => void): { props: ComponentProps<typeof TodoEditor> }
          }
        }
      const editor = detail().props.children(vi.fn())
      await act(async () => {
        editor.props.onOpenTaskConversation?.(toWeworkIssueTaskBinding(binding))
      })
      if (delayed) {
        await waitFor(() => expect(readTask).toHaveBeenCalledWith('device', 'task'))
        await act(async () => {
          if (status === 'dismissed') detail().props.onClose()
          else editor.props.onOpenTaskConversation?.(toWeworkIssueTaskBinding(laterBinding))
        })
        const latestConversation = detail().props.conversation
        if (status !== 'dismissed') expect(latestConversation).not.toBeNull()
        await act(async () => {
          pendingRead.resolve(
            status === 'superseded-error'
              ? { success: false, code: 'task_archived' }
              : { success: true }
          )
        })
        expect(detail().props.conversation).toBe(latestConversation)
        expect(screen.queryByTestId('transient-notice')).not.toBeInTheDocument()
        return
      }
      if (status === 'active' || status === 'local') {
        await waitFor(() => expect(detail().props.conversation).not.toBeNull())
        expect(readTask).toHaveBeenCalledWith('device', 'task')
      } else {
        expect(await screen.findByTestId('transient-notice')).toHaveTextContent(
          status === 'archived'
            ? '该任务已归档，请先在归档任务中恢复后再查看。'
            : '无法打开该任务，任务可能已被删除，请刷新后重试。'
        )
        expect(detail().props.conversation).toBeNull()
        if (status !== 'archived') expect(readTask).not.toHaveBeenCalled()
      }
    }
  )

  it.each([false, true])(
    'keeps personal tasks on the current computer and retains the Issue reference (human work: %s)',
    async humanWork => {
      const project = {
        id: 'local-environment-project',
        name: 'Local environment project',
        project_store: 'local',
      }
      render(
        createElement(WeworkSharedProject, {
          api: {
            projects: {
              list: vi.fn().mockResolvedValue([project]),
            },
            issues: {},
          } as unknown as SharedWorkspaceApi,
          localProjects: [],
          locale: 'zh-CN',
          location: {
            platformView: 'project',
            workspaceId: 'wework-local-workspace',
            workspaceView: 'projects',
            projectId: project.id,
            projectView: 'board',
            issueId: 'ISSUE-ENV',
          },
          project: project as never,
          runtimePort: {
            bindTask: vi.fn(),
            unbindTask: vi.fn(),
          },
          services: {} as never,
          setLocation: vi.fn(),
          userId: 1,
          workspace: {
            id: 'wework-local-workspace',
            name: 'Local workspace',
          } as never,
        })
      )
      const updatedProject = {
        ...project,
        execution_environment: {
          workspace_policy: 'project',
          repositories: [],
          setup_steps: [],
          devices: {
            'prepared-device': {
              status: 'ready',
              workspace_path: '/workspace/prepared-project',
            },
          },
        },
      }
      const controls = renderedProjectControls.get(project.id)
      const issue = {
        id: 'ISSUE-ENV',
        title: 'Use the prepared environment',
        sequence_number: 1,
        ...(humanWork
          ? {
              human_task_binding: {
                humanAssignmentId: 'human-assignment',
                dispatchId: 'direct-human:assignment',
                dispatchRoundId: 'direct',
                assignmentId: 'assignment',
              },
            }
          : {}),
      }

      expect(controls?.onProjectChange).toBeTypeOf('function')
      expect(controls?.onCreateTask).toBeTypeOf('function')
      expect(controls?.renderIssueDetail).toBeTypeOf('function')
      act(() => controls?.onProjectChange?.(updatedProject))
      await act(async () => {
        await controls?.onCreateTask?.(updatedProject, issue)
      })
      const detail = renderedProjectControls.get(project.id)?.renderIssueDetail?.({
        api: { issues: {} },
        issue,
        allIssues: [issue],
        assignments: [],
        taskBindings: [],
        onChange: vi.fn(),
        onClose: vi.fn(),
        onCreateTask: vi.fn(),
        onDelete: vi.fn(),
      }) as {
        props: {
          conversation: {
            props: { initialTaskRequest?: unknown; initialTaskInput?: string }
          } | null
        }
      }

      expect(detail.props.conversation?.props.initialTaskRequest).not.toHaveProperty('deviceId')
      expect(detail.props.conversation?.props.initialTaskRequest).not.toHaveProperty(
        'workspacePath'
      )
      if (humanWork) {
        expect(detail.props.conversation?.props.initialTaskRequest).toMatchObject({
          origin: {
            humanAssignmentId: 'human-assignment',
            dispatchId: 'direct-human:assignment',
            roundId: 'direct',
            assignmentId: 'assignment',
          },
        })
      }
      expect(detail.props.conversation?.props.initialTaskInput).toContain(
        '[$#1 · Use the prepared environment](wework-issue://local-environment-project/ISSUE-ENV)'
      )
    }
  )

  it('reports assignment lookup errors without creating an unbound task and allows retry', async () => {
    const project = { id: 'dispatch-lookup', name: 'Assignments', project_store: 'local' }
    const issue = { id: 'ISSUE-1', title: 'Inspect CPU', sequence_number: 1 }
    const subscribe = vi.fn().mockRejectedValue(new Error('offline'))
    render(
      createElement(WeworkSharedProject, {
        api: { projects: {}, issues: {} } as unknown as SharedWorkspaceApi,
        detailServices: { projectChatClient: { subscribe } } as never,
        localProjects: [],
        locale: 'zh-CN',
        location: {
          platformView: 'project',
          workspaceId: 'workspace',
          workspaceView: 'projects',
          projectId: project.id,
          projectView: 'board',
          issueId: issue.id,
        },
        project: project as never,
        runtimePort: { bindTask: vi.fn(), unbindTask: vi.fn() },
        services: {} as never,
        setLocation: vi.fn(),
        userId: 1,
        workspace: { id: 'workspace', name: 'Workspace' } as never,
      })
    )
    const detailContext = {
      api: { issues: {} },
      issue,
      allIssues: [issue],
      assignments: [],
      taskBindings: [],
      onChange: vi.fn(),
      onClose: vi.fn(),
      onCreateTask: vi.fn(),
      onDelete: vi.fn(),
    }
    const conversation = () =>
      (
        renderedProjectControls.get(project.id)?.renderIssueDetail?.(detailContext) as {
          props: { conversation: unknown }
        }
      ).props.conversation
    await act(async () => {
      await renderedProjectControls.get(project.id)?.onCreateTask?.(project, issue)
    })
    expect(screen.getByTestId('transient-notice')).toHaveTextContent('offline')
    expect(conversation()).toBeNull()
    subscribe.mockResolvedValue({
      snapshot: {
        messages: [
          {
            metadata: {
              activity_type: 'manager_assignment',
              dispatch_id: 'dispatch-1',
              coordination_round_id: 'round-1',
              dispatch_assignments: [
                {
                  assignee_type: 'human',
                  human_user_id: 1,
                  human_assignment_id: 'human-1',
                  assignment_id: 'assignment-1',
                  task_title: 'Collect CPU evidence',
                  instructions: 'Measure CPU usage.',
                },
              ],
            },
          },
        ],
        currentUserId: '1',
        latestSequence: 1,
      },
      unsubscribe: vi.fn(),
    })
    await act(async () => {
      await renderedProjectControls.get(project.id)?.onCreateTask?.(project, issue)
    })
    expect(conversation()).toMatchObject({
      props: {
        initialTaskRequest: {
          origin: {
            dispatchId: 'dispatch-1',
            roundId: 'round-1',
            assignmentId: 'assignment-1',
            humanAssignmentId: 'human-1',
          },
        },
      },
    })
    expect(screen.queryByTestId('transient-notice')).not.toBeInTheDocument()
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

  it('does not refresh a local board for unrelated tasks or unchanged execution status', async () => {
    vi.useFakeTimers()
    const lifecycleStore = new RuntimeTaskLifecycleStore('local-board-refresh-scope')
    const project = { projectStore: 'local' as const, projectId: 'local-refresh-scope' }
    const address = { deviceId: 'local-device', taskId: 'local-refresh-task' }
    rememberProjectSpaceTaskBinding(address, project)
    lifecycleStore.syncRuntimeTask(
      address,
      runtimeTask({ taskId: address.taskId, running: true, status: 'running' })
    )
    const props = {
      api: { projects: {}, issues: {} } as unknown as SharedWorkspaceApi,
      localProjects: [],
      locale: 'zh-CN' as const,
      location: {
        platformView: 'project' as const,
        workspaceId: 'local-workspace',
        workspaceView: 'projects' as const,
        projectId: project.projectId,
        projectView: 'board' as const,
        issueId: null,
      },
      project: { id: project.projectId, name: 'Local', project_store: 'local' } as never,
      services: {} as never,
      setLocation: vi.fn(),
      userId: 1,
      workspace: { id: 'local-workspace', name: 'Local' } as never,
    }
    const view = () =>
      createElement(WeworkSharedProject, {
        ...props,
        runtimeTaskLifecycle: lifecycleStore.getSnapshot(),
      })
    const { rerender } = render(view())
    await act(async () => {
      vi.runAllTimers()
    })
    const refreshKey = () =>
      screen
        .getByTestId(`collaboration-app-refresh-probe-${project.projectId}`)
        .getAttribute('data-refresh-key')
    const initialKey = refreshKey()

    lifecycleStore.syncRuntimeTask(
      { deviceId: 'local-device', taskId: 'unrelated-task' },
      runtimeTask({ taskId: 'unrelated-task', running: true, status: 'running' })
    )
    rerender(view())
    await act(async () => {
      vi.runAllTimers()
    })
    expect(refreshKey()).toBe(initialKey)

    lifecycleStore.syncRuntimeTask(
      address,
      runtimeTask({
        taskId: address.taskId,
        running: true,
        status: 'running',
        updatedAt: '2026-11-07T15:00:00Z',
      })
    )
    rerender(view())
    await act(async () => {
      vi.runAllTimers()
    })
    expect(refreshKey()).toBe(initialKey)

    lifecycleStore.syncRuntimeTask(
      address,
      runtimeTask({
        taskId: address.taskId,
        running: false,
        status: 'done',
        completedAt: '2026-11-07T15:01:00Z',
      })
    )
    rerender(view())
    await act(async () => {
      vi.runAllTimers()
    })
    expect(Number(refreshKey())).toBe(Number(initialKey) + 3)
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

  it('places listed, newly created and updated local projects in the single local space', async () => {
    const delivery = {
      ...createLocalDeliveryApi(),
      createCloudProject: vi.fn().mockResolvedValue({ id: 'new-local', name: 'New local' }),
      updateCloudProject: vi.fn().mockResolvedValue({ id: 'new-local', name: 'Renamed' }),
    }
    const api = createLocalWorkspaceApi(delivery, 1, 'admin', null)!
    const projects = await api.projects.list()
    expect(projects).toHaveLength(1)
    expect(projects.every(project => project.workspace_id === 'wework-local-workspace')).toBe(true)
    expect(await api.projects.create({ name: 'New local' })).toMatchObject({
      workspace_id: 'wework-local-workspace',
    })
    expect(await api.projects.update('new-local', { name: 'Renamed', version: 1 })).toMatchObject({
      workspace_id: 'wework-local-workspace',
    })
  })

  it('does not add the default local Agent when creating a project without a selection', async () => {
    const ensureDefault = vi.fn()
    const createCloudProject = vi.fn().mockResolvedValue({ id: 'new-local', name: 'New local' })
    const details = {
      ...createLocalDetailServices(),
      localProjectChatAgentApi: {
        list: vi.fn(async () => []),
        ensureDefault,
        create: vi.fn(),
        update: vi.fn(),
        archive: vi.fn(),
      },
    } as unknown as ProjectSpaceDetailServices
    const api = createLocalWorkspaceApi(
      {
        ...createLocalDeliveryApi(),
        createCloudProject,
      },
      1,
      'admin',
      null,
      details
    )!

    await api.projects.create({
      name: 'New local',
    })

    expect(createCloudProject).toHaveBeenCalledWith(
      expect.not.objectContaining({ includeDefaultAgent: expect.anything() })
    )
    expect(ensureDefault).not.toHaveBeenCalled()
  })

  it('keeps a created local project when default-Agent provisioning fails', async () => {
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const ensureDefault = vi.fn().mockRejectedValue(new Error('agent unavailable'))
    const details = {
      ...createLocalDetailServices(),
      localProjectChatAgentApi: {
        list: vi.fn(async () => []),
        ensureDefault,
        create: vi.fn(),
        update: vi.fn(),
        archive: vi.fn(),
      },
    } as unknown as ProjectSpaceDetailServices
    const api = createLocalWorkspaceApi(
      {
        ...createLocalDeliveryApi(),
        createCloudProject: vi.fn().mockResolvedValue({ id: 'new-local', name: 'New local' }),
      },
      1,
      'admin',
      null,
      details
    )!

    await expect(
      api.projects.create({ name: 'New local', includeDefaultAgent: true })
    ).resolves.toMatchObject({
      id: 'new-local',
      name: 'New local',
    })
    expect(warning).toHaveBeenCalledWith(
      expect.stringContaining('project new-local'),
      expect.any(Error)
    )
    warning.mockRestore()
  })

  it('initializes the latest persisted local environment when the rendered version is stale', async () => {
    const executionEnvironment = {
      repositories: [],
      setup_steps: [{ command: 'pnpm install', working_directory: '' }],
    }
    const updateCloudProject = vi
      .fn()
      .mockImplementation(async (_projectId: string, input: Record<string, unknown>) => ({
        id: 'local-project',
        name: 'Local project',
        project_store: 'local',
        version: 3,
        execution_environment: input.execution_environment,
      }))
    const delivery = {
      ...createLocalDeliveryApi(),
      listCloudProjects: vi.fn().mockResolvedValue({
        items: [
          {
            id: DEFAULT_WORK_ITEM_PROJECT_ID,
            project_key: 'WORK',
            name: 'My Tasks',
            project_store: 'local',
            metadata: { system_kind: 'default_work_items' },
          },
          {
            id: 'local-project',
            name: 'Local project',
            project_store: 'local',
            version: 2,
            execution_environment: executionEnvironment,
          },
        ],
      }),
      updateCloudProject,
    } as unknown as DeliveryApi
    const executeCommand = vi.fn().mockResolvedValue({
      success: true,
      stdout: JSON.stringify({ workspacePath: '/workspace/local-project' }),
      stderr: '',
      error: '',
    })
    const details = {
      ...createLocalDetailServices(),
      deviceApi: {
        ...createLocalDetailServices().deviceApi,
        executeCommand,
      },
    } as unknown as ProjectSpaceDetailServices
    const api = createLocalWorkspaceApi(delivery, 1, 'admin', null, details)!

    await expect(
      api.projects.initializeExecutionEnvironment!('local-project', {
        deviceId: 7,
        version: 1,
      })
    ).resolves.toMatchObject({
      version: 3,
      execution_environment: {
        devices: {
          'local-device': {
            status: 'ready',
            workspace_path: '/workspace/local-project',
          },
        },
      },
    })
    expect(updateCloudProject).toHaveBeenCalledWith(
      'local-project',
      expect.objectContaining({
        version: 2,
        execution_environment: expect.objectContaining({
          setup_steps: executionEnvironment.setup_steps,
        }),
      })
    )
  })

  it('persists local workspace execution configuration through its backing project', async () => {
    const executionEnvironment = {
      workspace_policy: 'git_worktree',
      repositories: [],
      setup_steps: [{ command: 'pnpm install', working_directory: '' }],
    }
    const updateCloudProject = vi.fn().mockResolvedValue({
      id: DEFAULT_WORK_ITEM_PROJECT_ID,
      project_key: 'WORK',
      name: 'My Tasks',
      project_store: 'local',
      metadata: { system_kind: 'default_work_items' },
      version: 2,
      execution_environment: executionEnvironment,
    })
    const delivery = {
      ...createLocalDeliveryApi(),
      listCloudProjects: vi.fn().mockResolvedValue({
        items: [
          {
            id: DEFAULT_WORK_ITEM_PROJECT_ID,
            project_key: 'WORK',
            name: 'My Tasks',
            project_store: 'local',
            metadata: { system_kind: 'default_work_items' },
            version: 1,
          },
          {
            id: 'local-project',
            name: 'Local project',
            project_store: 'local',
            version: 1,
          },
        ],
      }),
      updateCloudProject,
    } as unknown as DeliveryApi
    const api = createLocalWorkspaceApi(delivery, 1, 'admin', null, createLocalDetailServices())!

    await expect(
      api.workspaces!.update('wework-local-workspace', {
        version: 1,
        executionEnvironment: {
          repositories: [],
          setupSteps: [{ command: 'pnpm install', workingDirectory: '' }],
        },
      })
    ).resolves.toMatchObject({
      version: 2,
      execution_environment: executionEnvironment,
    })
    expect(updateCloudProject).toHaveBeenCalledWith(
      DEFAULT_WORK_ITEM_PROJECT_ID,
      expect.objectContaining({
        version: 1,
        execution_environment: executionEnvironment,
      })
    )
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
      createLocalWorkspaceApi(deliveryApi, 1, 'admin', null)
    )

    const created = await api?.automations?.create('local-project', {
      name: '新 Issue 自动处理',
      prompt: '处理新 Issue',
      enabled: true,
      triggerType: 'event',
      eventType: 'task.created',
      eventConfig: { executionTarget: 'existing_issue' },
      cronExpression: null,
      timezone: 'Asia/Shanghai',
      executionDeviceId: null,
      targetKind: 'agent',
      targetId: 'agent-1',
    })

    expect(created).toMatchObject({
      projectId: 'local-project',
      name: '新 Issue 自动处理',
      targetKind: 'agent',
      targetId: 'agent-1',
      targetName: 'agent-1',
      nextRunAt: null,
      lastRunAt: null,
      lastRunStatus: null,
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
      createLocalWorkspaceApi(createLocalDeliveryApi(), 1, 'admin', null)
    )

    await api!.automations!.list('cloud-project')
    await api!.automations!.create('cloud-project', { name: 'Cloud automation' })
    await api!.automations!.migrateWorkflow('cloud-project', { version: 1 })
    await api!.automations!.update('cloud-project', 'automation-1', { version: 1 })
    await api!.automations!.remove('cloud-project', 'automation-1')
    await api!.automations!.runNow('cloud-project', 'automation-1')
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
      createLocalWorkspaceApi(
        createLocalDeliveryApi(),
        1,
        'admin',
        null,
        createLocalDetailServices()
      )
    )

    await expect(api?.projects.listExecutionEnvironments('cloud-project')).resolves.toEqual([
      cloudEnvironment,
    ])
    expect(listCloudExecutionEnvironments).toHaveBeenCalledWith('cloud-project')
  })

  it('refreshes external Agent writes through both local workspace adapters', async () => {
    let records: Array<{ id: string; name: string; runtime: string; status: string }> = []
    const request = vi.fn(async () => records)
    const details = {
      ...createLocalDetailServices(),
      localProjectChatAgentApi: createLocalProjectChatAgentApi(request, 1),
    }
    const cloudList = vi.fn()
    const cloudApi = {
      workspaces: {},
      agents: { list: cloudList },
    } as unknown as SharedWorkspaceApi
    const api = createWeworkPlatformApi(
      cloudApi,
      createLocalWorkspaceApi(createLocalDeliveryApi(), 1, 'admin', null, details)
    )!
    await expect(api.agents.list('local-project')).resolves.toEqual([])
    records = [{ id: 'external', name: 'External Agent', runtime: 'codex', status: 'active' }]
    await expect(api.agents.list('local-project')).resolves.toEqual([])
    await expect(api.agents.list('local-project', { forceRefresh: true })).resolves.toMatchObject([
      { id: 'external', name: 'External Agent' },
    ])
    await expect(api.agents.list('local-project')).resolves.toMatchObject([{ id: 'external' }])
    expect(request).toHaveBeenCalledTimes(2)
    expect(cloudList).not.toHaveBeenCalled()
  })

  it('keeps local Issue list requests off the cloud API', async () => {
    const localIssue = {
      id: 'local-issue',
      cloud_project_id: 'local-project',
      title: 'Local issue',
    }
    const localDeliveryApi = {
      ...createLocalDeliveryApi(),
      listLoopItems: vi.fn().mockResolvedValue({ items: [localIssue] }),
    } as unknown as DeliveryApi
    const listCloudIssues = vi.fn().mockRejectedValue(new Error('local project reached cloud API'))
    const cloudApi = {
      workspaces: {},
      projects: {},
      issues: {
        list: listCloudIssues,
      },
    } as unknown as SharedWorkspaceApi
    const api = createWeworkPlatformApi(
      cloudApi,
      createLocalWorkspaceApi(localDeliveryApi, 1, 'admin', null, createLocalDetailServices())
    )

    await expect(api?.issues.list('local-project')).resolves.toEqual([localIssue])
    expect(localDeliveryApi.listLoopItems).toHaveBeenCalledWith('local-project', undefined)
    expect(listCloudIssues).not.toHaveBeenCalled()
  })

  it('does not route local Issue lookup failures to the cloud API', async () => {
    const localFailure = new ApiError('Local Issue storage is unavailable', 500)
    const localDeliveryApi = {
      ...createLocalDeliveryApi(),
      getLoopItem: vi.fn().mockRejectedValue(localFailure),
    } as unknown as DeliveryApi
    const getCloudIssue = vi.fn()
    const api = createWeworkPlatformApi(
      {
        workspaces: {},
        projects: {},
        issues: {
          get: getCloudIssue,
        },
      } as unknown as SharedWorkspaceApi,
      createLocalWorkspaceApi(localDeliveryApi, 1, 'admin', null, createLocalDetailServices())
    )

    await expect(api?.issues.get('local-issue')).rejects.toBe(localFailure)
    expect(getCloudIssue).not.toHaveBeenCalled()
  })

  it('uses the cloud API when a local Issue lookup reports not found', async () => {
    const cloudIssue = {
      id: 'cloud-issue',
      cloud_project_id: 'cloud-project',
      title: 'Cloud issue',
    }
    const localDeliveryApi = {
      ...createLocalDeliveryApi(),
      getLoopItem: vi.fn().mockRejectedValue(new Error('Local task not found')),
    } as unknown as DeliveryApi
    const getCloudIssue = vi.fn().mockResolvedValue(cloudIssue)
    const api = createWeworkPlatformApi(
      {
        workspaces: {},
        projects: {},
        issues: {
          get: getCloudIssue,
        },
      } as unknown as SharedWorkspaceApi,
      createLocalWorkspaceApi(localDeliveryApi, 1, 'admin', null, createLocalDetailServices())
    )

    await expect(api?.issues.get(cloudIssue.id)).resolves.toEqual(cloudIssue)
    expect(getCloudIssue).toHaveBeenCalledWith(cloudIssue.id)
  })

  it('adds a local space group to a project without duplicating or deleting its source', async () => {
    const records = [DEFAULT_WORK_ITEM_PROJECT_ID, 'local-project'].map(id => ({
      id,
      name: id,
      project_store: 'local' as const,
      version: 1,
      collaboration_groups: [] as unknown[],
    }))
    const update = vi.fn(async (id: string, input: Record<string, unknown>) => {
      const project = records.find(record => record.id === id)!
      Object.assign(project, input, { version: project.version + 1 })
      return project
    })
    const cloudAdd = vi.fn()
    const api = createWeworkPlatformApi(
      {
        projects: { addCollaborationGroup: cloudAdd },
        workspaces: {},
      } as unknown as SharedWorkspaceApi,
      createLocalWorkspaceApi(
        {
          listCloudProjects: vi.fn(async () => ({ items: records })),
          updateCloudProject: update,
        } as unknown as DeliveryApi,
        1,
        'admin',
        null
      )
    )!
    const group = await api.workspaces!.createCollaborationGroup('wework-local-workspace', {
      name: '111',
      coordinationMode: 'manager',
      leader: { kind: 'human', id: '1' },
      members: [{ kind: 'human', id: '1' }],
    })
    await expect(
      api.workspaces!.createCollaborationGroup('wework-local-workspace', {
        name: '负责人不执行',
        coordinationMode: 'manager',
        leader: { kind: 'human', id: '1' },
        members: [
          { kind: 'human', id: '1' },
          { kind: 'agent', id: 'worker' },
        ],
        stages: [
          {
            id: 'implementation',
            name: '实现',
            assignee: { kind: 'human', id: '1' },
          },
        ],
      })
    ).rejects.toThrow('Collaboration group leader cannot execute a stage')
    update.mockClear()
    await expect(api.projects.addCollaborationGroup!('local-project', group.id)).resolves.toEqual(
      group
    )
    await api.projects.addCollaborationGroup!('local-project', group.id)
    expect(update).toHaveBeenCalledTimes(1)
    await expect(api.projects.listCollaborationGroups!('local-project')).resolves.toEqual([group])
    await expect(api.projects.addCollaborationGroup!('local-project', 'missing')).rejects.toThrow(
      'not found'
    )
    await api.projects.removeCollaborationGroup!('local-project', group.id)
    await expect(api.projects.listCollaborationGroups!('local-project')).resolves.toEqual([])
    await expect(
      api.workspaces!.listCollaborationGroups('wework-local-workspace')
    ).resolves.toEqual([group])
    expect(cloudAdd).not.toHaveBeenCalled()
  })

  it('preserves the unresolved identity of a visible local device placeholder', async () => {
    const detailServices = createLocalDetailServices()
    vi.mocked(detailServices.deviceApi.listDevices).mockResolvedValueOnce([
      {
        id: 0,
        device_id: 'local-device',
        name: 'Local Executor',
        device_type: 'local',
        status: 'offline',
        is_default: true,
        bind_shell: 'claudecode',
        local_identity_unresolved: true,
      },
    ])
    const api = createLocalWorkspaceApi(createLocalDeliveryApi(), 1, 'admin', null, detailServices)!

    await expect(api.resources?.devices.local?.()).resolves.toEqual([
      expect.objectContaining({
        device_key: 'local-device',
        status: 'offline',
        local_identity_unresolved: true,
      }),
    ])
  })

  it('keeps the local resource catalog available when default-Agent provisioning fails', async () => {
    const diagnostic = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const detailServices = {
      ...createLocalDetailServices(),
      localProjectChatAgentApi: {
        list: vi.fn().mockRejectedValue(new Error('list unavailable')),
        ensureDefault: vi.fn().mockRejectedValue(new Error('agent unavailable')),
        create: vi.fn(),
      },
    } as unknown as ProjectSpaceDetailServices
    const api = createLocalWorkspaceApi(createLocalDeliveryApi(), 1, 'admin', null, detailServices)!

    await expect(api.resources!.list()).resolves.toMatchObject({ agents: [] })
    expect(
      diagnostic.mock.calls.map(([prefix, record]) => [prefix, JSON.parse(String(record))])
    ).toEqual(
      ['agents', 'default-agent'].map(catalog => [
        '[Wework] Local workspace catalog failed',
        {
          source: 'local',
          catalog,
          status: 'rejected',
          elapsedMs: expect.any(Number),
          errorName: 'Error',
          reason: 'rejected',
          httpStatus: null,
        },
      ])
    )
    expect(JSON.stringify(diagnostic.mock.calls)).not.toMatch(/list unavailable|agent unavailable/)
    diagnostic.mockRestore()
  })

  it('shares one default-Agent bootstrap across concurrent local resource reads', async () => {
    const pending = deferred<{
      id: string
      name: string
      displayName: string
      runtime: string
      status: string
      version: number
    }>()
    const ensureDefault = vi.fn(() => pending.promise)
    const detailServices = {
      ...createLocalDetailServices(),
      localProjectChatAgentApi: {
        list: vi.fn().mockResolvedValue([]),
        ensureDefault,
        create: vi.fn(),
      },
    } as unknown as ProjectSpaceDetailServices
    const api = createLocalWorkspaceApi(createLocalDeliveryApi(), 1, 'admin', null, detailServices)!

    const resources = api.resources!.list()
    const workspaceAgents = api.workspaces!.listAgents('wework-local-workspace')
    pending.resolve({
      id: 'LA-default',
      name: 'current-device-agent',
      displayName: '当前设备智能体',
      runtime: 'codex',
      status: 'active',
      version: 1,
    })

    await expect(Promise.all([resources, workspaceAgents])).resolves.toHaveLength(2)
    expect(ensureDefault).toHaveBeenCalledOnce()
  })

  it.each(['current-device-agent'])(
    'returns consistent edit and deletion controls for local Agent %s',
    async name => {
      const record = {
        id: 'LA-created',
        name,
        displayName: 'Manually added Agent',
        runtime: 'codex',
        status: 'active',
        version: 1,
      }
      const localProjectChatAgentApi = {
        list: vi.fn().mockResolvedValue([record]),
        create: vi.fn().mockResolvedValue(record),
        update: vi.fn().mockResolvedValue(record),
      }
      const details = {
        ...createLocalDetailServices(),
        localProjectChatAgentApi,
      } as unknown as ProjectSpaceDetailServices
      const api = createLocalWorkspaceApi(createLocalDeliveryApi(), 1, 'admin', null, details)!
      const [listed] = await api.agents.list('local-project')

      expect(listed).toMatchObject({
        agent_id: name,
        name: record.displayName,
        can_edit: true,
        deletable: name !== 'current-device-agent',
      })
      await expect(api.agents.create('local-project', { name, runtime: 'codex' })).resolves.toEqual(
        listed
      )
      await expect(
        api.agents.update('local-project', record.id, {
          version: 1,
          displayName: record.displayName,
        })
      ).resolves.toEqual(listed)
    }
  )

  it('does not allow deleting the default local Agent', async () => {
    const archive = vi.fn()
    const update = vi.fn()
    const defaultAgent = {
      id: 'LA-default',
      name: 'current-device-agent',
      displayName: '当前设备智能体',
      runtime: 'codex',
      status: 'active',
      version: 1,
    }
    const detailServices = {
      ...createLocalDetailServices(),
      localProjectChatAgentApi: {
        list: vi.fn().mockResolvedValue([defaultAgent]),
        ensureDefault: vi.fn(),
        create: vi.fn(),
        archive,
        update,
      },
    } as unknown as ProjectSpaceDetailServices
    const api = createLocalWorkspaceApi(createLocalDeliveryApi(), 1, 'admin', null, detailServices)!
    const [resource] = (await api.resources!.list()).agents

    await expect(api.resources!.removeAgent!(resource)).rejects.toThrow('默认本地智能体不能删除')
    await expect(
      api.agents.update('local-project', defaultAgent.id, {
        version: 1,
        status: 'archived',
      })
    ).rejects.toThrow('默认本地智能体不能停用')
    expect(archive).not.toHaveBeenCalled()
    expect(update).not.toHaveBeenCalled()
  })

  it('keeps local Agent resources local when cloud resource loading fails', async () => {
    const localAgent = {
      id: 'LA-local',
      name: '本地代码助手',
      capabilityDescription: '处理本地代码',
      systemPrompt: 'Work locally.',
      runtime: 'codex',
      status: 'active',
      executionDeviceId: 'local-device',
    }
    const defaultAgent = {
      ...localAgent,
      id: 'LA-default',
      name: 'current-device-agent',
      displayName: '当前设备智能体',
    }
    const detailServices = {
      ...createLocalDetailServices(),
      localProjectChatAgentApi: {
        list: vi.fn().mockResolvedValue([localAgent]),
        ensureDefault: vi.fn(async () => defaultAgent),
        create: vi.fn(),
      },
    } as unknown as ProjectSpaceDetailServices
    const api = createWeworkPlatformApi(
      {
        workspaces: {},
        projects: {},
        resources: {
          list: vi.fn().mockRejectedValue(new Error('Cloud unavailable')),
        },
      } as unknown as SharedWorkspaceApi,
      createLocalWorkspaceApi(createLocalDeliveryApi(), 1, 'admin', null, detailServices)
    )

    await expect(api?.resources?.list()).resolves.toMatchObject({
      agents: [
        { id: 'LA-local', location: 'local' },
        { id: 'LA-default', location: 'local', deletable: false },
      ],
    })
  })

  it('routes device resource actions to the matching settings destination', () => {
    expect(resolveDeviceResourceSettingsOptions('device:local', 'local')).toEqual({
      settingsPage: 'execution-environments',
    })
    expect(resolveDeviceResourceSettingsOptions('device:cloud', 'cloud')).toEqual({
      settingsPage: 'connections',
      autoOpenAddCloudDeviceDialog: false,
    })
    expect(resolveDeviceResourceSettingsOptions(undefined, 'local')).toEqual({
      settingsPage: 'execution-environments',
    })
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
      createLocalWorkspaceApi(
        createLocalDeliveryApi(),
        1,
        'admin',
        null,
        createLocalDetailServices()
      )
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
      createLocalWorkspaceApi(localDeliveryApi, 1, 'admin', null, createLocalDetailServices())
    )

    await expect(api?.issues.getBoardSnapshot('local-project')).resolves.toEqual(
      expect.objectContaining({ items: [] })
    )
    expect(localDeliveryApi.getBoardSnapshot).toHaveBeenCalledWith('local-project')
    expect(getCloudBoardSnapshot).not.toHaveBeenCalled()
  })

  it('routes local archived Issue reads and restores to the local project API', async () => {
    const localIssue = {
      id: 'local-issue',
      cloud_project_id: 'local-project',
    }
    const listArchivedLoopItems = vi.fn().mockResolvedValue({
      items: [localIssue],
      next_cursor: null,
    })
    const restoreLoopItem = vi.fn().mockResolvedValue({ items: [localIssue] })
    const localDeliveryApi = {
      ...createLocalDeliveryApi(),
      getLoopItem: vi.fn().mockResolvedValue(localIssue),
      listArchivedLoopItems,
      restoreLoopItem,
    } as unknown as LocalProjectSpaceApi
    const listCloudArchived = vi.fn()
    const restoreCloudIssue = vi.fn()
    const cloudApi = {
      workspaces: {},
      projects: {},
      issues: {
        listArchived: listCloudArchived,
        restore: restoreCloudIssue,
      },
    } as unknown as SharedWorkspaceApi
    const api = createWeworkPlatformApi(
      cloudApi,
      createLocalWorkspaceApi(localDeliveryApi, 1, 'admin', null, createLocalDetailServices())
    )

    await expect(api?.issues.listArchived('local-project')).resolves.toEqual({
      items: [expect.objectContaining({ id: 'local-issue' })],
      nextCursor: null,
    })
    await expect(api?.issues.restore('local-issue')).resolves.toEqual([
      expect.objectContaining({ id: 'local-issue' }),
    ])
    expect(listArchivedLoopItems).toHaveBeenCalledWith('local-project', undefined)
    expect(restoreLoopItem).toHaveBeenCalledWith('local-issue')
    expect(listCloudArchived).not.toHaveBeenCalled()
    expect(restoreCloudIssue).not.toHaveBeenCalled()
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
      createLocalWorkspaceApi(
        createLocalDeliveryApi(),
        1,
        'admin',
        null,
        createLocalDetailServices()
      )
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
      createLocalWorkspaceApi(localDeliveryApi, 1, 'admin', null, createLocalDetailServices())
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
