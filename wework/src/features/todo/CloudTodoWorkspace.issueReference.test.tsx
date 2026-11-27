import {
  createWeworkSharedWorkspaceApi,
  createWeworkWorkspaceRuntimePort,
} from '@/features/collaboration/weworkSharedWorkspaceApi'

import { clearRuntimeConversationCacheForTests } from '@/features/workbench/runtimeConversationCache'

import type { WorkbenchServices } from '@/features/workbench/workbenchServices'

import '@/i18n'

import type { User } from '@/types/api'

import { cleanup, render, screen } from '@testing-library/react'

import userEvent from '@testing-library/user-event'

import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import { CloudTodoWorkspace } from './CloudTodoWorkspace'

vi.mock('@/api/dsh/desktopHost', () => ({
  invokeDesktopHost: vi.fn(async (capability: string, params: Record<string, unknown> = {}) => {
    if (capability === 'preferences.get') return {}
    if (capability === 'preferences.update') return params.patch ?? {}
    return {}
  }),
}))

const telemetryMocks = vi.hoisted(() => ({
  track: vi.fn(),
}))

vi.mock('@/telemetry/client', () => telemetryMocks)

vi.mock('./ProjectSpaceChatSidebar', () => ({ ProjectSpaceChatSidebar: () => null }))
vi.mock('@/components/layout/workspace-panels/TemporaryChatPanel', () => ({
  TemporaryChatPanel: () => null,
}))
vi.mock('./AiChatModal', () => ({ AiChatModal: () => null }))
vi.mock('./BackgroundTaskStarter', () => ({ BackgroundTaskStarter: () => null }))

const project = {
  id: '11',
  workspace_id: '101',
  public_id: 'cloud-public-id',
  project_key: 'WEG',
  name: 'Wegent V4',
  description: 'Shared project',
  project_store: 'backend' as const,
  task_provider: 'local' as const,
  provider_config: {},
  access_role: 'Owner' as const,
  created_by_user_id: 1,
  status: 'active',
  version: 1,
  created_at: '2026-07-22T00:00:00Z',
  updated_at: '2026-07-22T00:00:00Z',
}

const item = {
  id: 'WEG-1',
  cloud_project_id: '11',
  sequence_number: 1,
  parent_id: null,
  created_by_user_id: 1,
  assignee_user_id: null,
  title: 'Implement cloud MCP',
  description: 'Use the shared workspace',
  status: 'in_progress' as const,
  priority: 'high' as const,
  due_at: null,
  sort_order: 0,
  current_delivery_id: null,
  version: 1,
  created_at: '2026-07-22T00:00:00Z',
  updated_at: '2026-07-22T00:00:00Z',
  completed_at: null,
  can_edit: true,
}

