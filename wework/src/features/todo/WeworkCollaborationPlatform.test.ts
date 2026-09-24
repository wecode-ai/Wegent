import { createElement, useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { act, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { CollaborationPlatformLocation, SharedWorkspaceApi } from '@wegent/collaboration'
import { DEFAULT_WORK_ITEM_PROJECT_ID, type DeliveryApi } from '@/api/deliveries'
import { ApiError } from '@/api/http'
import { RuntimeTaskLifecycleStore } from '@/features/workbench/runtimeTaskLifecycle'
import type {
  LocalProjectSpaceApi,
  ProjectSpaceDetailServices,
} from '@/features/workbench/workbenchServices'
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
import { resolveDeviceResourceSettingsOptions } from './deviceResourceSettings'

const renderedProjectApis = vi.hoisted(() => new Map<string, SharedWorkspaceApi>())

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
      host: {
        location: { projectId: string | null }
        manageResource?(kind: 'agents' | 'environments', resourceId?: string): void
      }
      refreshProjectRequestKey?: number
    }) => {
      if (host.location.projectId) renderedProjectApis.set(host.location.projectId, api)
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
          'data-navigation-source-count': navigationApis?.length ?? 0,
          'data-refresh-key': refreshKey ?? '',
          'data-workspace-locations': host.capabilities.workspaceLocations?.join(',') ?? '',
          'data-issue-id': host.location.issueId ?? '',
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
  renderedProjectApis.clear()
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

  it('does not reload collaboration navigation when task projects change', () => {
    const props = {
      user: {
        id: 1,
        user_name: 'admin',
        email: 'admin@example.com',
      } as never,
      services: {
        projectSpaceApis: {
          local: createLocalDeliveryApi(),
        },
      } as never,
    }
    const { rerender } = render(
      createElement(WeworkCollaborationPlatform, {
        ...props,
        localProjects: [],
      })
    )
    const initialRefreshKey = screen
      .getByTestId('collaboration-platform-root')
      .getAttribute('data-refresh-key')

    rerender(
      createElement(WeworkCollaborationPlatform, {
        ...props,
        localProjects: [
          {
            id: 12,
            name: 'New task project',
            config: {
              mode: 'workspace',
              execution: { targetType: 'local', deviceId: 'local-device' },
              workspace: { source: 'local_path', localPath: '/workspace/new' },
            },
            tasks: [],
          },
        ],
      })
    )

    expect(screen.getByTestId('collaboration-platform-root')).toHaveAttribute(
      'data-refresh-key',
      initialRefreshKey
    )
  })

  it('resolves an imported runtime project to its local collaboration project', async () => {
    const localDeliveryApi = createLocalDeliveryApi()
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const ensureDefault = vi.fn().mockRejectedValue(new Error('agent unavailable'))
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
            local: localDeliveryApi,
          },
          projectSpaceDetailServices: {
            local: {
              ...createLocalDetailServices(),
              localProjectChatAgentApi: {
                list: vi.fn(async () => []),
                ensureDefault,
                create: vi.fn(),
              },
            },
          },
        } as never,
        renderLocalProjectImporter: ({ mode, projects, onCreated }) =>
          createElement(
            'button',
            {
              'data-testid': 'test-complete-local-project-import',
              'data-mode': mode,
              'data-project-count': projects.length,
              onClick: () =>
                void onCreated('runtime-project', 'Local project', ['/workspace/imported']),
              type: 'button',
            },
            'Complete import'
          ),
      })
    )

    await act(async () => {
      screen.getByTestId('collaboration-platform-import-local-project').click()
    })
    expect(screen.getByTestId('test-complete-local-project-import')).toHaveAttribute(
      'data-mode',
      'existing'
    )
    await act(async () => {
      screen.getByTestId('test-complete-local-project-import').click()
    })

    await waitFor(() =>
      expect(screen.getByTestId('collaboration-platform-location')).toHaveTextContent(
        'local-project'
      )
    )
    expect(screen.getByTestId('collaboration-platform-location')).toHaveAttribute(
      'data-workspace-id',
      'wework-local-workspace'
    )
    expect(localDeliveryApi.importLocalCodeProject).toHaveBeenCalledWith({
      runtimeProjectKey: 'runtime-project',
      name: 'Local project',
      roots: ['/workspace/imported'],
    })
    expect(ensureDefault).toHaveBeenCalledWith(
      'local-project',
      expect.objectContaining({
        name: 'current-device-agent',
        model: null,
      })
    )
    expect(warning).toHaveBeenCalledWith(
      expect.stringContaining('imported project local-project'),
      expect.any(Error)
    )
    warning.mockRestore()
  })

  it('resolves an imported project by workspace root when the runtime key is an alias', async () => {
    const localDeliveryApi = createLocalDeliveryApi()
    localDeliveryApi.importLocalCodeProject.mockResolvedValue({
      id: 'local-project',
      name: 'Local project',
      project_store: 'local',
      metadata: {
        code_project_key: 'runtime-project-uuid',
        workspace_roots: ['/workspace/imported'],
      },
    } as never)

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
            local: localDeliveryApi,
          },
        } as never,
        renderLocalProjectImporter: ({ onCreated }) =>
          createElement(
            'button',
            {
              'data-testid': 'test-complete-aliased-local-project-import',
              onClick: () =>
                void onCreated('runtime-project-uuid', 'Local project', ['/workspace/imported']),
              type: 'button',
            },
            'Complete aliased import'
          ),
      })
    )

    await act(async () => {
      screen.getByTestId('collaboration-platform-import-local-project').click()
    })
    await act(async () => {
      screen.getByTestId('test-complete-aliased-local-project-import').click()
    })

    await waitFor(() =>
      expect(screen.getByTestId('collaboration-platform-location')).toHaveTextContent(
        'local-project'
      )
    )
  })

  it('offers only task projects that are not already in local collaboration', async () => {
    render(
      createElement(WeworkCollaborationPlatform, {
        user: {
          id: 1,
          user_name: 'admin',
          email: 'admin@example.com',
        } as never,
        localProjects: [
          {
            id: 11,
            name: 'Already imported',
            config: {
              mode: 'workspace',
              execution: { targetType: 'local', deviceId: 'local-device' },
              workspace: { source: 'local_path', localPath: '/workspace/imported' },
            },
            tasks: [],
          },
          {
            id: 12,
            name: 'Available task project',
            config: {
              mode: 'workspace',
              execution: { targetType: 'local', deviceId: 'local-device' },
              workspace: { source: 'local_path', localPath: '/workspace/available' },
            },
            tasks: [],
          },
        ],
        runtimeWork: {
          projects: [
            {
              project: { id: 11, key: 'runtime-project', name: 'Already imported' },
              deviceWorkspaces: [],
            },
            {
              project: { id: 12, key: 'available-project', name: 'Available task project' },
              deviceWorkspaces: [],
            },
          ],
          chats: [],
          totalTasks: 0,
        },
        services: {
          projectSpaceApis: {
            local: createLocalDeliveryApi(),
          },
        } as never,
        renderLocalProjectImporter: ({ projects }) =>
          createElement(
            'div',
            { 'data-testid': 'test-local-project-candidates' },
            projects.map(project => project.name).join(',')
          ),
      })
    )

    await act(async () => {
      screen.getByTestId('collaboration-platform-import-local-project').click()
    })

    expect(screen.getByTestId('test-local-project-candidates')).toHaveTextContent(
      'Available task project'
    )
    expect(screen.getByTestId('test-local-project-candidates')).not.toHaveTextContent(
      'Already imported'
    )
  })

  it('matches imported Windows roots across separator and casing differences', async () => {
    const localDeliveryApi = createLocalDeliveryApi()
    vi.mocked(localDeliveryApi.listCloudProjects).mockResolvedValue({
      items: [
        {
          id: 'local-project',
          name: 'Imported Windows project',
          project_store: 'local',
          metadata: {
            code_project_key: 'different-runtime-key',
            workspace_roots: ['c:/work/repo'],
          },
        },
      ],
    } as never)

    render(
      createElement(WeworkCollaborationPlatform, {
        user: {
          id: 1,
          user_name: 'admin',
          email: 'admin@example.com',
        } as never,
        localProjects: [
          {
            id: 13,
            name: 'Same Windows project',
            config: {
              mode: 'workspace',
              execution: { targetType: 'local', deviceId: 'local-device' },
              workspace: { source: 'local_path', localPath: 'C:\\Work\\Repo\\' },
            },
            tasks: [],
          },
        ],
        runtimeWork: {
          projects: [
            {
              project: {
                id: 13,
                key: 'windows-runtime-project',
                name: 'Same Windows project',
              },
              deviceWorkspaces: [],
            },
          ],
          chats: [],
          totalTasks: 0,
        },
        services: {
          projectSpaceApis: {
            local: localDeliveryApi,
          },
        } as never,
        renderLocalProjectImporter: ({ projects }) =>
          createElement(
            'div',
            { 'data-testid': 'test-windows-project-candidates' },
            projects.map(project => project.name).join(',')
          ),
      })
    )

    await act(async () => {
      screen.getByTestId('collaboration-platform-import-local-project').click()
    })

    expect(screen.getByTestId('test-windows-project-candidates')).toBeEmptyDOMElement()
  })

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

  it.each(['agents', 'teams', 'devices'] as const)(
    'opens the internal %s destination from collaboration navigation',
    destination => {
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

      act(() => {
        screen.getByTestId(`collaboration-platform-open-${destination}`).click()
      })

      expect(screen.getByTestId('collaboration-platform-location')).toHaveTextContent(destination)
    }
  )

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

  it('opens a focused Issue when the controlled project is already active', async () => {
    const getProject = vi.fn().mockResolvedValue({
      id: 'active-project',
      name: 'Active project',
      workspace_id: 'cloud-workspace',
      project_store: 'backend',
    })
    const props = {
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
        projectStore: 'backend' as const,
        projectId: 'active-project',
      },
      onActiveProjectChange: vi.fn(),
    }
    const view = render(createElement(WeworkCollaborationPlatform, props))

    await screen.findByText('active-project')
    view.rerender(
      createElement(WeworkCollaborationPlatform, {
        ...props,
        focusedItemId: 'issue-1',
      })
    )

    await waitFor(() =>
      expect(screen.getByTestId('collaboration-platform-root')).toHaveAttribute(
        'data-issue-id',
        'issue-1'
      )
    )
    expect(getProject).toHaveBeenCalledTimes(1)
  })

  it('keeps an Issue the reader opened while the route only names the project', async () => {
    const getProject = vi.fn().mockResolvedValue({
      id: 'active-project',
      name: 'Active project',
      workspace_id: 'cloud-workspace',
      project_store: 'backend',
    })
    const props = {
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
        projectStore: 'backend' as const,
        projectId: 'active-project',
      },
      onActiveProjectChange: vi.fn(),
    }
    render(createElement(WeworkCollaborationPlatform, props))

    const platform = () => screen.getByTestId('collaboration-platform-root')
    await waitFor(() => expect(platform()).toHaveAttribute('data-issue-id', ''))

    await act(async () => {
      screen.getByTestId('collaboration-platform-open-issue').click()
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(platform()).toHaveAttribute('data-issue-id', 'issue-1')
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

  it('automatically adds the default local Agent to a newly created local project', async () => {
    const ensureDefault = vi.fn(async (projectId: string, input: Record<string, unknown>) => ({
      id: `LA-${projectId}`,
      projectId,
      status: 'active',
      version: 1,
      ...input,
    }))
    const delivery = {
      ...createLocalDeliveryApi(),
      createCloudProject: vi.fn().mockResolvedValue({ id: 'new-local', name: 'New local' }),
      updateCloudProject: vi.fn(async (_projectId: string, input: Record<string, unknown>) => ({
        id: 'new-local',
        name: 'New local',
        version: 2,
        project_manager: input.project_manager,
      })),
    }
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
    const api = createLocalWorkspaceApi(delivery, 1, 'admin', null, details)!

    await expect(api.projects.create({ name: 'New local' })).resolves.toMatchObject({
      id: 'new-local',
      workspace_id: 'wework-local-workspace',
    })
    expect(ensureDefault).toHaveBeenCalledWith(
      'new-local',
      expect.objectContaining({
        name: 'current-device-agent',
        model: null,
        capabilityMode: 'follow_device',
      })
    )
    expect(delivery.updateCloudProject).toHaveBeenCalledWith(
      'new-local',
      expect.objectContaining({
        project_manager: expect.objectContaining({
          enabled: true,
          agentId: 'LA-new-local',
        }),
      })
    )
  })

  it('does not add the default local Agent when local project creation opts out', async () => {
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
      includeDefaultAgent: false,
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

    await expect(api.projects.create({ name: 'New local' })).resolves.toMatchObject({
      id: 'new-local',
      name: 'New local',
    })
    expect(warning).toHaveBeenCalledWith(
      expect.stringContaining('project new-local'),
      expect.any(Error)
    )
    warning.mockRestore()
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
      localDeliveryApi,
      1,
      'admin',
      null,
      createLocalDetailServices()
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
      localDeliveryApi,
      1,
      'admin',
      null,
      createLocalDetailServices()
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
      localDeliveryApi,
      1,
      'admin',
      null,
      createLocalDetailServices()
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
      {
        listCloudProjects: vi.fn(async () => ({ items: records })),
        updateCloudProject: update,
      } as unknown as DeliveryApi,
      1,
      'admin',
      null
    )!
    const group = await api.workspaces!.createCollaborationGroup('wework-local-workspace', {
      name: '111',
      coordinationMode: 'manager',
      leader: { kind: 'human', id: '1' },
      members: [{ kind: 'human', id: '1' }],
    })
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

  it('exposes locally persisted Agents through the collaboration resource catalog', async () => {
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
    const agents = [localAgent]
    const detailServices = {
      ...createLocalDetailServices(),
      localProjectChatAgentApi: {
        list: vi.fn(async () => agents),
        ensureDefault: vi.fn(async () => {
          agents.push(defaultAgent)
          return defaultAgent
        }),
        create: vi.fn(),
      },
    } as unknown as ProjectSpaceDetailServices
    const api = createLocalWorkspaceApi(createLocalDeliveryApi(), 1, 'admin', null, detailServices)

    await expect(api?.resources?.list()).resolves.toMatchObject({
      agents: [
        {
          id: 'LA-local',
          name: '本地代码助手',
          owner_type: 'workspace',
          owner_id: 'wework-local-workspace',
          owner_name: '本地空间',
          location: 'local',
          status: 'available',
          execution_environment_ids: ['device:local-device'],
        },
        {
          id: 'LA-default',
          agent_id: 'current-device-agent',
          name: '当前设备智能体',
          deletable: false,
        },
      ],
    })
    await expect(api?.workspaces?.listAgents('wework-local-workspace')).resolves.toMatchObject([
      {
        id: 'LA-local',
        name: '本地代码助手',
        owner_type: 'workspace',
        owner_id: 'wework-local-workspace',
        owner_name: '本地空间',
      },
      {
        id: 'LA-default',
        agent_id: 'current-device-agent',
        name: '当前设备智能体',
        deletable: false,
      },
    ])
    expect(detailServices.localProjectChatAgentApi?.list).toHaveBeenCalledWith(
      DEFAULT_WORK_ITEM_PROJECT_ID
    )
  })

  it('ensures a default Agent while reading the local resource catalog', async () => {
    const defaultAgent = {
      id: 'LA-default',
      name: 'current-device-agent',
      displayName: '当前设备智能体',
      runtime: 'codex',
      status: 'active',
      version: 1,
    }
    const ensureDefault = vi.fn(async () => defaultAgent)
    const listModels = vi.fn()
    const detailServices = {
      ...createLocalDetailServices(),
      modelApi: {
        listModels,
      },
      localProjectChatAgentApi: {
        list: vi.fn().mockResolvedValue([]),
        ensureDefault,
        create: vi.fn(),
      },
    } as unknown as ProjectSpaceDetailServices
    const api = createLocalWorkspaceApi(createLocalDeliveryApi(), 1, 'admin', null, detailServices)

    await expect(api?.resources?.list()).resolves.toMatchObject({
      agents: [
        {
          id: 'LA-default',
          agent_id: 'current-device-agent',
          deletable: false,
        },
      ],
    })
    expect(ensureDefault).toHaveBeenCalledWith(
      DEFAULT_WORK_ITEM_PROJECT_ID,
      expect.objectContaining({
        name: 'current-device-agent',
        model: null,
        capabilityMode: 'follow_device',
      })
    )
    expect(listModels).not.toHaveBeenCalled()
  })

  it('keeps the local resource catalog available when default-Agent provisioning fails', async () => {
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
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
    expect(warning).toHaveBeenCalledWith('[Wework] Failed to list local Agents', expect.any(Error))
    expect(warning).toHaveBeenCalledWith(
      '[Wework] Failed to ensure the default local Agent',
      expect.any(Error)
    )
    warning.mockRestore()
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
      createLocalDeliveryApi(),
      1,
      'admin',
      null,
      detailServices
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

  it('opens cloud device setup from project environment management', async () => {
    const onOpenSettings = vi.fn()
    render(
      createElement(WeworkSharedProject, {
        api: {
          projects: {},
          issues: {},
        } as unknown as SharedWorkspaceApi,
        localProjects: [],
        locale: 'zh-CN',
        location: {
          platformView: 'spaces',
          workspaceId: 'cloud-workspace',
          workspaceView: 'projects',
          projectId: 'cloud-project',
          projectView: 'manage',
          projectSettingsSection: 'environments',
          issueId: null,
        },
        onOpenSettings,
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
      })
    )

    await act(async () =>
      screen.getByTestId('collaboration-app-manage-environments-cloud-project').click()
    )

    expect(onOpenSettings).toHaveBeenCalledWith({
      settingsPage: 'connections',
      autoOpenAddCloudDeviceDialog: true,
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

  it('uses display names from the local Agent catalog for every board refresh', async () => {
    const agents = [
      {
        id: 'agent-1',
        name: 'current-device-agent',
        displayName: '当前设备智能体',
        runtime: 'codex',
        wegentTeamId: 91,
      },
    ]
    const listAgents = vi.fn().mockResolvedValue(agents)
    const details = {
      ...createLocalDetailServices(),
      localProjectChatAgentApi: { list: listAgents },
    } as unknown as ProjectSpaceDetailServices
    const api = createLocalWorkspaceApi(createLocalDeliveryApi(), 1, 'admin', null, details)!

    const expectedAgents = [
      expect.objectContaining({
        id: 'agent-1',
        name: '当前设备智能体',
        displayName: '当前设备智能体',
      }),
    ]
    expect(await api.agents.list('local-project')).toEqual(expectedAgents)
    expect((await api.issues.getBoardSnapshot('local-project')).agents).toEqual(expectedAgents)
    expect(listAgents).toHaveBeenCalledWith('local-project')
    listAgents.mockRejectedValueOnce(new Error('Agent storage unavailable'))
    await expect(api.issues.getBoardSnapshot('local-project')).rejects.toThrow(
      'Agent storage unavailable'
    )
    listAgents.mockResolvedValue([])
    expect((await api.issues.getBoardSnapshot('local-project')).agents).toEqual([])
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