function services(overrides: Partial<WorkbenchServices> = {}): WorkbenchServices {
  const baseServices = {
    deliveryApi: {
      listCloudProjects: vi.fn(async () => ({ items: [project] })),
      createCloudProject: vi.fn(async values => ({
        ...project,
        id: 12,
        project_key: values.project_key ?? 'AUTO123',
        name: values.name,
        description: values.description ?? '',
        task_provider: values.task_provider ?? 'local',
        provider_config: values.provider_config ?? {},
      })),
      updateCloudProject: vi.fn(async (_projectId, values) => ({
        ...project,
        ...values,
        version: project.version + 1,
      })),
      archiveCloudProject: vi.fn(async () => undefined),
      archiveLoopItem: vi.fn(async () => undefined),
      getLoopItem: vi.fn(async () => item),
      approveLoopItemRun: vi.fn(async () => ({
        ...item,
        execution_state: 'queued',
        can_approve: false,
        version: item.version + 1,
      })),
      markLoopItemRead: vi.fn(async () => ({ ...item, is_unread: false })),
      updateLoopItem: vi.fn(async (_itemId, values) => ({
        ...item,
        ...values,
        version: item.version + 1,
      })),
      reorderLoopItems: vi.fn(async () => ({ items: [item] })),
      listLoopItems: vi.fn(async () => ({ items: [item] })),
      listLoopItemsPage: vi.fn(async () => ({
        items: [],
        task_bindings: [],
        next_cursor: null,
      })),
      listDeliveries: vi.fn(async () => ({ items: [] })),
      listLoopItemAttachments: vi.fn(async () => []),
      addLoopItemAttachment: vi.fn(async (_itemId, file) => ({
        id: 'attachment-1',
        loop_item_id: item.id,
        display_name: file.name,
        content_type: file.type,
        size_bytes: file.size,
        sha256: 'hash',
        created_by_user_id: 1,
        created_at: '2026-07-22T00:00:00Z',
        markdown_url: 'wegent://attachments/attachment-1',
        markdown:
          '[brief.txt](wegent://attachments/attachment-1)\n<!-- wegent-attachment:attachment-1 -->',
      })),
      accessLoopItemAttachment: vi.fn(async () => ({
        url: 'https://storage.test/attachment-1',
        expires_in_seconds: 900,
      })),
      readLoopItemAttachment: vi.fn(async () => new Blob(['context'])),
      downloadLoopItemAttachment: vi.fn(async () => undefined),
      deleteLoopItemAttachment: vi.fn(async () => undefined),
      listTaskBindings: vi.fn(async () => [
        {
          id: 1,
          cloud_project_id: project.id,
          loop_item_id: item.id,
          task_user_id: 1,
          device_id: 'local-device',
          task_id: 'runtime-248868498',
          task_title: 'Implement cloud delivery',
          backend_task_id: null,
          human_assignment_id: 'human-assignment-1',
          dispatch_id: 'dispatch-1',
          dispatch_round_id: 'round-1',
          assignment_id: 'collect-cpu',
          linked_at: '2026-07-22T00:00:00Z',
        },
      ]),
      listLoopItemCollaborators: vi.fn(async () => [
        {
          id: 1,
          loop_item_id: item.id,
          user_id: 1,
          user_name: 'local',
          email: 'local@example.com',
          source: 'task',
          added_by_user_id: 1,
          created_at: '2026-07-22T00:00:00Z',
        },
      ]),
      addLoopItemCollaborator: vi.fn(async (_itemId, userId) => ({
        id: 2,
        loop_item_id: item.id,
        user_id: userId,
        user_name: 'alice',
        email: 'alice@example.com',
        source: 'manual',
        added_by_user_id: 1,
        created_at: '2026-07-23T00:00:00Z',
      })),
      removeLoopItemCollaborator: vi.fn(async () => undefined),
      bindTask: vi.fn(async () => undefined),
      unbindTask: vi.fn(async () => undefined),
      getWorkflowStageContext: vi.fn(async () => ({
        compiled_task_instruction: '## 当前节点任务\n\n执行后端任务',
      })),
      listMyWork: vi.fn(async () => ({ items: [] })),
      listCloudProjectMembers: vi.fn(async () => [
        {
          id: 1,
          user_id: 1,
          user_name: 'local',
          email: 'local@example.com',
          role: 'Owner',
          capability_description: '',
        },
        {
          id: 2,
          user_id: 2,
          user_name: 'alice',
          email: 'alice@example.com',
          role: 'Developer',
          capability_description: '',
        },
      ]),
      updateCloudProjectMember: vi.fn(async (_projectId, userId, values) => ({
        id: userId === 1 ? 1 : 2,
        user_id: userId,
        user_name: userId === 1 ? 'local' : 'alice',
        email: userId === 1 ? 'local@example.com' : 'alice@example.com',
        role: userId === 1 ? 'Owner' : (values.role ?? 'Developer'),
        capability_description: values.capability_description ?? '',
      })),
      listLoopItemExecutions: vi.fn(async () => ({ items: [] })),
      searchCloudProjectUsers: vi.fn(async () => ({ users: [], total: 0 })),
      listCloudFiles: vi.fn(async () => ({ items: [] })),
      listProjectDeliveryFiles: vi.fn(async () => ({ items: [] })),
      listProjectTaskAttachments: vi.fn(async () => ({ items: [] })),
      createCloudFolder: vi.fn(async (_projectId: string, path: string) => ({
        id: 51,
        cloud_project_id: '11',
        path,
        name: path,
        kind: 'folder',
        content_type: null,
        size_bytes: 0,
        sha256: null,
        description: '',
        created_by_user_id: 1,
        updated_by_user_id: 1,
        version: 1,
        created_at: '2026-07-22T00:00:00Z',
        updated_at: '2026-07-22T00:00:00Z',
      })),
    },
    deviceApi: {
      listDevices: vi.fn(async () => [
        { device_id: 'local-device', device_type: 'local', status: 'online' },
      ]),
      listSkills: vi.fn(async () => []),
    },
    modelApi: {
      listModels: vi.fn(async () => ({
        data: [{ name: 'gpt-5-codex', type: 'runtime', displayName: 'GPT-5 Codex' }],
      })),
    },
  } as unknown as WorkbenchServices
  const workbenchServices = {
    ...baseServices,
    standInApi: { readTask: vi.fn(async () => ({ success: true })) },
    ...overrides,
  } as WorkbenchServices
  const deliveryApi = workbenchServices.deliveryApi!
  deliveryApi.getBoardSnapshot = vi.fn(async projectId => {
    const [{ items }, members, agents] = await Promise.all([
      deliveryApi.listLoopItems(projectId),
      deliveryApi.listCloudProjectMembers(projectId),
      workbenchServices.projectChatAgentApi?.list(String(projectId)) ?? Promise.resolve([]),
    ])
    const bindingResults = await Promise.all(
      items.map(item => deliveryApi.listTaskBindings(item.id))
    )
    return {
      items,
      task_bindings: bindingResults
        .flat()
        .map(binding => ({ ...binding, cloud_project_id: binding.cloud_project_id ?? projectId })),
      members,
      agents,
    }
  })
  const projectAutomationApi = {
    heartbeat: vi.fn(),
    startRequested: vi.fn(),
    dispatchUnknown: vi.fn(),
    runtimeStart: vi.fn(),
    dispatchFailed: vi.fn(),
    list: vi.fn(async () => []),
    create: vi.fn(),
    migrateWorkflow: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(async () => undefined),
    runNow: vi.fn(),
    listRuns: vi.fn(async () => []),
    cancelRun: vi.fn(),
    retryRun: vi.fn(),
  }
  const projectIncomingHookApi = {
    catalog: vi.fn(async () => []),
    list: vi.fn(async () => []),
    create: vi.fn(),
    update: vi.fn(),
    rotate: vi.fn(),
    remove: vi.fn(async () => undefined),
    listEvents: vi.fn(async () => []),
  }
  const runtimeProfileApi = {
    list: vi.fn(async () => []),
    create: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(async () => undefined),
    getProjectDefault: vi.fn(async () => null),
    setProjectDefault: vi.fn(async () => null),
    selectExecution: vi.fn(),
  }
  const projectChatAgentApi = workbenchServices.projectChatAgentApi ?? {
    list: vi.fn(async () => []),
    listRunnerEnvironments: vi.fn(async () => []),
    listModels: vi.fn(async () => []),
    create: vi.fn(),
    update: vi.fn(),
  }
  workbenchServices.projectChatAgentApi = projectChatAgentApi
  workbenchServices.sharedWorkspaceApi = createWeworkSharedWorkspaceApi({
    client: {
      get: vi.fn(async (url: string) => {
        if (url.endsWith('/v1/workspaces')) {
          return { items: [{ id: project.workspace_id, name: 'Shared workspace' }] }
        }
        if (url.endsWith('/v1/resources?include_readiness=false'))
          return { agents: [], execution_environments: [] }
        if (url.endsWith(`/v1/workspaces/${project.workspace_id}/agents?include_readiness=false`))
          return { items: [] }
        if (url.endsWith('/chat-agents') || url.endsWith('/chat-agents?include_archived=true'))
          return []
        if (url.endsWith('/comments')) return []
        if (url.endsWith('/assignments')) return { items: [] }
        if (url.endsWith('/collaboration-groups')) return { items: [] }
        throw new Error(`Unhandled collaboration test request: GET ${url}`)
      }),
      getBlob: vi.fn(),
      post: vi.fn(),
      put: vi.fn(),
      patch: vi.fn(),
      delete: vi.fn(),
    },
    deliveryApi,
    projectAutomationApi: projectAutomationApi as never,
    projectIncomingHookApi: projectIncomingHookApi as never,
    runtimeProfileApi: runtimeProfileApi as never,
    projectChatAgentApi: projectChatAgentApi as never,
  })
  workbenchServices.workspaceRuntimePort = createWeworkWorkspaceRuntimePort(
    deliveryApi,
    projectAutomationApi as never
  )
  workbenchServices.projectSpaceDetailServices = {
    local: {
      get deliveryApi() {
        return workbenchServices.projectSpaceApis?.local ?? workbenchServices.deliveryApi!
      },
      get projectChatClient() {
        return workbenchServices.localProjectChatClient
      },
      get projectChatAgentApi() {
        return workbenchServices.localProjectChatAgentApi
      },
      get loopItemExecutionApi() {
        return workbenchServices.localLoopItemExecutionApi
      },
      get deviceApi() {
        return workbenchServices.deviceApi
      },
      get modelApi() {
        return workbenchServices.modelApi
      },
      get teamApi() {
        return workbenchServices.teamApi
      },
    },
    cloud: {
      get deliveryApi() {
        return workbenchServices.projectSpaceApis?.cloud ?? workbenchServices.deliveryApi!
      },
      get projectChatClient() {
        return workbenchServices.projectChatClient
      },
      get projectChatAgentApi() {
        return workbenchServices.projectChatAgentApi
      },
      get projectAutomationApi() {
        return workbenchServices.projectAutomationApi
      },
      get deviceApi() {
        return workbenchServices.deviceApi
      },
      get modelApi() {
        return workbenchServices.modelApi
      },
      get teamApi() {
        return workbenchServices.teamApi
      },
    },
  }
  return workbenchServices
}

beforeEach(() => {
  Object.defineProperties(HTMLDialogElement.prototype, {
    showModal: {
      configurable: true,
      value() {
        this.open = true
      },
    },
    close: {
      configurable: true,
      value() {
        this.open = false
      },
    },
  })
  HTMLElement.prototype.scrollTo = vi.fn()
  clearRuntimeConversationCacheForTests()
  telemetryMocks.track.mockClear()
  vi.stubGlobal(
    'IntersectionObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
  )
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
  )
})

afterEach(() => {
  cleanup()
  Reflect.deleteProperty(HTMLDialogElement.prototype, 'showModal')
  Reflect.deleteProperty(HTMLDialogElement.prototype, 'close')
  clearRuntimeConversationCacheForTests()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  localStorage.clear()
})

it.each(['local', 'cloud'] as const)(
  'opens an Issue from a newly resolved %s project absent from the catalog',
  async location => {
    const workbenchServices = services()
    const projectStore = location === 'local' ? ('local' as const) : ('backend' as const)
    const initialProject = { ...project, project_store: projectStore }
    const resolvedProject = {
      ...initialProject,
      id: '22',
      project_key: 'NEW',
      name: 'New unseen project',
    }
    const resolvedItem = {
      ...item,
      id: 'NEW-1',
      cloud_project_id: resolvedProject.id,
      title: 'Unloaded catalog Issue',
    }
    const sourceApi =
      location === 'local' ? services().deliveryApi! : workbenchServices.deliveryApi!
    const listProjects = vi.fn(async () => ({ items: [initialProject] }))
    sourceApi.listCloudProjects = listProjects
    sourceApi.getLoopItem = vi.fn(async () => resolvedItem)
    sourceApi.listLoopItems = vi.fn(async projectId => ({
      items: String(projectId) === resolvedProject.id ? [resolvedItem] : [item],
    }))
    if (location === 'local') {
      workbenchServices.sharedWorkspaceApi = undefined
      workbenchServices.projectSpaceApis = { local: sourceApi, defaultLocation: 'local' }
    } else {
      workbenchServices.projectSpaceDetailServices = undefined
      vi.spyOn(workbenchServices.sharedWorkspaceApi!.projects, 'get').mockResolvedValue(
        resolvedProject as never
      )
    }
    render(
      <CloudTodoWorkspace
        user={{ id: 1, user_name: 'local', email: 'local@example.com' } as User}
        localProjects={[]}
        services={workbenchServices}
      />
    )
    await screen.findAllByText(initialProject.name)
    expect(screen.queryByText(resolvedProject.name)).not.toBeInTheDocument()
    listProjects.mockResolvedValue({ items: [initialProject, resolvedProject] })
    await userEvent.keyboard('{Meta>}k{/Meta}')
    await userEvent.type(screen.getByTestId('cloud-global-search-input'), resolvedItem.id)
    await userEvent.click(screen.getByTestId('cloud-global-search-open-issue'))
    expect(await screen.findByTestId('cloud-todo-detail')).toHaveTextContent(resolvedItem.title)
    expect(sourceApi.getLoopItem).toHaveBeenCalledWith(resolvedItem.id)
  }
)
