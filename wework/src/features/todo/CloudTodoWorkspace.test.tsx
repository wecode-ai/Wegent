import type { DndContextProps, DragCancelEvent, DragEndEvent, DragStartEvent } from '@dnd-kit/core'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import '@/i18n'
import { ApiError } from '@/api/http'

vi.mock('@/api/dsh/desktopHost', () => ({
  invokeDesktopHost: vi.fn(async (capability: string, params: Record<string, unknown> = {}) => {
    if (capability === 'preferences.get') return {}
    if (capability === 'preferences.update') return params.patch ?? {}
    return {}
  }),
}))
import { WorkbenchContext } from '@/features/workbench/workbenchContexts'
import type { WorkbenchContextValue } from '@/features/workbench/workbenchContextTypes'
import type { WorkbenchServices } from '@/features/workbench/workbenchServices'
import { RuntimeTaskLifecycleStore } from '@/features/workbench/runtimeTaskLifecycle'
import {
  applyRuntimeConversationAction,
  clearRuntimeConversationCacheForTests,
} from '@/features/workbench/runtimeConversationCache'
import type { User } from '@/types/api'
import { CloudTodoWorkspace } from './CloudTodoWorkspace'
import {
  isSelfManagedWorkItem,
  shouldPrepareWorkItemTask,
  workItemTaskInput,
} from './workItemTaskInput'
import { publishProjectSpaceTaskBindingChanged } from './projectSpaceSelection'

const telemetryMocks = vi.hoisted(() => ({
  track: vi.fn(),
}))

vi.mock('@/telemetry/client', () => telemetryMocks)

vi.mock('@dnd-kit/core', async importOriginal => {
  const actual = await importOriginal<typeof import('@dnd-kit/core')>()
  const ActualDndContext = actual.DndContext
  return {
    ...actual,
    DndContext: ({ children, ...props }: DndContextProps) => (
      <ActualDndContext {...props}>
        {children}
        <button
          type="button"
          hidden
          data-testid="mock-dnd-drag-start"
          onClick={() =>
            props.onDragStart?.({
              active: { id: item.id },
            } as DragStartEvent)
          }
        />
        <button
          type="button"
          hidden
          data-testid="mock-dnd-drag-cancel"
          onClick={() =>
            props.onDragCancel?.({
              active: { id: item.id },
            } as DragCancelEvent)
          }
        />
        <button
          type="button"
          hidden
          data-testid="mock-dnd-drag-to-pending"
          onClick={() =>
            props.onDragEnd?.({
              active: { id: item.id },
              over: { id: 'todo-column:pending' },
            } as DragEndEvent)
          }
        />
        <button
          type="button"
          hidden
          data-testid="mock-dnd-drag-to-in-progress"
          onClick={() =>
            props.onDragEnd?.({
              active: { id: item.id },
              over: { id: 'todo-column:in_progress' },
            } as DragEndEvent)
          }
        />
      </ActualDndContext>
    ),
  }
})

vi.mock('./ProjectSpaceChatSidebar', () => ({
  ProjectSpaceChatSidebar: ({
    project,
    onClose,
  }: {
    project: { id: number; name: string }
    onClose: () => void
  }) => (
    <div data-testid="project-space-chat-sidebar" data-project-id={project.id}>
      {project.name}
      <button type="button" data-testid="mock-project-space-chat-close" onClick={onClose}>
        关闭
      </button>
    </div>
  ),
}))

vi.mock('@/components/layout/workspace-panels/TemporaryChatPanel', () => ({
  TemporaryChatPanel: ({
    testId,
    initialAddress,
    collapseComposerWhenIdle,
  }: {
    testId: string
    initialAddress?: { deviceId: string; taskId: string } | null
    collapseComposerWhenIdle?: boolean
  }) => (
    <div
      data-testid={testId}
      data-device-id={initialAddress?.deviceId}
      data-task-id={initialAddress?.taskId}
      data-collapse-composer={String(collapseComposerWhenIdle)}
    >
      <div
        data-testid={testId.replace('popup-conversation', 'popup-scroll')}
        className="max-h-[min(68vh,42rem)] overflow-y-auto"
      />
    </div>
  ),
}))

vi.mock('./AiChatModal', () => ({
  AiChatModal: ({
    task,
    open,
    onClose,
    onBack,
    initialAddress,
    onOpenRuntimeTask,
    onAddressChange,
    onTaskCreated,
    prepareTask,
    workflowNodeId,
    initialTaskRequest,
    initialTaskInput,
  }: {
    task?: { id: string }
    open: boolean
    onClose: () => void
    onBack?: () => void
    initialAddress?: { deviceId: string; taskId: string } | null
    onOpenRuntimeTask?: (address: { deviceId: string; taskId: string }) => void
    onAddressChange?: (address: { deviceId: string; taskId: string }) => void
    onTaskCreated?: (address: { deviceId: string; taskId: string }) => void | Promise<void>
    prepareTask?: (address: {
      deviceId: string
      taskId: string
    }) => void | Promise<void | (() => void | Promise<void>)>
    workflowNodeId?: string
    initialTaskRequest?: { projectId?: number; modelId?: string }
    initialTaskInput?: string
  }) => (
    <div
      data-testid="ai-chat-modal"
      data-task-id={task?.id}
      data-open={open ? 'yes' : 'no'}
      data-runtime-task-id={initialAddress?.taskId}
      data-workflow-node-id={workflowNodeId}
      data-task-project-id={initialTaskRequest?.projectId}
      data-task-model-id={initialTaskRequest?.modelId}
      data-initial-task-input={initialTaskInput}
    >
      <button
        type="button"
        data-testid="mock-create-runtime-task"
        onClick={() => {
          const address = { deviceId: 'local-device', taskId: 'runtime-created' }
          void Promise.resolve(prepareTask?.(address)).then(() => {
            onAddressChange?.(address)
            return onTaskCreated?.(address)
          })
        }}
      >
        创建 Runtime 任务
      </button>
      <button
        type="button"
        data-testid="mock-open-runtime-task"
        onClick={() => initialAddress && onOpenRuntimeTask?.(initialAddress)}
      >
        打开完整任务
      </button>
      <button
        type="button"
        data-testid="mock-update-runtime-address"
        onClick={() =>
          onAddressChange?.({
            deviceId: initialAddress?.deviceId ?? 'local-device',
            taskId: initialAddress?.taskId ?? 'runtime-created',
          })
        }
      >
        更新 Runtime 地址
      </button>
      {onBack ? (
        <button type="button" data-testid="ai-chat-modal-back" onClick={onBack}>
          返回 Issue
        </button>
      ) : null}
      <button type="button" data-testid="ai-chat-modal-close" onClick={onClose}>
        关闭
      </button>
    </div>
  ),
}))

vi.mock('./BackgroundTaskStarter', () => ({
  BackgroundTaskStarter: ({
    onAddressChange,
    onTaskCreated,
    prepareTask,
  }: {
    onAddressChange: (address: { deviceId: string; taskId: string }) => void
    onTaskCreated?: (
      address: { deviceId: string; taskId: string },
      localProject: { id: number; name: string; tasks: [] } | null
    ) => void | Promise<void>
    prepareTask?: (
      address: { deviceId: string; taskId: string },
      localProject: { id: number; name: string; tasks: [] } | null
    ) => void | Promise<void | (() => void | Promise<void>)>
  }) => (
    <button
      type="button"
      data-testid="mock-start-background-task"
      onClick={() => {
        const address = { deviceId: 'local-device', taskId: 'runtime-created' }
        const localProject = { id: 91, name: '运营工作区', tasks: [] as [] }
        void Promise.resolve(prepareTask?.(address, localProject)).then(() => {
          onAddressChange(address)
          return onTaskCreated?.(address, localProject)
        })
      }}
    >
      后台创建 Runtime 任务
    </button>
  ),
}))

const project = {
  id: 11,
  public_id: 'cloud-public-id',
  project_key: 'WEG',
  name: 'Wegent V4',
  description: 'Shared project',
  project_store: 'backend' as const,
  task_provider: 'local' as const,
  provider_config: {},
  created_by_user_id: 1,
  status: 'active',
  version: 1,
  created_at: '2026-07-22T00:00:00Z',
  updated_at: '2026-07-22T00:00:00Z',
}

const item = {
  id: 'WEG-1',
  cloud_project_id: 11,
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
}

describe('workItemTaskInput', () => {
  it('sends the original user-authored title without adding an AI instruction wrapper', () => {
    expect(
      workItemTaskInput({
        title: 'Implement cloud MCP',
        description: '  Use the shared workspace  ',
      })
    ).toBe('Implement cloud MCP')
  })

  it('uses the description only when the title is empty', () => {
    expect(workItemTaskInput({ title: '  ', description: 'Use the shared workspace' })).toBe(
      'Use the shared workspace'
    )
  })
})

describe('shouldPrepareWorkItemTask', () => {
  it('prepares an unbound top-level item whenever it enters pending or in progress', () => {
    expect(shouldPrepareWorkItemTask({ parent_id: null, status: 'pending' }, 'inbox', 0)).toBe(true)
    expect(
      shouldPrepareWorkItemTask({ parent_id: null, status: 'in_progress' }, 'pending', 0)
    ).toBe(true)
  })

  it('uses the server-returned post-transition workflow before creating a direct task', () => {
    expect(shouldPrepareWorkItemTask({ ...item, status: 'pending' }, 'inbox', 0)).toBe(true)
    expect(
      shouldPrepareWorkItemTask(
        {
          ...item,
          status: 'pending',
          workflow: {
            version: 1,
            definition_version: 1,
            stage_mode: 'dag',
            advancement_policy: 'manual',
            nodes: [],
          },
        },
        'inbox',
        0
      )
    ).toBe(false)
  })

  it('moves preset and AI-orchestrated issues without opening the manual task composer', () => {
    const presetWorkflowIssue = {
      ...item,
      status: 'inbox' as const,
      workflow: {
        version: 1,
        definition_version: 1,
        stage_mode: 'dag' as const,
        advancement_policy: 'manual' as const,
        nodes: [
          {
            id: 'develop',
            name: '开发',
            depends_on: [],
            required: true,
            workspace_policy: 'composer' as const,
            status: 'ready' as const,
          },
        ],
      },
    }
    const aiManagedIssue = {
      ...item,
      status: 'inbox' as const,
      workflow: {
        version: 1,
        definition_version: 1,
        stage_mode: 'none' as const,
        advancement_policy: 'ai' as const,
        ai_automation_rule_id: 'ai-manager',
        nodes: [],
      },
    }

    expect(isSelfManagedWorkItem(presetWorkflowIssue)).toBe(false)
    expect(
      shouldPrepareWorkItemTask({ ...presetWorkflowIssue, status: 'pending' }, 'inbox', 0)
    ).toBe(false)
    expect(isSelfManagedWorkItem(aiManagedIssue)).toBe(false)
    expect(shouldPrepareWorkItemTask({ ...aiManagedIssue, status: 'pending' }, 'inbox', 0)).toBe(
      false
    )
  })

  it('lets robot and team assignments own Runtime task creation', () => {
    expect(
      shouldPrepareWorkItemTask(
        {
          parent_id: null,
          status: 'in_progress',
          assignee_agent_id: 'agent-cloud',
          assignee_team_id: null,
        },
        'inbox',
        0
      )
    ).toBe(false)
    expect(
      shouldPrepareWorkItemTask(
        {
          parent_id: null,
          status: 'in_progress',
          assignee_agent_id: null,
          assignee_team_id: 88001,
        },
        'inbox',
        0
      )
    ).toBe(false)
  })

  it('treats legacy workflows with stages as preset orchestration', () => {
    expect(
      isSelfManagedWorkItem({
        workflow: {
          version: 1,
          definition_version: 1,
          advancement_policy: 'manual',
          nodes: [
            {
              id: 'legacy',
              name: '旧阶段',
              depends_on: [],
              required: true,
              workspace_policy: 'composer',
              status: 'ready',
            },
          ],
        },
      })
    ).toBe(false)
  })

  it('does not recreate a task for reorder, child items, or already-bound work items', () => {
    expect(shouldPrepareWorkItemTask({ parent_id: null, status: 'pending' }, 'pending', 0)).toBe(
      false
    )
    expect(shouldPrepareWorkItemTask({ parent_id: 'WEG-1', status: 'inbox' }, 'pending', 0)).toBe(
      false
    )
    expect(shouldPrepareWorkItemTask({ parent_id: null, status: 'inbox' }, 'pending', 1)).toBe(
      false
    )
  })
})

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
          loop_item_id: item.id,
          task_user_id: 1,
          device_id: 'local-device',
          task_id: 'runtime-248868498',
          task_title: 'Implement cloud delivery',
          backend_task_id: null,
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
      createCloudFolder: vi.fn(async (_projectId: number, path: string) => ({
        id: 51,
        cloud_project_id: 11,
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
    },
    modelApi: {
      listModels: vi.fn(async () => ({
        data: [{ name: 'gpt-5-codex', type: 'runtime', displayName: 'GPT-5 Codex' }],
      })),
    },
  } as unknown as WorkbenchServices
  const workbenchServices = { ...baseServices, ...overrides } as WorkbenchServices
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
      task_bindings: bindingResults.flat(),
      members,
      agents,
    }
  })
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

describe('CloudTodoWorkspace', () => {
  beforeEach(() => {
    clearRuntimeConversationCacheForTests()
    telemetryMocks.track.mockClear()
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
    clearRuntimeConversationCacheForTests()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    localStorage.clear()
  })

  it('renders only the board content shell when embedded in the workbench', async () => {
    const workbenchServices = services()
    vi.mocked(workbenchServices.deliveryApi!.listCloudProjects).mockResolvedValue({
      items: [{ ...project, id: String(project.id) }],
    })
    render(
      <CloudTodoWorkspace
        user={{ id: 1, user_name: 'local', email: 'local@example.com' } as User}
        localProjects={[]}
        services={workbenchServices}
        embedded
        activeProjectRef={{
          projectStore: 'backend',
          projectId: String(project.id),
        }}
      />
    )

    await screen.findByTestId('cloud-project-header')
    const workspace = screen.getByTestId('cloud-todo-workspace')
    expect(workspace).toHaveAttribute('data-embedded', 'true')
    expect(workspace.querySelector('aside')).not.toBeInTheDocument()
    expect(screen.queryByTestId('cloud-todo-collapsed-chrome-controls')).not.toBeInTheDocument()
  })

  it('loads Git-backed boards by column and fetches details only after opening a card', async () => {
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {})
    const workbenchServices = services()
    const githubProject = {
      ...project,
      id: String(project.id),
      task_provider: 'github' as const,
    }
    const summary = {
      ...item,
      cloud_project_id: String(project.id),
      status: 'pending',
      description: '',
      detail_loaded: false,
    }
    const next = { ...summary, id: 'WEG-2', sequence_number: 2, title: 'Second issue' }
    vi.mocked(workbenchServices.deliveryApi!.listCloudProjects).mockResolvedValue({
      items: [githubProject],
    })
    workbenchServices.deliveryApi!.listLoopItemsPage = vi.fn(async (_projectId, options) => ({
      items: options.status === 'pending' ? (options.cursor ? [summary, next] : [summary]) : [],
      task_bindings: [],
      next_cursor: options.status === 'pending' && !options.cursor ? 'next-page' : null,
    }))
    workbenchServices.deliveryApi!.getLoopItem = vi.fn(async () => ({
      ...summary,
      description: 'Full issue body',
      detail_loaded: true,
    }))

    render(
      <CloudTodoWorkspace
        user={{ id: 1, user_name: 'local', email: 'local@example.com' } as User}
        localProjects={[]}
        services={workbenchServices}
        embedded
        activeProjectRef={{ projectStore: 'backend', projectId: String(project.id) }}
      />
    )

    await screen.findByTestId(`cloud-todo-card-${summary.id}`)
    expect(workbenchServices.deliveryApi!.getBoardSnapshot).not.toHaveBeenCalled()
    expect(workbenchServices.deliveryApi!.listLoopItemsPage).toHaveBeenCalledTimes(5)
    expect(
      vi
        .mocked(workbenchServices.deliveryApi!.listLoopItemsPage)
        .mock.calls.every(([, options]) => options.limit === 10)
    ).toBe(true)
    expect(screen.getByTestId('cloud-todo-column-load-more-pending')).toHaveTextContent('加载更多')

    await userEvent.click(screen.getByTestId('cloud-todo-column-load-more-pending'))
    await screen.findByTestId(`cloud-todo-card-${next.id}`)
    expect(screen.getAllByTestId(`cloud-todo-card-${summary.id}`)).toHaveLength(1)
    expect(workbenchServices.deliveryApi!.listLoopItemsPage).toHaveBeenLastCalledWith(
      String(project.id),
      expect.objectContaining({ status: 'pending', cursor: 'next-page', limit: 10 })
    )
    expect(infoSpy).toHaveBeenCalledWith(
      '[Wework project board] column page merged',
      expect.objectContaining({
        status: 'pending',
        cursor: 'next-page',
        receivedIds: [summary.id, next.id],
        duplicateIds: [summary.id],
      })
    )
    fireEvent.click(screen.getByTestId(`cloud-todo-card-${summary.id}`))
    await waitFor(() => {
      expect(workbenchServices.deliveryApi!.getLoopItem).toHaveBeenCalledWith(summary.id)
    })
  })

  it('refreshes the active board when a runtime task binding changes externally', async () => {
    const workbenchServices = services()
    vi.mocked(workbenchServices.deliveryApi!.listCloudProjects).mockResolvedValue({
      items: [{ ...project, id: String(project.id) }],
    })

    render(
      <CloudTodoWorkspace
        user={{ id: 1, user_name: 'local', email: 'local@example.com' } as User}
        localProjects={[]}
        services={workbenchServices}
        embedded
        activeProjectRef={{
          projectStore: 'backend',
          projectId: String(project.id),
        }}
      />
    )

    await screen.findByTestId('cloud-project-header')
    await waitFor(() => {
      expect(workbenchServices.deliveryApi!.getBoardSnapshot).toHaveBeenCalledTimes(1)
    })
    const initialSnapshotRequests = vi.mocked(workbenchServices.deliveryApi!.getBoardSnapshot).mock
      .calls.length

    act(() => {
      publishProjectSpaceTaskBindingChanged({
        deviceId: 'local-device',
        taskId: 'runtime-moved-to-board',
      })
    })

    await waitFor(() => {
      expect(workbenchServices.deliveryApi!.getBoardSnapshot).toHaveBeenCalledTimes(
        initialSnapshotRequests + 1
      )
    })
  })

  it('shows and opens one logical My Tasks project across local and cloud stores', async () => {
    const defaultProject = {
      ...project,
      id: 'default-work-items',
      public_id: 'default-work-items',
      project_key: 'WORK',
      name: '我的任务',
      metadata: { system_kind: 'default_work_items' },
    }
    const localApi = services().deliveryApi!
    const cloudApi = services().deliveryApi!
    localApi.listCloudProjects = vi.fn(async () => ({
      items: [{ ...defaultProject, project_store: 'local' as const }],
    }))
    cloudApi.listCloudProjects = vi.fn(async () => ({
      items: [{ ...defaultProject, project_store: 'backend' as const }],
    }))
    localApi.listLoopItems = vi.fn(async () => ({ items: [] }))
    cloudApi.listLoopItems = vi.fn(async () => ({ items: [] }))
    const onActiveProjectChange = vi.fn()

    render(
      <CloudTodoWorkspace
        user={{ id: 1, user_name: 'local', email: 'local@example.com' } as User}
        localProjects={[]}
        services={services({
          deliveryApi: cloudApi,
          projectSpaceApis: {
            local: localApi,
            cloud: cloudApi,
            defaultLocation: 'cloud',
          },
        })}
        activeProjectRef={null}
        defaultProjectRequested
        onActiveProjectChange={onActiveProjectChange}
      />
    )

    expect(await screen.findByTestId('cloud-project-header')).toHaveTextContent('我的任务')
    expect(screen.getAllByTestId('cloud-sidebar-project-default-work-items')).toHaveLength(1)
    await waitFor(() => {
      expect(onActiveProjectChange).toHaveBeenCalledWith(
        expect.objectContaining({
          id: 'default-work-items',
          project_store: 'backend',
        })
      )
    })
  })

  it('loads a cloud board through one snapshot request without split reads', async () => {
    const workbenchServices = services()
    const snapshot = vi.fn(async () => ({
      items: [item],
      task_bindings: [],
      members: [],
      agents: [],
    }))
    workbenchServices.deliveryApi!.getBoardSnapshot = snapshot

    render(
      <CloudTodoWorkspace
        user={{ id: 1, user_name: 'local', email: 'local@example.com' } as User}
        localProjects={[]}
        services={workbenchServices}
      />
    )

    await userEvent.click((await screen.findAllByText('Wegent V4'))[0])
    expect(await screen.findByTestId('cloud-todo-card-WEG-1')).toBeInTheDocument()

    expect(snapshot).toHaveBeenCalledOnce()
    expect(snapshot).toHaveBeenCalledWith(project.id)
    expect(workbenchServices.deliveryApi!.listLoopItems).not.toHaveBeenCalled()
    expect(workbenchServices.deliveryApi!.listTaskBindings).not.toHaveBeenCalled()
    expect(workbenchServices.deliveryApi!.listCloudProjectMembers).not.toHaveBeenCalled()
  })

  it('marks an unread Issue as read when its detail opens', async () => {
    const workbenchServices = services()
    const unreadItem = { ...item, is_unread: true, content_revision: 2 }
    vi.mocked(workbenchServices.deliveryApi!.listLoopItems).mockResolvedValue({
      items: [unreadItem],
    })
    vi.mocked(workbenchServices.deliveryApi!.markLoopItemRead).mockResolvedValue({
      ...unreadItem,
      is_unread: false,
    })

    render(
      <CloudTodoWorkspace
        user={{ id: 1, user_name: 'local', email: 'local@example.com' } as User}
        localProjects={[]}
        services={workbenchServices}
      />
    )

    await userEvent.click((await screen.findAllByText('Wegent V4'))[0])
    expect(await screen.findByTestId('cloud-todo-card-unread-WEG-1')).toBeInTheDocument()

    await userEvent.click(screen.getByTestId('cloud-todo-card-WEG-1'))

    await waitFor(() => {
      expect(workbenchServices.deliveryApi!.markLoopItemRead).toHaveBeenCalledWith('WEG-1')
    })
    expect(screen.queryByTestId('cloud-todo-card-unread-WEG-1')).not.toBeInTheDocument()
  })

  it('shows only the current runtime task and hides child-task lists and actions', async () => {
    const child = {
      ...item,
      id: 'WEG-2',
      sequence_number: 2,
      parent_id: item.id,
      title: '补充回归截图',
    }
    const workbenchServices = services()
    workbenchServices.deliveryApi!.listLoopItems = vi.fn(async () => ({
      items: [item, child],
    }))
    workbenchServices.deliveryApi!.listTaskBindings = vi.fn(async itemId =>
      itemId === item.id
        ? [
            {
              id: 2,
              loop_item_id: item.id,
              task_user_id: 1,
              device_id: 'local-device',
              task_id: 'runtime-2',
              task_title: '验证完整工作流',
              backend_task_id: null,
              linked_at: '2026-08-16T00:01:00Z',
            },
            {
              id: 1,
              loop_item_id: item.id,
              task_user_id: 1,
              device_id: 'local-device',
              task_id: 'runtime-1',
              task_title: '分析创建任务交互',
              backend_task_id: null,
              linked_at: '2026-08-16T00:00:00Z',
            },
          ]
        : []
    )

    render(
      <CloudTodoWorkspace
        user={{ id: 1, user_name: 'local', email: 'local@example.com' } as User}
        localProjects={[]}
        services={workbenchServices}
      />
    )

    await userEvent.click((await screen.findAllByText('Wegent V4'))[0])
    expect(await screen.findByTestId('cloud-todo-card-tasks-WEG-1')).not.toHaveTextContent(
      '验证完整工作流'
    )
    expect(screen.getByTestId('cloud-todo-card-tasks-WEG-1')).not.toHaveTextContent('正在执行')
    expect(screen.getByTestId('cloud-todo-card-tasks-WEG-1')).not.toHaveTextContent(
      '分析创建任务交互'
    )
    expect(screen.queryByText('补充回归截图')).not.toBeInTheDocument()
    expect(screen.queryByTestId('cloud-todo-card-add-child-WEG-1')).not.toBeInTheDocument()
  })

  it('shows live thinking for the running runtime task on its board card', async () => {
    const workbenchServices = services()
    workbenchServices.deliveryApi!.listTaskBindings = vi.fn(async () => [
      {
        id: 2,
        loop_item_id: item.id,
        task_user_id: 1,
        device_id: 'local-device',
        task_id: 'runtime-2',
        task_title: '验证完整工作流',
        backend_task_id: null,
        linked_at: '2026-08-16T00:01:00Z',
      },
    ])
    const address = { deviceId: 'local-device', taskId: 'runtime-2' }
    applyRuntimeConversationAction(address, {
      type: 'assistant_started',
      taskId: address.taskId,
      subtaskId: 'turn-1',
    })
    applyRuntimeConversationAction(address, {
      type: 'assistant_chunk',
      subtaskId: 'turn-1',
      content: '',
      reasoningChunk: 'Investigating board data flow',
    })

    render(
      <CloudTodoWorkspace
        user={{ id: 1, user_name: 'local', email: 'local@example.com' } as User}
        localProjects={[]}
        runtimeWork={{
          projects: [
            {
              project: { id: project.id, name: project.name },
              deviceWorkspaces: [
                {
                  deviceId: address.deviceId,
                  available: true,
                  workspacePath: '/tmp/wegent',
                  tasks: [
                    {
                      taskId: address.taskId,
                      workspacePath: '/tmp/wegent',
                      title: '验证完整工作流',
                      runtime: 'codex',
                      running: false,
                    },
                  ],
                },
              ],
            },
          ],
          chats: [],
          totalTasks: 1,
        }}
        services={workbenchServices}
      />
    )

    await userEvent.click((await screen.findAllByText('Wegent V4'))[0])
    expect(await screen.findByTestId('cloud-todo-card-thinking-WEG-1')).toHaveTextContent(
      '正在思考 · Investigating board data flow'
    )
    expect(screen.getByTestId('cloud-todo-card-activity-WEG-1')).toHaveClass('text-xs')
    expect(screen.getByTestId('cloud-todo-card-activity-WEG-1')).not.toHaveClass(
      'h-[60px]',
      'max-h-15',
      'overflow-y-auto',
      'scrollbar-none',
      'group-hover:h-20',
      'ml-5',
      'mt-1.5',
      'border-l',
      'pl-2'
    )

    act(() => {
      applyRuntimeConversationAction(address, {
        type: 'block_created',
        subtaskId: 'turn-1',
        block: {
          id: 'process-1',
          subtaskId: 'turn-1',
          type: 'text',
          content: '先检查项目看板如何组织运行中的消息。',
          status: 'done',
          createdAt: Date.now(),
        },
      })
      applyRuntimeConversationAction(address, {
        type: 'block_created',
        subtaskId: 'turn-1',
        block: {
          id: 'tool-1',
          subtaskId: 'turn-1',
          type: 'tool',
          toolName: 'functions.exec_command',
          toolInput: { cmd: 'pnpm test' },
          status: 'streaming',
          createdAt: Date.now(),
        },
      })
      applyRuntimeConversationAction(address, {
        type: 'assistant_chunk',
        subtaskId: 'turn-1',
        content: '',
        reasoningChunk: '. Rendering latest thinking',
      })
    })

    expect(screen.getByTestId('cloud-todo-card-thinking-WEG-1')).toHaveTextContent(
      '正在思考 · Rendering latest thinking'
    )
    expect(screen.getByTestId('cloud-todo-card-tool-WEG-1-tool-1')).toHaveTextContent(
      '运行命令 · pnpm test'
    )
    expect(screen.getByTestId('cloud-todo-card-tool-line-WEG-1')).toHaveClass(
      'ml-2',
      'border-l',
      'pl-3'
    )
    expect(
      screen
        .getByTestId('cloud-todo-card-thinking-WEG-1')
        .compareDocumentPosition(screen.getByTestId('cloud-todo-card-tool-WEG-1-tool-1')) &
        Node.DOCUMENT_POSITION_FOLLOWING
    ).not.toBe(0)
    expect(screen.getByTestId('cloud-todo-card-thinking-WEG-1')).toHaveClass('text-xs', 'leading-5')

    fireEvent.mouseEnter(screen.getByTestId('cloud-todo-card-WEG-1'))
    const progressPopup = await screen.findByTestId('cloud-todo-card-progress-popup-WEG-1')
    expect(progressPopup).toHaveTextContent('当前任务进展')
    expect(progressPopup).toHaveTextContent('验证完整工作流')
    expect(screen.getByTestId('cloud-todo-card-popup-conversation-WEG-1')).toHaveAttribute(
      'data-task-id',
      'runtime-2'
    )
    expect(screen.getByTestId('cloud-todo-card-popup-conversation-WEG-1')).toHaveAttribute(
      'data-collapse-composer',
      'true'
    )
    expect(screen.getByTestId('cloud-todo-card-popup-scroll-WEG-1')).toHaveClass(
      'max-h-[min(68vh,42rem)]',
      'overflow-y-auto'
    )

    fireEvent.click(screen.getByTestId('mock-dnd-drag-start'))
    expect(screen.queryByTestId('cloud-todo-card-progress-popup-WEG-1')).not.toBeInTheDocument()
    fireEvent.click(screen.getByTestId('mock-dnd-drag-cancel'))

    fireEvent.mouseLeave(screen.getByTestId('cloud-todo-card-WEG-1'))
    fireEvent.mouseEnter(screen.getByTestId('cloud-todo-card-WEG-1'))
    expect(await screen.findByTestId('cloud-todo-card-progress-popup-WEG-1')).toBeInTheDocument()

    await userEvent.click(screen.getByTestId('cloud-todo-card-tasks-WEG-1'))
    expect(screen.queryByTestId('cloud-todo-card-progress-popup-WEG-1')).not.toBeInTheDocument()
    expect(await screen.findByTestId('cloud-todo-detail')).toBeInTheDocument()
    expect(await screen.findByTestId('ai-chat-modal')).toHaveAttribute(
      'data-runtime-task-id',
      'runtime-2'
    )
  })

  it('shows the cached final assistant response on an in-review task card', async () => {
    const reviewItem = { ...item, status: 'in_review' as const }
    const workbenchServices = services()
    workbenchServices.deliveryApi!.listLoopItems = vi.fn(async () => ({
      items: [reviewItem],
    }))
    workbenchServices.deliveryApi!.listTaskBindings = vi.fn(async () => [
      {
        id: 2,
        loop_item_id: reviewItem.id,
        task_user_id: 1,
        device_id: 'local-device',
        task_id: 'runtime-review',
        task_title: '验证最终回复',
        backend_task_id: null,
        linked_at: '2026-08-21T00:01:00Z',
      },
    ])
    const address = { deviceId: 'local-device', taskId: 'runtime-review' }
    applyRuntimeConversationAction(address, {
      type: 'assistant_started',
      taskId: address.taskId,
      subtaskId: 'turn-review',
    })
    applyRuntimeConversationAction(address, {
      type: 'assistant_chunk',
      subtaskId: 'turn-review',
      itemId: 'assistant-review',
      content: '第一行\n第二行\n第三行\n第四行',
    })
    applyRuntimeConversationAction(address, {
      type: 'assistant_done',
      subtaskId: 'turn-review',
    })

    render(
      <CloudTodoWorkspace
        user={{ id: 1, user_name: 'local', email: 'local@example.com' } as User}
        localProjects={[]}
        services={workbenchServices}
      />
    )

    await userEvent.click((await screen.findAllByText('Wegent V4'))[0])
    expect(await screen.findByTestId('cloud-todo-card-final-response-WEG-1')).toHaveTextContent(
      '第四行'
    )
    expect(screen.getByTestId('cloud-todo-card-final-response-WEG-1')).not.toHaveTextContent(
      '第一行'
    )

    fireEvent.mouseEnter(screen.getByTestId('cloud-todo-card-WEG-1'))
    const progressPopup = await screen.findByTestId('cloud-todo-card-progress-popup-WEG-1')
    const progressResponse = screen.getByTestId('cloud-todo-card-popup-conversation-WEG-1')
    expect(progressPopup).toHaveTextContent('当前任务进展')
    expect(progressResponse).toHaveAttribute('data-task-id', 'runtime-review')
  })

  it('loads persisted task output for an in-progress Issue on the board', async () => {
    const workbenchServices = services()
    workbenchServices.deliveryApi!.listTaskBindings = vi.fn(async () => [
      {
        id: 2,
        loop_item_id: item.id,
        task_user_id: 1,
        device_id: 'local-device',
        task_id: 'runtime-in-progress',
        task_title: '修复看板输出',
        backend_task_id: null,
        linked_at: '2026-08-23T00:01:00Z',
      },
    ])
    const getRuntimeTranscript = vi.fn(async request => ({
      taskId: request.taskId,
      workspacePath: '/tmp/wegent',
      runtime: 'codex' as const,
      running: false,
      messages: [
        {
          id: 'user-output',
          role: 'user',
          content: '请修复看板输出',
          created_at: '2026-08-23T00:01:30Z',
        },
        {
          id: 'assistant-output',
          role: 'assistant',
          content: '已经定位问题\n正在验证修复',
          created_at: '2026-08-23T00:02:00Z',
        },
      ],
      turns: [],
    }))
    workbenchServices.runtimeWorkApi = {
      getRuntimeTranscript,
    } as WorkbenchServices['runtimeWorkApi']

    render(
      <CloudTodoWorkspace
        user={{ id: 1, user_name: 'local', email: 'local@example.com' } as User}
        localProjects={[]}
        runtimeWork={{
          projects: [
            {
              project: { id: project.id, name: project.name },
              deviceWorkspaces: [
                {
                  deviceId: 'local-device',
                  available: true,
                  workspacePath: '/tmp/wegent',
                  tasks: [
                    {
                      taskId: 'runtime-in-progress',
                      workspacePath: '/tmp/wegent',
                      title: '修复看板输出',
                      runtime: 'codex',
                      running: false,
                    },
                  ],
                },
              ],
            },
          ],
          chats: [],
          totalTasks: 1,
        }}
        services={workbenchServices}
      />
    )

    await userEvent.click((await screen.findAllByText('Wegent V4'))[0])

    expect(await screen.findByTestId('cloud-todo-card-final-response-WEG-1')).toHaveTextContent(
      '正在验证修复'
    )
    expect(getRuntimeTranscript).toHaveBeenCalledWith(
      expect.objectContaining({
        deviceId: 'local-device',
        taskId: 'runtime-in-progress',
        limit: 50,
      })
    )

    fireEvent.mouseEnter(screen.getByTestId('cloud-todo-card-tasks-WEG-1'))
    const conversation = await screen.findByTestId('cloud-todo-card-popup-conversation-WEG-1')
    expect(conversation).toHaveAttribute('data-device-id', 'local-device')
    expect(conversation).toHaveAttribute('data-task-id', 'runtime-in-progress')
  })

  it('reports the concrete project name for the active document tab', async () => {
    const onActiveProjectChange = vi.fn()

    render(
      <CloudTodoWorkspace
        user={{ id: 1, user_name: 'local', email: 'local@example.com' } as User}
        localProjects={[]}
        services={services()}
        activeProjectRef={null}
        onActiveProjectChange={onActiveProjectChange}
      />
    )

    await userEvent.click(await screen.findByTestId('cloud-sidebar-project-11'))
    expect(onActiveProjectChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ id: 11, name: 'Wegent V4' })
    )

    await userEvent.click(screen.getByTestId('cloud-my-work'))
    expect(onActiveProjectChange).toHaveBeenLastCalledWith(null)
  })

  it('renders local projects without waiting for the cloud project list', async () => {
    const localProject = {
      ...project,
      id: 21,
      name: 'Local Board',
      project_store: 'local' as const,
    }
    const localServices = services()
    const localApi = localServices.deliveryApi!
    localApi.listCloudProjects = vi.fn(async () => ({ items: [localProject] }))
    const cloudApi = services().deliveryApi!
    cloudApi.listCloudProjects = vi.fn(() => new Promise(() => undefined))
    const workbenchServices = services({
      deliveryApi: cloudApi,
      projectSpaceApis: {
        local: localApi,
        cloud: cloudApi,
        defaultLocation: 'local' as const,
      },
      deviceApi: localServices.deviceApi,
      modelApi: localServices.modelApi,
      teamApi: localServices.teamApi,
    })

    render(
      <CloudTodoWorkspace
        user={{ id: 1, user_name: 'local', email: 'local@example.com' } as User}
        localProjects={[]}
        services={workbenchServices}
      />
    )

    expect(await screen.findByTestId('cloud-sidebar-project-21')).toHaveTextContent('Local Board')
    expect(screen.queryByText('正在加载项目空间…')).not.toBeInTheDocument()
    expect(localApi.listLoopItems).not.toHaveBeenCalled()
    expect(localApi.listCloudProjectMembers).not.toHaveBeenCalled()
  })

  it('surfaces a local project-list failure instead of rendering an empty state', async () => {
    const localServices = services()
    const localApi = localServices.deliveryApi!
    const recoveredProject = {
      ...project,
      id: 23,
      name: 'Recovered Local',
      project_store: 'local' as const,
    }
    localApi.listCloudProjects = vi
      .fn()
      .mockRejectedValueOnce(new Error('local executor unavailable'))
      .mockResolvedValue({ items: [recoveredProject] })
    const cloudApi = services().deliveryApi!
    cloudApi.listCloudProjects = vi.fn(() => new Promise(() => undefined))

    render(
      <CloudTodoWorkspace
        user={{ id: 1, user_name: 'local', email: 'local@example.com' } as User}
        localProjects={[]}
        services={services({
          deliveryApi: cloudApi,
          projectSpaceApis: {
            local: localApi,
            cloud: cloudApi,
            defaultLocation: 'local',
          },
        })}
      />
    )

    expect(await screen.findByTestId('local-project-spaces-error')).toHaveTextContent(
      'local executor unavailable'
    )
    expect(screen.queryByText('创建第一个项目空间')).not.toBeInTheDocument()

    await userEvent.click(screen.getByTestId('local-project-spaces-retry'))
    expect(await screen.findByTestId('cloud-sidebar-project-23')).toHaveTextContent(
      'Recovered Local'
    )
    expect(screen.queryByTestId('local-project-spaces-error')).not.toBeInTheDocument()
  })

  it('keeps local project details inside local services while cloud is unavailable', async () => {
    const localProject = {
      ...project,
      id: 22,
      name: 'Offline Local',
      project_store: 'local' as const,
    }
    const localItem = { ...item, id: 'LOCAL-1', cloud_project_id: 22 }
    const localServices = services()
    const localApi = localServices.deliveryApi!
    localApi.listCloudProjects = vi.fn(async () => ({ items: [localProject] }))
    localApi.listLoopItems = vi.fn(async () => ({ items: [localItem] }))
    const cloudServices = services()
    const cloudApi = cloudServices.deliveryApi!
    cloudApi.listCloudProjects = vi.fn(() => new Promise(() => undefined))
    const workbenchServices = {
      ...localServices,
      deliveryApi: cloudApi,
      projectSpaceApis: {
        local: localApi,
        cloud: cloudApi,
        defaultLocation: 'local' as const,
      },
      projectSpaceDetailServices: {
        local: {
          deliveryApi: localApi,
          deviceApi: localServices.deviceApi,
          modelApi: localServices.modelApi,
          teamApi: localServices.teamApi,
        },
      },
    } as WorkbenchServices

    render(
      <CloudTodoWorkspace
        user={{ id: 1, user_name: 'local', email: 'local@example.com' } as User}
        localProjects={[]}
        services={workbenchServices}
      />
    )

    await userEvent.click(await screen.findByTestId('cloud-sidebar-project-22'))
    expect(await screen.findByTestId('cloud-todo-card-LOCAL-1')).toBeInTheDocument()
    await userEvent.click(screen.getByTestId('cloud-project-files-view'))
    expect(await screen.findByTestId('cloud-files-upload')).toBeInTheDocument()
    await userEvent.click(screen.getByTestId('cloud-project-manage-view'))
    expect(await screen.findByTestId('cloud-project-members-toggle')).toBeInTheDocument()
    await userEvent.click(screen.getByTestId('cloud-project-automation-view'))
    expect(await screen.findByTestId('project-automation-view')).toBeInTheDocument()

    expect(cloudApi.listLoopItems).not.toHaveBeenCalled()
    expect(cloudApi.listCloudProjectMembers).not.toHaveBeenCalled()
    expect(cloudApi.listCloudFiles).not.toHaveBeenCalled()
  })

  it('resets project-specific view state when a controlled project changes externally', async () => {
    const user = { id: 1, user_name: 'local', email: 'local@example.com' } as User
    const workbenchServices = services()
    const controlledProject = { ...project, id: String(project.id) }
    vi.mocked(workbenchServices.deliveryApi!.listCloudProjects).mockResolvedValue({
      items: [controlledProject],
    })
    const view = render(
      <CloudTodoWorkspace
        user={user}
        localProjects={[]}
        services={workbenchServices}
        activeProjectRef={{ projectStore: 'backend', projectId: controlledProject.id }}
      />
    )

    await userEvent.click(await screen.findByTestId('cloud-project-manage-view'))
    expect(screen.getByText('管理项目')).toBeInTheDocument()

    view.rerender(
      <CloudTodoWorkspace
        user={user}
        localProjects={[]}
        services={workbenchServices}
        activeProjectRef={{ projectStore: 'backend', projectId: controlledProject.id }}
      />
    )

    expect(screen.getByText('管理项目')).toBeInTheDocument()

    view.rerender(
      <CloudTodoWorkspace
        user={user}
        localProjects={[]}
        services={workbenchServices}
        activeProjectRef={null}
      />
    )

    await waitFor(() => expect(screen.queryByText('管理项目')).not.toBeInTheDocument())
    expect(screen.getByTestId('cloud-projects-home-manage')).toBeInTheDocument()
  })

  it('preserves project view state when a controlled project reference is recreated', async () => {
    const user = { id: 1, user_name: 'local', email: 'local@example.com' } as User
    const workbenchServices = services()
    const controlledProject = { ...project, id: String(project.id) }
    vi.mocked(workbenchServices.deliveryApi!.listCloudProjects).mockResolvedValue({
      items: [controlledProject],
    })
    const props = {
      user,
      localProjects: [],
      services: workbenchServices,
    }
    const view = render(
      <CloudTodoWorkspace
        {...props}
        activeProjectRef={{ projectStore: 'backend', projectId: controlledProject.id }}
      />
    )

    await userEvent.click(await screen.findByTestId('cloud-project-automation-view'))
    expect(await screen.findByTestId('project-automation-view')).toBeInTheDocument()

    view.rerender(
      <CloudTodoWorkspace
        {...props}
        activeProjectRef={{ projectStore: 'backend', projectId: controlledProject.id }}
      />
    )

    expect(screen.getByTestId('project-automation-view')).toBeInTheDocument()
  })

  it('opens project-space settings from the root navigation', async () => {
    render(
      <CloudTodoWorkspace
        user={{ id: 1, user_name: 'local', email: 'local@example.com' } as User}
        localProjects={[]}
        services={services()}
      />
    )

    await userEvent.click(await screen.findByTestId('cloud-project-settings'))

    expect(await screen.findByTestId('project-space-settings')).toBeInTheDocument()
    expect(screen.getByTestId('project-space-api-wiki')).toHaveTextContent(
      'POST /api/v1/cloud-projects'
    )
  })

  it('renames and archives a project from the sidebar menu', async () => {
    const workbenchServices = services()

    render(
      <CloudTodoWorkspace
        user={{ id: 1, user_name: 'local', email: 'local@example.com' } as User}
        localProjects={[]}
        services={workbenchServices}
      />
    )

    await userEvent.click(await screen.findByTestId('cloud-sidebar-project-more-11'))
    await userEvent.click(screen.getByTestId('cloud-sidebar-rename-project-11'))
    await userEvent.clear(screen.getByTestId('cloud-project-rename-input'))
    await userEvent.type(screen.getByTestId('cloud-project-rename-input'), 'Wegent Next')
    await userEvent.click(screen.getByTestId('cloud-project-rename-confirm'))

    await waitFor(() =>
      expect(workbenchServices.deliveryApi!.updateCloudProject).toHaveBeenCalledWith(11, {
        name: 'Wegent Next',
        version: 1,
      })
    )
    expect((await screen.findAllByText('Wegent Next')).length).toBeGreaterThan(0)

    await userEvent.click(screen.getByTestId('cloud-sidebar-project-more-11'))
    await userEvent.click(screen.getByTestId('cloud-sidebar-archive-project-11'))
    await userEvent.click(screen.getByTestId('cloud-project-archive-confirm'))

    await waitFor(() =>
      expect(workbenchServices.deliveryApi!.archiveCloudProject).toHaveBeenCalledWith(11, 2)
    )
    expect(screen.queryByTestId('cloud-sidebar-project-11')).not.toBeInTheDocument()
  })

  it('archives a task from its board card', async () => {
    const workbenchServices = services()

    render(
      <CloudTodoWorkspace
        user={{ id: 1, user_name: 'local', email: 'local@example.com' } as User}
        localProjects={[]}
        services={workbenchServices}
      />
    )

    await userEvent.click((await screen.findAllByText('Wegent V4'))[0])
    expect(telemetryMocks.track).toHaveBeenCalledWith('board_view_opened', {
      source: 'cloud',
      view: 'board',
    })
    await userEvent.click(await screen.findByTestId('cloud-todo-card-more-WEG-1'))
    await userEvent.click(screen.getByTestId('cloud-todo-card-archive-WEG-1'))
    await userEvent.click(screen.getByTestId('cloud-todo-archive-confirm'))

    await waitFor(() =>
      expect(workbenchServices.deliveryApi!.archiveLoopItem).toHaveBeenCalledWith('WEG-1')
    )
    expect(screen.queryByTestId('cloud-todo-card-WEG-1')).not.toBeInTheDocument()
  })

  it('opens project chat for every project provider', async () => {
    const workbenchServices = services()
    const requestCatalogs = vi.fn()
    const workbench = {
      projectChat: { requestCatalogs },
    } as unknown as WorkbenchContextValue

    render(
      <WorkbenchContext.Provider value={workbench}>
        <CloudTodoWorkspace
          user={{ id: 1, user_name: 'local', email: 'local@example.com' } as User}
          localProjects={[{ id: 91, name: '运营工作区', tasks: [] }]}
          services={workbenchServices}
        />
      </WorkbenchContext.Provider>
    )

    await userEvent.click((await screen.findAllByText('Wegent V4'))[0])
    expect(screen.getByTestId('cloud-project-ask-ai')).toHaveTextContent('私信 AI')
    await userEvent.click(screen.getByTestId('cloud-project-ask-ai'))
    expect(requestCatalogs).toHaveBeenCalledTimes(1)
    expect(screen.getByTestId('project-space-chat-sidebar')).toHaveAttribute(
      'data-project-id',
      '11'
    )
    expect(screen.getByTestId('project-space-chat-sidebar')).toBeInTheDocument()
  })

  it('opens a bound task conversation from the card detail and can jump to the full task', async () => {
    const workbenchServices = services()
    const onOpenRuntimeTask = vi.fn()

    render(
      <CloudTodoWorkspace
        user={{ id: 1, user_name: 'local', email: 'local@example.com' } as User}
        localProjects={[{ id: 91, name: '运营工作区', tasks: [] }]}
        services={workbenchServices}
        onOpenRuntimeTask={onOpenRuntimeTask}
      />
    )

    await userEvent.click((await screen.findAllByText('Wegent V4'))[0])
    await userEvent.click(await screen.findByTestId('cloud-todo-card-WEG-1'))

    expect(screen.getByTestId('cloud-todo-panel-stack')).toHaveAttribute(
      'data-conversation-open',
      'false'
    )
    await userEvent.click(await screen.findByTestId('cloud-todo-open-task-conversation-1'))

    expect(screen.getByTestId('cloud-todo-detail')).toBeInTheDocument()
    expect(screen.getByTestId('cloud-todo-panel-stack')).toHaveAttribute(
      'data-conversation-open',
      'true'
    )
    expect(screen.getByTestId('cloud-todo-panel-stack')).toHaveClass('has-conversation')
    const issueResources = screen.getByTestId('cloud-todo-compact-issue')
    expect(issueResources).toHaveTextContent('文件附件')
    expect(issueResources).toHaveTextContent('任务会话')
    expect(issueResources).toHaveTextContent('Implement cloud delivery')
    expect(issueResources).toHaveTextContent('子 Issue')
    expect(issueResources).not.toHaveTextContent('Implement cloud MCP')
    expect(screen.getByTestId('ai-chat-modal')).toHaveAttribute('data-task-id', 'WEG-1')
    expect(screen.getByTestId('ai-chat-modal')).toHaveAttribute(
      'data-runtime-task-id',
      'runtime-248868498'
    )
    expect(screen.getByTestId('ai-chat-modal')).toHaveAttribute('data-open', 'yes')
    await userEvent.click(screen.getByTestId('mock-open-runtime-task'))
    expect(onOpenRuntimeTask).toHaveBeenCalledWith({
      deviceId: 'local-device',
      taskId: 'runtime-248868498',
    })
    await userEvent.click(screen.getByTestId('ai-chat-modal-back'))
    expect(screen.queryByTestId('ai-chat-modal')).not.toBeInTheDocument()
    expect(screen.getByTestId('cloud-todo-detail')).toBeInTheDocument()
    await userEvent.click(await screen.findByTestId('cloud-todo-open-task-conversation-1'))
    await userEvent.click(screen.getByTestId('mock-update-runtime-address'))
    await userEvent.click(screen.getByTestId('ai-chat-modal-back'))
    expect(screen.queryByTestId('ai-chat-modal')).not.toBeInTheDocument()
    expect(screen.getByTestId('cloud-todo-panel-stack')).toHaveAttribute(
      'data-conversation-open',
      'false'
    )
    await userEvent.click(await screen.findByTestId('cloud-todo-open-task-conversation-1'))
    await userEvent.click(screen.getByTestId('ai-chat-modal-close'))
    expect(screen.queryByTestId('ai-chat-modal')).not.toBeInTheDocument()
    expect(screen.queryByTestId('cloud-todo-detail')).not.toBeInTheDocument()
  }, 10_000)

  it('ignores a task address that resolves after reopening the task panel', async () => {
    const workbenchServices = services()
    let resolveBinding: (() => void) | null = null
    const binding = new Promise<void>(resolve => {
      resolveBinding = resolve
    })
    workbenchServices.deliveryApi!.bindTask = vi.fn(() => binding)

    render(
      <CloudTodoWorkspace
        user={{ id: 1, user_name: 'local', email: 'local@example.com' } as User}
        localProjects={[{ id: 91, name: '运营工作区', tasks: [] }]}
        services={workbenchServices}
      />
    )

    await userEvent.click((await screen.findAllByText('Wegent V4'))[0])
    await userEvent.click(await screen.findByTestId('cloud-todo-card-WEG-1'))
    await userEvent.click(screen.getByTestId('cloud-todo-create-task'))
    await userEvent.click(screen.getByTestId('mock-create-runtime-task'))
    await waitFor(() => expect(workbenchServices.deliveryApi!.bindTask).toHaveBeenCalledTimes(1))

    await userEvent.click(screen.getByTestId('ai-chat-modal-close'))
    await userEvent.click(screen.getByTestId('cloud-todo-card-WEG-1'))
    await userEvent.click(screen.getByTestId('cloud-todo-create-task'))
    expect(screen.getByTestId('cloud-todo-panel-stack')).toHaveAttribute(
      'data-conversation-open',
      'true'
    )
    expect(screen.getByTestId('ai-chat-modal')).not.toHaveAttribute(
      'data-runtime-task-id',
      'runtime-created'
    )

    await act(async () => {
      resolveBinding?.()
      await binding
    })

    await waitFor(() =>
      expect(screen.getByTestId('ai-chat-modal')).not.toHaveAttribute(
        'data-runtime-task-id',
        'runtime-created'
      )
    )
    expect(screen.getByTestId('cloud-todo-detail')).toBeInTheDocument()
    expect(screen.getByTestId('cloud-todo-panel-stack')).toHaveAttribute(
      'data-conversation-open',
      'true'
    )
  })

  it('aggregates every bound task and creates another current-user task in the issue detail', async () => {
    const workbenchServices = services()
    workbenchServices.deliveryApi!.listTaskBindings = vi.fn(async () => [
      {
        id: 2,
        loop_item_id: item.id,
        task_user_id: 1,
        device_id: 'local-device',
        task_id: 'runtime-2',
        task_title: '测试修改',
        backend_task_id: null,
        linked_at: '2026-08-17T00:01:00Z',
      },
      {
        id: 1,
        loop_item_id: item.id,
        task_user_id: 1,
        device_id: 'local-device',
        task_id: 'runtime-1',
        task_title: '开发修改',
        backend_task_id: null,
        linked_at: '2026-08-17T00:00:00Z',
      },
    ])

    render(
      <CloudTodoWorkspace
        user={{ id: 1, user_name: 'local', email: 'local@example.com' } as User}
        localProjects={[{ id: 91, name: '运营工作区', tasks: [] }]}
        services={workbenchServices}
      />
    )

    await userEvent.click((await screen.findAllByText('Wegent V4'))[0])
    const boardCard = await screen.findByTestId('cloud-todo-card-WEG-1')
    await userEvent.click(boardCard)

    expect(await screen.findByTestId('cloud-todo-detail')).toBeInTheDocument()
    const tasks = await screen.findByTestId('cloud-todo-tasks')
    expect(screen.getByTestId('cloud-todo-task-list')).toHaveClass('task-detail-flat-task-list')
    expect(tasks).toHaveTextContent('任务')
    expect(tasks).toHaveTextContent('开发修改')
    expect(tasks).toHaveTextContent('测试修改')

    await userEvent.click(screen.getByTestId('cloud-todo-create-task'))

    expect(screen.getByTestId('cloud-todo-detail')).toBeInTheDocument()
    expect(screen.getByTestId('ai-chat-modal')).toHaveAttribute('data-task-id', item.id)
    expect(screen.getByTestId('ai-chat-modal')).not.toHaveAttribute('data-runtime-task-id')
    expect(screen.getByTestId('ai-chat-modal')).toHaveAttribute('data-open', 'yes')
  })

  it('opens the task composer when creating a task from a pending Issue', async () => {
    const workbenchServices = services()
    workbenchServices.deliveryApi!.listLoopItems = vi.fn(async () => ({
      items: [{ ...item, status: 'pending' as const }],
    }))

    render(
      <CloudTodoWorkspace
        user={{ id: 1, user_name: 'local', email: 'local@example.com' } as User}
        localProjects={[{ id: 91, name: '运营工作区', tasks: [] }]}
        services={workbenchServices}
      />
    )

    await userEvent.click((await screen.findAllByText('Wegent V4'))[0])
    await userEvent.click(await screen.findByTestId('cloud-todo-card-WEG-1'))
    await userEvent.click(screen.getByTestId('cloud-todo-create-task'))

    expect(await screen.findByTestId('cloud-todo-detail')).toBeInTheDocument()
    expect(screen.getByTestId('cloud-todo-panel-stack')).toHaveAttribute(
      'data-conversation-open',
      'true'
    )
    expect(screen.getByTestId('ai-chat-modal')).toHaveAttribute('data-task-id', item.id)
    expect(screen.queryByTestId('mock-start-background-task')).not.toBeInTheDocument()
  })

  it('dismisses the unified Issue and conversation panel in one action', async () => {
    render(
      <CloudTodoWorkspace
        user={{ id: 1, user_name: 'local', email: 'local@example.com' } as User}
        localProjects={[]}
        services={services()}
      />
    )

    await userEvent.click((await screen.findAllByText('Wegent V4'))[0])
    await userEvent.click(await screen.findByTestId('cloud-todo-card-WEG-1'))

    expect(await screen.findByTestId('cloud-todo-detail')).toBeInTheDocument()
    expect(screen.getByTestId('cloud-todo-detail').parentElement).toHaveClass(
      'task-detail-workspace-panel-shell'
    )
    expect(screen.getByTestId('cloud-todo-detail')).toHaveClass('todo-floating-panel-surface')
    expect(screen.getByTestId('cloud-todo-detail-dismiss-layer')).toHaveClass('todo-panel-backdrop')

    await userEvent.click(await screen.findByTestId('cloud-todo-open-task-conversation-1'))
    expect(screen.getByTestId('ai-chat-modal')).toBeInTheDocument()

    await userEvent.keyboard('{Escape}')

    expect(screen.queryByTestId('ai-chat-modal')).not.toBeInTheDocument()
    expect(screen.queryByTestId('cloud-todo-detail')).not.toBeInTheDocument()
    expect(screen.queryByTestId('cloud-todo-detail-dismiss-layer')).not.toBeInTheDocument()
  })

  it('hides task ids and configures the properties shown on board cards', async () => {
    const workbenchServices = services()
    workbenchServices.deliveryApi!.listLoopItems = vi.fn(async () => ({
      items: [{ ...item, assignee_name: 'hongyu9', tags: ['发布'] }],
    }))
    workbenchServices.deliveryApi!.updateCloudProject = vi.fn(async (_projectId, values) => ({
      ...project,
      card_display: values.card_display,
      version: project.version + 1,
    }))

    render(
      <CloudTodoWorkspace
        user={{ id: 1, user_name: 'local', email: 'local@example.com' } as User}
        localProjects={[]}
        services={workbenchServices}
      />
    )

    await userEvent.click((await screen.findAllByText('Wegent V4'))[0])

    expect(await screen.findByText('Implement cloud MCP')).toBeInTheDocument()
    expect(screen.queryByText('WEG-1')).not.toBeInTheDocument()
    expect(screen.getByText('hongyu9')).toBeInTheDocument()
    expect(screen.getByTestId('cloud-todo-card-WEG-1')).toHaveTextContent('负责人')
    expect(screen.getByTestId('cloud-todo-card-assignee-WEG-1')).toHaveTextContent('hongyu9')
    expect(screen.getByTestId('cloud-todo-card-WEG-1')).toHaveTextContent('高')
    expect(screen.getAllByText('发布').length).toBeGreaterThan(0)

    await userEvent.click(screen.getByTestId('cloud-project-manage-view'))
    expect(screen.getByTestId('cloud-project-board-layout-settings')).toBeInTheDocument()
    await userEvent.click(screen.getByTestId('cloud-board-display-menu'))
    expect(screen.getByTestId('cloud-project-card-display-settings')).toBeInTheDocument()
    await userEvent.click(screen.getByTestId('cloud-board-display-assignee'))
    await waitFor(() =>
      expect(workbenchServices.deliveryApi!.updateCloudProject).toHaveBeenCalledWith(
        11,
        expect.objectContaining({
          card_display: expect.objectContaining({ show_assignee: false }),
        })
      )
    )
    await userEvent.click(screen.getByTestId('cloud-project-board-view'))
    expect(screen.queryByText('hongyu9')).not.toBeInTheDocument()
    expect(screen.getAllByText('发布').length).toBeGreaterThan(0)
  })

  it('does not render an assignee for an unassigned board card', async () => {
    render(
      <CloudTodoWorkspace
        user={{ id: 1, user_name: 'local', email: 'local@example.com' } as User}
        localProjects={[]}
        services={services()}
      />
    )

    await userEvent.click((await screen.findAllByText('Wegent V4'))[0])

    expect(await screen.findByTestId('cloud-todo-card-WEG-1')).toHaveTextContent('未指定')
    expect(screen.queryByTestId('cloud-todo-card-assignee-WEG-1')).not.toBeInTheDocument()
  })

  it('renders a robot assignee on the board card instead of 未指定', async () => {
    const workbenchServices = services()
    workbenchServices.deliveryApi!.listLoopItems = vi.fn(async () => ({
      items: [
        {
          ...item,
          assignee_user_id: null,
          assignee_agent_id: 'agent-1',
          assignee_agent_name: '发布机器人',
        },
      ],
    }))

    render(
      <CloudTodoWorkspace
        user={{ id: 1, user_name: 'local', email: 'local@example.com' } as User}
        localProjects={[]}
        services={workbenchServices}
      />
    )

    await userEvent.click((await screen.findAllByText('Wegent V4'))[0])

    const assignee = await screen.findByTestId('cloud-todo-card-assignee-WEG-1')
    expect(assignee).toHaveTextContent('发布机器人')
    expect(assignee.querySelector('svg')).not.toBeNull()
    expect(screen.getByTestId('cloud-todo-card-WEG-1')).not.toHaveTextContent('未指定')
    expect(screen.getByTestId('cloud-todo-card-WEG-1')).toHaveTextContent('发布机器人')
  })

  it('resolves a local robot assignee name from the project chat agents', async () => {
    const cloudServices = services()
    cloudServices.deliveryApi!.listCloudProjects = vi.fn(async () => ({ items: [] }))
    const localServices = services()
    localServices.deliveryApi!.listCloudProjects = vi.fn(async () => ({ items: [project] }))
    localServices.deliveryApi!.listLoopItems = vi.fn(async () => ({
      items: [
        {
          ...item,
          assignee_user_id: null,
          assignee_agent_id: 'LA-abc123',
          assignee_agent_name: undefined,
        },
      ],
    }))
    cloudServices.projectSpaceApis = {
      local: localServices.deliveryApi,
      cloud: cloudServices.deliveryApi,
      defaultLocation: 'cloud',
    }
    cloudServices.localProjectChatAgentApi = {
      list: vi.fn(async () => [
        {
          id: 'LA-abc123',
          projectId: String(project.id),
          name: '发布机器人',
          runtime: 'codex',
          model: null,
          systemPrompt: '',
          status: 'active',
          visibility: 'creator_admin',
          executionEnvironment: 'local',
          executionMode: 'auto',
          executionDeviceId: null,
          createdByUserId: 1,
          version: 1,
          createdAt: '2026-07-22T00:00:00Z',
          updatedAt: '2026-07-22T00:00:00Z',
        },
      ]),
      create: vi.fn(),
      update: vi.fn(),
      archive: vi.fn(),
    }

    render(
      <CloudTodoWorkspace
        user={{ id: 1, user_name: 'local', email: 'local@example.com' } as User}
        localProjects={[]}
        services={cloudServices}
      />
    )

    await userEvent.click((await screen.findAllByText('Wegent V4'))[0])

    const assignee = await screen.findByTestId('cloud-todo-card-assignee-WEG-1')
    expect(assignee).toHaveTextContent('发布机器人')
    expect(assignee.querySelector('svg')).not.toBeNull()
    expect(screen.getByTestId('cloud-todo-card-WEG-1')).not.toHaveTextContent('未指定')
    expect(screen.getByTestId('cloud-todo-card-WEG-1')).toHaveTextContent('发布机器人')
    expect(cloudServices.localProjectChatAgentApi!.list).toHaveBeenCalledWith(project.id)
  })

  it('keeps robot-assigned tasks out of the unassigned assignee group', async () => {
    const workbenchServices = services()
    workbenchServices.deliveryApi!.listLoopItems = vi.fn(async () => ({
      items: [
        {
          ...item,
          assignee_user_id: null,
          assignee_agent_id: 'agent-1',
          assignee_agent_name: '发布机器人',
        },
        {
          ...item,
          id: 'WEG-2',
          sequence_number: 2,
          title: '无人负责的任务',
          assignee_user_id: null,
        },
      ],
    }))

    render(
      <CloudTodoWorkspace
        user={{ id: 1, user_name: 'local', email: 'local@example.com' } as User}
        localProjects={[]}
        services={workbenchServices}
      />
    )

    await userEvent.click((await screen.findAllByText('Wegent V4'))[0])
    await userEvent.click(screen.getByTestId('cloud-board-group-by'))
    await userEvent.click(screen.getByTestId('cloud-board-group-option-assignee'))

    expect(screen.getByTestId('cloud-todo-column-assignee-agent-agent-1')).toHaveTextContent(
      'Implement cloud MCP'
    )
    expect(screen.getByTestId('cloud-todo-column-assignee-unassigned')).toHaveTextContent(
      '无人负责的任务'
    )
    expect(screen.getByTestId('cloud-todo-column-assignee-unassigned')).not.toHaveTextContent(
      'Implement cloud MCP'
    )
  })

  it('renders DingTalk records by live table fields without exposing provider record ids', async () => {
    const workbenchServices = services()
    workbenchServices.aitableApi = {
      configureProject: vi.fn(async () => undefined),
      describe: vi.fn(async () => ({
        base: {},
        tables: [],
        active_table: {},
        fields: [
          { id: 'field-status', name: '天河状态', type: 'singleSelect', config: null, raw: {} },
          { id: 'field-owner', name: '负责人', type: 'member', config: {}, raw: {} },
        ],
      })),
    } as WorkbenchServices['aitableApi']
    workbenchServices.deliveryApi!.listCloudProjects = vi.fn(async () => ({
      items: [
        {
          ...project,
          task_provider: 'dingtalk_aitable' as const,
          provider_config: { base_id: 'base-1', table_id: 'table-1' },
        },
      ],
    }))
    workbenchServices.deliveryApi!.listLoopItems = vi.fn(async () => ({
      items: [
        {
          ...item,
          id: 'aitable:base-1:record-1',
          title: '修复发布流程',
          assignee_name: '陈波',
          source_cells: { 'field-status': '进行中', 'field-owner': [{ name: '陈波' }] },
          tags: [],
        },
        {
          ...item,
          id: 'aitable:base-1:record-2',
          parent_id: 'aitable:base-1:record-1',
          title: '补齐测试',
          assignee_name: '胡春林',
          source_cells: { 'field-status': '待处理', 'field-owner': [{ name: '胡春林' }] },
          tags: [],
        },
      ],
    }))

    render(
      <CloudTodoWorkspace
        user={{ id: 1, user_name: 'local', email: 'local@example.com' } as User}
        localProjects={[]}
        services={workbenchServices}
      />
    )

    await userEvent.click((await screen.findAllByText('Wegent V4'))[0])

    expect(
      await screen.findByTestId('cloud-todo-column-field-field-status-进行中')
    ).toBeInTheDocument()
    expect(screen.getByTestId('cloud-todo-column-field-field-status-待处理')).toBeInTheDocument()
    expect(screen.queryByText('aitable:base-1:record-1')).not.toBeInTheDocument()
    expect(screen.getByText('修复发布流程')).toBeInTheDocument()
    expect(screen.queryByText('补齐测试')).not.toBeInTheDocument()
    expect(screen.queryByTestId('cloud-todo-card-aitable:base-1:record-2')).not.toBeInTheDocument()
    expect(screen.getByTestId('dingtalk-board-group-by')).toHaveTextContent('天河状态')
    expect(screen.getByTestId('dingtalk-board-assignee-filter').parentElement).toHaveTextContent(
      '全部天河状态'
    )

    await userEvent.click(screen.getByTestId('dingtalk-board-group-by'))
    await userEvent.type(screen.getByTestId('dingtalk-board-group-search'), '负责人')
    expect(screen.queryByTestId('dingtalk-board-group-option-field-status')).not.toBeInTheDocument()
    await userEvent.click(screen.getByTestId('dingtalk-board-group-option-field-owner'))
    expect(
      await screen.findByTestId('cloud-todo-column-field-field-owner-陈波')
    ).toBeInTheDocument()
  })

  it('keeps projects visible when one project issue provider fails', async () => {
    const workbenchServices = services()
    workbenchServices.deliveryApi!.listLoopItems = vi.fn(async () => {
      throw new Error('not_found: task not found')
    })

    render(
      <CloudTodoWorkspace
        user={{ id: 1, user_name: 'local', email: 'local@example.com' } as User}
        localProjects={[]}
        services={workbenchServices}
      />
    )

    expect((await screen.findAllByText('Wegent V4')).length).toBeGreaterThan(0)
    expect(screen.queryByText('创建第一个项目空间')).not.toBeInTheDocument()
  })

  it('renders an empty board after a successful zero-item response', async () => {
    const workbenchServices = services()
    workbenchServices.deliveryApi!.listLoopItems = vi.fn(async () => ({ items: [] }))

    render(
      <CloudTodoWorkspace
        user={{ id: 1, user_name: 'local', email: 'local@example.com' } as User}
        localProjects={[]}
        services={workbenchServices}
      />
    )

    await userEvent.click((await screen.findAllByText('Wegent V4'))[0])
    await waitFor(() => {
      expect(workbenchServices.deliveryApi!.listLoopItems).toHaveBeenCalledWith(project.id)
    })
    await waitFor(() => {
      expect(screen.queryByTestId('cloud-todo-board-loading')).not.toBeInTheDocument()
    })
    expect(screen.getByText('Issue')).toBeInTheDocument()
    expect(screen.getByText('0 个 Issue')).toBeInTheDocument()
    expect(screen.getByTestId('cloud-board-quick-start')).toBeVisible()
    expect(screen.getByTestId('cloud-board-quick-start-create-action')).toBeEnabled()
    expect(screen.getByTestId('cloud-todo-column-empty-add-inbox')).toHaveTextContent(
      '创建第一个 Issue'
    )
    expect(screen.getByTestId('cloud-todo-column-empty-add-inbox')).toHaveTextContent(
      '先记录一个需要推进的问题、目标或交付。'
    )
  })

  it('clears the previous project items and shows a skeleton while switching projects', async () => {
    const otherProject = {
      ...project,
      id: 12,
      project_key: 'OTHER',
      name: 'Other Project',
    }
    const otherItem = {
      ...item,
      id: 'OTHER-1',
      cloud_project_id: 12,
      title: 'Other project task',
    }
    let resolveBoardFetch: (() => void) | undefined
    const workbenchServices = services()
    workbenchServices.deliveryApi!.listCloudProjects = vi.fn(async () => ({
      items: [project, otherProject],
    }))
    const selectedProjectIds = new Set<number>()
    workbenchServices.deliveryApi!.listLoopItems = vi.fn(async (projectId: number) => {
      // Project lists no longer preload board details. Keep each project's first
      // explicit detail fetch pending so the switching skeleton can be asserted.
      if (!selectedProjectIds.has(projectId)) {
        selectedProjectIds.add(projectId)
        await new Promise<void>(resolve => {
          resolveBoardFetch = () => resolve()
        })
      }
      return { items: projectId === 12 ? [otherItem] : [item] }
    })
    render(
      <CloudTodoWorkspace
        user={{ id: 1, user_name: 'local', email: 'local@example.com' } as User}
        localProjects={[]}
        services={workbenchServices}
      />
    )

    await userEvent.click((await screen.findAllByText('Wegent V4'))[0])
    await waitFor(() => expect(screen.getByTestId('cloud-todo-board-loading')).toBeInTheDocument())
    expect(screen.queryByTestId('cloud-todo-card-WEG-1')).not.toBeInTheDocument()
    resolveBoardFetch?.()
    expect(await screen.findByTestId('cloud-todo-card-WEG-1')).toBeInTheDocument()
    expect(screen.queryByTestId('cloud-todo-board-loading')).not.toBeInTheDocument()

    await userEvent.click(screen.getAllByText('Other Project')[0])

    // The previous project's cards disappear immediately and the skeleton
    // stays until the new project's items resolve.
    expect(screen.queryByTestId('cloud-todo-card-WEG-1')).not.toBeInTheDocument()
    expect(screen.getByTestId('cloud-todo-board-loading')).toBeInTheDocument()

    resolveBoardFetch?.()
    expect(await screen.findByTestId('cloud-todo-card-OTHER-1')).toBeInTheDocument()
    expect(screen.queryByTestId('cloud-todo-board-loading')).not.toBeInTheDocument()
  })

  it('keeps child items out of the board instead of exposing a nested task list', async () => {
    const workbenchServices = services()
    const child = {
      ...item,
      id: 'WEG-2',
      sequence_number: 2,
      parent_id: item.id,
      title: 'Frontend',
    }
    const grandchild = {
      ...item,
      id: 'WEG-3',
      sequence_number: 3,
      parent_id: child.id,
      title: 'Login page',
    }
    workbenchServices.deliveryApi!.listLoopItems = vi.fn(async () => ({
      items: [item, child, grandchild],
    }))
    render(
      <CloudTodoWorkspace
        user={{ id: 1, user_name: 'local', email: 'local@example.com' } as User}
        localProjects={[]}
        services={workbenchServices}
      />
    )

    await userEvent.click((await screen.findAllByText('Wegent V4'))[0])
    await userEvent.click(await screen.findByTestId('cloud-project-board-view'))
    expect(await screen.findByTestId('cloud-todo-card-WEG-1')).toBeInTheDocument()
    expect(screen.queryByTestId('cloud-todo-card-WEG-2')).not.toBeInTheDocument()
    expect(screen.queryByTestId('cloud-todo-card-WEG-3')).not.toBeInTheDocument()
    expect(screen.queryByTestId('cloud-todo-open-children-WEG-1')).not.toBeInTheDocument()
  })

  it('does not offer child-task creation from a board card', async () => {
    const workbenchServices = services()
    render(
      <CloudTodoWorkspace
        user={{ id: 1, user_name: 'local', email: 'local@example.com' } as User}
        localProjects={[]}
        services={workbenchServices}
      />
    )

    await userEvent.click((await screen.findAllByText('Wegent V4'))[0])
    await userEvent.click(await screen.findByTestId('cloud-project-board-view'))
    expect(await screen.findByTestId('cloud-todo-card-WEG-1')).toBeInTheDocument()
    expect(screen.queryByTestId('cloud-todo-card-add-child-WEG-1')).not.toBeInTheDocument()
  })

  it('associates an existing task with a parent from the edit dialog', async () => {
    const workbenchServices = services()
    const parent = {
      ...item,
      id: 'WEG-2',
      sequence_number: 2,
      title: 'Release',
      parent_id: null,
    }
    workbenchServices.deliveryApi!.listLoopItems = vi.fn(async () => ({ items: [item, parent] }))
    render(
      <CloudTodoWorkspace
        user={{ id: 1, user_name: 'local', email: 'local@example.com' } as User}
        localProjects={[]}
        services={workbenchServices}
      />
    )

    await userEvent.click((await screen.findAllByText('Wegent V4'))[0])
    await userEvent.click(await screen.findByTestId('cloud-todo-card-WEG-1'))
    await userEvent.selectOptions(screen.getByTestId('cloud-todo-detail-parent'), 'WEG-2')
    await userEvent.click(screen.getByTestId('cloud-todo-save'))

    await waitFor(() =>
      expect(workbenchServices.deliveryApi?.updateLoopItem).toHaveBeenCalledWith('WEG-1', {
        version: 1,
        title: item.title,
        description: item.description,
        priority: item.priority,
        status: item.status,
        parent_id: 'WEG-2',
        due_at: null,
        tags: [],
      })
    )
  })

  it('uses cloud projects as the primary navigation and opens a TODO detail', async () => {
    render(
      <CloudTodoWorkspace
        user={{ id: 1, user_name: 'local', email: 'local@example.com' } as User}
        localProjects={[]}
        services={services()}
      />
    )

    expect(screen.getByTestId('cloud-todo-workspace')).toHaveClass('absolute', 'inset-0', 'w-full')
    expect(screen.getByTestId('cloud-todo-workspace').querySelector('aside')).toHaveClass(
      'w-[240px]',
      'bg-[rgb(var(--color-sidebar))]'
    )
    expect(screen.queryByTestId('cloud-todo-app-current')).not.toBeInTheDocument()
    expect(screen.getByTestId('cloud-todo-sidebar-chrome-controls')).toBeInTheDocument()
    expect(screen.getByTestId('cloud-todo-sidebar-chrome-controls')).toContainElement(
      screen.getByTestId('cloud-todo-collapse-sidebar')
    )
    expect(screen.getByTestId('cloud-todo-sidebar-chrome-controls')).toContainElement(
      screen.getByTestId('cloud-search-toggle')
    )
    expect(screen.getAllByTestId('macos-titlebar-drag-region')).toHaveLength(1)
    expect((await screen.findAllByText('项目空间')).length).toBeGreaterThan(0)
    expect(screen.getByText('我的工作').closest('button')).toHaveClass(
      'h-[30px]',
      'px-2',
      'text-base'
    )
    await waitFor(() => expect(screen.getAllByText('Wegent V4').length).toBeGreaterThan(0))
    await userEvent.click(screen.getAllByText('Wegent V4')[0])
    const projectHeader = screen.getByTestId('cloud-project-header')
    expect(projectHeader).toHaveClass('h-[52px]', 'shrink-0')
    expect(projectHeader.querySelector('.electron-titlebar-drag-region')).toBeInTheDocument()
    expect(screen.getAllByTestId('macos-titlebar-drag-region')).toHaveLength(1)
    expect(screen.getByTestId('cloud-project-board-view').closest('nav')).toHaveClass(
      'electron-titlebar-interactive-region'
    )
    expect(screen.getByTestId('cloud-project-ask-ai')).toHaveClass(
      'electron-titlebar-interactive-region'
    )
    expect(screen.getByTestId('cloud-project-task-search-toggle')).toHaveClass(
      'electron-titlebar-interactive-region'
    )
    expect(screen.getByTestId('cloud-todo-add')).toHaveClass('electron-titlebar-interactive-region')
    await userEvent.click(await screen.findByTestId('cloud-todo-card-WEG-1'))

    expect(await screen.findByText('任务详情')).toBeInTheDocument()
    expect(screen.getAllByText('Implement cloud MCP').length).toBeGreaterThan(0)
    expect(screen.getAllByText('Implement cloud delivery').length).toBeGreaterThan(0)
    expect(screen.getAllByText('local').length).toBeGreaterThan(0)
    expect(screen.getByText('参与者')).toBeInTheDocument()
    expect(screen.getByTestId('cloud-todo-add-collaborator')).toBeInTheDocument()
  })

  it('hides the board card activity shortcut and shows activity inside task detail', async () => {
    render(
      <CloudTodoWorkspace
        user={{ id: 1, user_name: 'local', email: 'local@example.com' } as User}
        localProjects={[]}
        services={services()}
      />
    )

    await userEvent.click((await screen.findAllByText('Wegent V4'))[0])
    expect(screen.queryByTestId('cloud-todo-card-activity-WEG-1')).not.toBeInTheDocument()
    await userEvent.click(await screen.findByTestId('cloud-todo-card-WEG-1'))

    expect(await screen.findByTestId('cloud-todo-detail')).toBeInTheDocument()
    expect(screen.queryByTestId('cloud-task-thread-panel')).not.toBeInTheDocument()
  })

  it('copies the cloud project ID before or after opening the project', async () => {
    const writeText = vi.fn(async () => undefined)
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    })

    render(
      <CloudTodoWorkspace
        user={{ id: 1, user_name: 'local', email: 'local@example.com' } as User}
        localProjects={[]}
        services={services()}
      />
    )

    await userEvent.click(await screen.findByTestId('cloud-project-copy-id-11'))
    expect(writeText).toHaveBeenLastCalledWith('11')

    await userEvent.click(screen.getByTestId('cloud-sidebar-project-11'))
    await userEvent.click(screen.getByTestId('cloud-sidebar-project-more-11'))
    expect(screen.getByTestId('cloud-sidebar-project-menu-11')).toBeInTheDocument()
    await userEvent.click(screen.getByTestId('cloud-project-header'))
    expect(screen.queryByTestId('cloud-sidebar-project-menu-11')).not.toBeInTheDocument()

    await userEvent.click(screen.getByTestId('cloud-sidebar-project-more-11'))
    await userEvent.click(screen.getByTestId('cloud-sidebar-copy-project-id-11'))

    expect(writeText).toHaveBeenLastCalledWith('11')
    expect(screen.queryByTestId('cloud-sidebar-project-menu-11')).not.toBeInTheDocument()
  })

  it('manually adds a project member as a TODO collaborator', async () => {
    const workbenchServices = services()
    render(
      <CloudTodoWorkspace
        user={{ id: 1, user_name: 'local', email: 'local@example.com' } as User}
        localProjects={[]}
        services={workbenchServices}
      />
    )

    await userEvent.click((await screen.findAllByText('Wegent V4'))[0])
    await userEvent.click(await screen.findByTestId('cloud-todo-card-WEG-1'))
    expect((await screen.findAllByText(/参与者/)).length).toBeGreaterThan(0)
    await userEvent.click(screen.getByTestId('cloud-todo-add-collaborator'))
    await userEvent.selectOptions(screen.getByTestId('cloud-todo-collaborator-select'), '2')
    await userEvent.click(screen.getByTestId('cloud-todo-confirm-collaborator'))

    await waitFor(() =>
      expect(workbenchServices.deliveryApi?.addLoopItemCollaborator).toHaveBeenCalledWith(
        'WEG-1',
        2
      )
    )
    expect((await screen.findAllByText('alice')).length).toBeGreaterThan(0)
  })

  it('shows child tasks in the unified execution task list without a duplicate child section', async () => {
    const child = {
      ...item,
      id: 'WEG-2',
      sequence_number: 2,
      parent_id: item.id,
      title: '实现快速排序',
      status: 'pending' as const,
      assignee_agent_id: 'agent-1',
      assignee_agent_name: '开发机器人',
    }
    const workbenchServices = services()
    workbenchServices.deliveryApi!.listLoopItems = vi.fn(async () => ({
      items: [item, child],
    }))
    workbenchServices.deliveryApi!.listTaskBindings = vi.fn(async () => [])

    render(
      <CloudTodoWorkspace
        user={{ id: 1, user_name: 'local', email: 'local@example.com' } as User}
        localProjects={[]}
        services={workbenchServices}
      />
    )

    await userEvent.click((await screen.findAllByText('Wegent V4'))[0])
    await userEvent.click(await screen.findByTestId('cloud-todo-card-WEG-1'))
    expect(await screen.findByTestId('cloud-todo-detail')).toBeInTheDocument()
    expect(screen.queryByTestId('cloud-todo-detail-add-child')).not.toBeInTheDocument()
    expect(screen.queryByTestId('cloud-todo-children')).not.toBeInTheDocument()
    expect(screen.getByTestId('cloud-todo-tasks')).toHaveTextContent('执行任务')
    expect(screen.getByTestId('cloud-todo-execution-task-count')).toHaveTextContent('1')
    expect(screen.getByTestId('cloud-todo-open-child-task-WEG-2')).toHaveTextContent('实现快速排序')
    expect(screen.getByTestId('cloud-todo-open-child-task-WEG-2')).toHaveTextContent('开发机器人')

    await userEvent.click(screen.getByTestId('cloud-todo-open-child-task-WEG-2'))
    expect(screen.getByTestId('cloud-todo-detail-title')).toHaveValue('实现快速排序')
  })

  it('offers replanning when the AI manager finishes without a submitted plan', async () => {
    const managedItem = {
      ...item,
      workflow: {
        version: 1,
        definition_version: 1,
        stage_mode: 'none' as const,
        advancement_policy: 'ai' as const,
        approval_policy: 'required' as const,
        ai_automation_rule_id: 'manager-rule',
        orchestration_status: 'planning' as const,
        active_run_id: 'workflow-run-1',
        active_plan_version: 1,
        current_stage_id: null,
        nodes: [],
      },
    }
    const failedPlan = {
      run_id: 'workflow-run-1',
      issue_id: managedItem.id,
      stage_id: '__issue__',
      plan_version: 1,
      approval_policy: 'required' as const,
      status: 'planning' as const,
      summary: '',
      items: [],
      manager_run: {
        id: 'manager-run-1',
        status: 'succeeded',
        model: 'gpt-5-codex',
        execution_environment: 'cloud',
        device_id: 'cloud-device',
        recent_activity: '方案生成完成',
        error: null,
        updated_at: '2026-08-20T11:47:00Z',
      },
    }
    const replanning = {
      ...failedPlan,
      status: 'planning' as const,
      summary: '',
      items: [],
      manager_run: null,
    }
    const workbenchServices = services()
    workbenchServices.deliveryApi!.listLoopItems = vi.fn(async () => ({
      items: [managedItem],
    }))
    workbenchServices.deliveryApi!.getLoopItem = vi.fn(async () => managedItem)
    workbenchServices.deliveryApi!.listTaskBindings = vi.fn(async () => [])
    workbenchServices.deliveryApi!.getWorkflowPlan = vi.fn(async () => failedPlan)
    workbenchServices.deliveryApi!.replanWorkflowPlan = vi.fn(async () => replanning)

    render(
      <CloudTodoWorkspace
        user={{ id: 1, user_name: 'local', email: 'local@example.com' } as User}
        localProjects={[]}
        services={workbenchServices}
      />
    )

    await userEvent.click((await screen.findAllByText('Wegent V4'))[0])
    await userEvent.click(await screen.findByTestId('cloud-todo-card-WEG-1'))

    expect(await screen.findByTestId('cloud-todo-workflow-plan-status')).toHaveTextContent(
      '生成方案失败'
    )
    expect(screen.queryByTestId('cloud-todo-workflow-approve')).not.toBeInTheDocument()
    expect(screen.getByTestId('cloud-todo-workflow-replan')).toHaveTextContent('重新生成')
  })

  it('disables a workflow action when its API method is unavailable', async () => {
    const managedItem = {
      ...item,
      workflow: {
        version: 1,
        definition_version: 1,
        stage_mode: 'none' as const,
        advancement_policy: 'ai' as const,
        approval_policy: 'required' as const,
        ai_automation_rule_id: 'manager-rule',
        orchestration_status: 'awaiting_approval' as const,
        active_run_id: 'workflow-run-1',
        active_plan_version: 1,
        current_stage_id: null,
        nodes: [],
      },
    }
    const plan = {
      run_id: 'workflow-run-1',
      issue_id: managedItem.id,
      stage_id: '__issue__',
      plan_version: 1,
      approval_policy: 'required' as const,
      status: 'awaiting_approval' as const,
      summary: '等待确认',
      items: [],
      manager_run: null,
    }
    const workbenchServices = services()
    workbenchServices.deliveryApi!.listLoopItems = vi.fn(async () => ({
      items: [managedItem],
    }))
    workbenchServices.deliveryApi!.getLoopItem = vi.fn(async () => managedItem)
    workbenchServices.deliveryApi!.listTaskBindings = vi.fn(async () => [])
    workbenchServices.deliveryApi!.getWorkflowPlan = vi.fn(async () => plan)
    workbenchServices.deliveryApi!.replanWorkflowPlan = vi.fn(async () => plan)
    ;(
      workbenchServices.deliveryApi as unknown as {
        approveWorkflowPlan?: unknown
      }
    ).approveWorkflowPlan = undefined

    render(
      <CloudTodoWorkspace
        user={{ id: 1, user_name: 'local', email: 'local@example.com' } as User}
        localProjects={[]}
        services={workbenchServices}
      />
    )

    await userEvent.click((await screen.findAllByText('Wegent V4'))[0])
    await userEvent.click(await screen.findByTestId('cloud-todo-card-WEG-1'))

    expect(await screen.findByTestId('cloud-todo-workflow-approve')).toBeDisabled()
    expect(screen.getByTestId('cloud-todo-workflow-replan')).toBeEnabled()
  })

  it('reviews all AI child tasks once and keeps them visible after completion', async () => {
    const managedItem = {
      ...item,
      status: 'in_review' as const,
      workflow: {
        version: 1,
        definition_version: 1,
        stage_mode: 'none' as const,
        advancement_policy: 'ai' as const,
        approval_policy: 'required' as const,
        ai_automation_rule_id: 'manager-rule',
        orchestration_status: 'awaiting_review' as const,
        active_run_id: 'workflow-run-1',
        active_plan_version: 1,
        current_stage_id: null,
        nodes: [],
      },
    }
    const child = {
      ...item,
      id: 'WEG-2',
      sequence_number: 2,
      parent_id: managedItem.id,
      title: '实现快速排序',
      status: 'in_review' as const,
      assignee_agent_id: 'agent-1',
      assignee_agent_name: '开发机器人',
    }
    const plan = {
      run_id: 'workflow-run-1',
      issue_id: managedItem.id,
      stage_id: '__issue__',
      plan_version: 1,
      approval_policy: 'required' as const,
      status: 'awaiting_review' as const,
      summary: '实现并验证快速排序',
      items: [
        {
          id: 'plan-item-1',
          client_key: 'implement',
          stage_id: '__issue__',
          title: child.title,
          description: '实现并验证',
          assignee_type: 'agent' as const,
          assignee_id: 'agent-1',
          assignee_name: '开发机器人',
          rationale: '适合开发任务',
          task_id: child.id,
          task_status: child.status,
          outcome_verdict: 'passed' as const,
          outcome_summary: '实现和测试均已通过',
          status: 'materialized' as const,
        },
      ],
    }
    const completedPlan = {
      ...plan,
      status: 'completed' as const,
    }
    const workbenchServices = services()
    workbenchServices.deliveryApi!.listLoopItems = vi.fn(async () => ({
      items: [managedItem, child],
    }))
    workbenchServices.deliveryApi!.getLoopItem = vi.fn(async () => managedItem)
    workbenchServices.deliveryApi!.listTaskBindings = vi.fn(async () => [])
    workbenchServices.deliveryApi!.getWorkflowPlan = vi
      .fn()
      .mockResolvedValueOnce(plan)
      .mockResolvedValue(completedPlan)
    workbenchServices.deliveryApi!.approveWorkflowReview = vi.fn(async () => completedPlan)

    render(
      <CloudTodoWorkspace
        user={{ id: 1, user_name: 'local', email: 'local@example.com' } as User}
        localProjects={[]}
        services={workbenchServices}
      />
    )

    await userEvent.click((await screen.findAllByText('Wegent V4'))[0])
    await userEvent.click(await screen.findByTestId('cloud-todo-card-WEG-1'))
    expect(await screen.findByTestId('cloud-todo-workflow-plan-status')).toHaveTextContent(
      '等待统一验收'
    )
    expect(screen.getByTestId('cloud-todo-open-child-task-WEG-2')).toBeInTheDocument()
    expect(screen.getByTestId('cloud-todo-workflow-plan-item-plan-item-1')).toHaveTextContent(
      '实现和测试均已通过'
    )
    expect(screen.getByTestId('cloud-todo-open-plan-task-WEG-2')).toHaveTextContent('查看子任务')
    expect(screen.getByTestId('cloud-todo-workflow-plan-status').parentElement).toHaveClass(
      'flex-wrap'
    )
    expect(screen.getByTestId('cloud-todo-workflow-plan-status')).toHaveClass('whitespace-nowrap')
    expect(screen.getByTestId('cloud-todo-workflow-review').parentElement).toHaveClass(
      'shrink-0',
      'whitespace-nowrap'
    )

    await userEvent.click(screen.getByTestId('cloud-todo-workflow-review'))

    await waitFor(() =>
      expect(workbenchServices.deliveryApi?.approveWorkflowReview).toHaveBeenCalledWith('WEG-1')
    )
    await waitFor(() =>
      expect(screen.getByTestId('cloud-todo-workflow-plan-status')).toHaveTextContent('已完成')
    )
    expect(screen.queryByTestId('cloud-todo-workflow-review')).not.toBeInTheDocument()
    expect(screen.getByTestId('cloud-todo-workflow-rerun')).toBeInTheDocument()
    expect(screen.getByTestId('cloud-todo-open-child-task-WEG-2')).toBeInTheDocument()
    expect(screen.getByTestId('cloud-todo-workflow-plan-item-plan-item-1')).toBeInTheDocument()
  })

  it('adds an attachment from the TODO edit dialog', async () => {
    const workbenchServices = services()
    render(
      <CloudTodoWorkspace
        user={{ id: 1, user_name: 'local', email: 'local@example.com' } as User}
        localProjects={[]}
        services={workbenchServices}
      />
    )

    await userEvent.click((await screen.findAllByText('Wegent V4'))[0])
    await userEvent.click(await screen.findByTestId('cloud-todo-card-WEG-1'))
    const file = new File(['context'], 'brief.txt', { type: 'text/plain' })
    await userEvent.upload(screen.getByTestId('cloud-todo-attachment-input'), file)

    await waitFor(() =>
      expect(workbenchServices.deliveryApi?.addLoopItemAttachment).toHaveBeenCalledWith(
        'WEG-1',
        file
      )
    )
    expect(screen.getByText('brief.txt')).toBeInTheDocument()
    expect(screen.getByTestId('cloud-todo-attachment-footer')).toHaveTextContent('附件1＋ 上传')
  })

  it('shows existing Issue attachments in the detail panel', async () => {
    const workbenchServices = services()
    workbenchServices.deliveryApi!.listLoopItemAttachments = vi.fn(async () => [
      {
        id: 'attachment-existing',
        loop_item_id: item.id,
        display_name: 'feedback.png',
        content_type: 'image/png',
        size_bytes: 2048,
        sha256: 'existing-hash',
        created_by_user_id: 1,
        created_at: '2026-08-26T00:00:00Z',
        markdown_url: 'wegent://attachments/attachment-existing',
        markdown:
          '[feedback.png](wegent://attachments/attachment-existing)\n<!-- wegent-attachment:attachment-existing -->',
      },
    ])

    render(
      <CloudTodoWorkspace
        user={{ id: 1, user_name: 'local', email: 'local@example.com' } as User}
        localProjects={[]}
        services={workbenchServices}
      />
    )

    await userEvent.click((await screen.findAllByText('Wegent V4'))[0])
    await userEvent.click(await screen.findByTestId('cloud-todo-card-WEG-1'))

    expect(await screen.findByText('feedback.png')).toBeInTheDocument()
    expect(
      screen.getByTestId('cloud-todo-attachment-download-attachment-existing')
    ).toBeInTheDocument()

    await userEvent.click(screen.getByTestId('cloud-todo-attachment-download-attachment-existing'))

    expect(workbenchServices.deliveryApi?.downloadLoopItemAttachment).toHaveBeenCalledWith(
      'attachment-existing',
      'feedback.png'
    )
  })

  it('shows attachment download failures and allows another attempt', async () => {
    const workbenchServices = services()
    workbenchServices.deliveryApi!.listLoopItemAttachments = vi.fn(async () => [
      {
        id: 'attachment-existing',
        loop_item_id: item.id,
        display_name: 'feedback.png',
        content_type: 'image/png',
        size_bytes: 2048,
        sha256: 'existing-hash',
        created_by_user_id: 1,
        created_at: '2026-08-26T00:00:00Z',
        markdown_url: 'wegent://attachments/attachment-existing',
        markdown:
          '[feedback.png](wegent://attachments/attachment-existing)\n<!-- wegent-attachment:attachment-existing -->',
      },
    ])
    workbenchServices.deliveryApi!.downloadLoopItemAttachment = vi
      .fn()
      .mockRejectedValueOnce(new Error('下载服务不可用'))
      .mockResolvedValueOnce(undefined)

    render(
      <CloudTodoWorkspace
        user={{ id: 1, user_name: 'local', email: 'local@example.com' } as User}
        localProjects={[]}
        services={workbenchServices}
      />
    )

    await userEvent.click((await screen.findAllByText('Wegent V4'))[0])
    await userEvent.click(await screen.findByTestId('cloud-todo-card-WEG-1'))
    const download = await screen.findByTestId('cloud-todo-attachment-download-attachment-existing')

    await userEvent.click(download)
    expect(await screen.findByRole('alert')).toHaveTextContent('下载服务不可用')

    await userEvent.click(download)
    await waitFor(() =>
      expect(workbenchServices.deliveryApi?.downloadLoopItemAttachment).toHaveBeenCalledTimes(2)
    )
  })

  it('collapses and restores the sidebar chrome', async () => {
    render(
      <CloudTodoWorkspace
        user={{ id: 1, user_name: 'local', email: 'local@example.com' } as User}
        localProjects={[]}
        services={services()}
      />
    )

    expect(screen.getByTestId('cloud-todo-sidebar-chrome-controls')).toHaveClass('gap-1')
    await userEvent.click(screen.getByTestId('cloud-todo-collapse-sidebar'))
    expect(screen.queryByTestId('cloud-todo-collapsed-app-current')).not.toBeInTheDocument()
    expect(screen.getByTestId('cloud-todo-collapsed-chrome-controls')).toHaveClass('left-2')

    await userEvent.click(screen.getByTestId('cloud-todo-expand-sidebar'))
    expect(screen.queryByTestId('cloud-todo-collapsed-chrome-controls')).not.toBeInTheDocument()
    expect(screen.getByTestId('cloud-todo-sidebar-chrome-controls')).toBeInTheDocument()
  })

  it('opens the cloud project creation flow', async () => {
    render(
      <CloudTodoWorkspace
        user={{ id: 1, user_name: 'local', email: 'local@example.com' } as User}
        localProjects={[]}
        services={services()}
      />
    )
    await waitFor(() => expect(screen.getByTestId('cloud-project-add')).toBeInTheDocument())
    await userEvent.click(screen.getByTestId('cloud-project-add'))
    expect(screen.getByTestId('cloud-project-name')).toBeInTheDocument()
    expect(screen.getByTestId('cloud-project-location-cloud')).toHaveAttribute(
      'aria-pressed',
      'true'
    )
    expect(screen.getByTestId('cloud-project-task-provider-local')).toBeInTheDocument()
    expect(screen.getByTestId('cloud-project-task-provider-github')).toBeInTheDocument()
    expect(screen.getByTestId('cloud-project-task-provider-gitlab')).toBeInTheDocument()
    expect(screen.queryByTestId('cloud-project-key')).not.toBeInTheDocument()
  })

  it('creates a project space without requesting a project key', async () => {
    const workbenchServices = services()
    const onActiveProjectChange = vi.fn()
    render(
      <CloudTodoWorkspace
        user={{ id: 1, user_name: 'local', email: 'local@example.com' } as User}
        localProjects={[]}
        services={workbenchServices}
        activeProjectRef={null}
        onActiveProjectChange={onActiveProjectChange}
      />
    )

    await userEvent.click(await screen.findByTestId('cloud-project-add'))
    await userEvent.type(screen.getByTestId('cloud-project-name'), 'Wegent Test')
    await userEvent.click(screen.getByTestId('cloud-project-create-confirm'))

    await waitFor(() =>
      expect(workbenchServices.deliveryApi?.createCloudProject).toHaveBeenCalledWith({
        name: 'Wegent Test',
        description: '',
        task_provider: 'local',
        provider_config: {},
        visibility: 'private',
      })
    )
    expect(onActiveProjectChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ id: 12, name: 'Wegent Test', location: 'cloud' })
    )
    expect(screen.queryByTestId('cloud-project-name')).not.toBeInTheDocument()
  })

  it('requires only a project-space name before creating', async () => {
    const workbenchServices = services()
    render(
      <CloudTodoWorkspace
        user={{ id: 1, user_name: 'local', email: 'local@example.com' } as User}
        localProjects={[]}
        services={workbenchServices}
      />
    )

    await userEvent.click(await screen.findByTestId('cloud-project-add'))
    expect(screen.getByTestId('cloud-project-create-confirm')).toBeDisabled()
    await userEvent.type(screen.getByTestId('cloud-project-name'), '中文项目空间')
    expect(screen.getByTestId('cloud-project-create-confirm')).toBeEnabled()
    expect(workbenchServices.deliveryApi?.createCloudProject).not.toHaveBeenCalled()
  })

  it('configures an encrypted GitHub provider for a local project', async () => {
    const workbenchServices = services()
    workbenchServices.projectSpaceApis = {
      local: workbenchServices.deliveryApi,
      defaultLocation: 'local',
    }
    render(
      <CloudTodoWorkspace
        user={{ id: 1, user_name: 'local', email: 'local@example.com' } as User}
        localProjects={[]}
        services={workbenchServices}
      />
    )

    await userEvent.click(await screen.findByTestId('cloud-project-add'))
    await userEvent.type(screen.getByTestId('cloud-project-name'), 'GitHub board')
    await userEvent.click(screen.getByTestId('cloud-project-task-provider-github'))
    await userEvent.type(screen.getByTestId('cloud-project-provider-repository'), 'acme/repo')
    await userEvent.type(screen.getByTestId('cloud-project-provider-token'), 'github-secret')
    await userEvent.click(screen.getByTestId('cloud-project-create-confirm'))

    await waitFor(() =>
      expect(workbenchServices.deliveryApi?.createCloudProject).toHaveBeenCalledWith({
        name: 'GitHub board',
        description: '',
        task_provider: 'github',
        provider_config: {
          repository: 'acme/repo',
          token: 'github-secret',
        },
      })
    )
  })

  it('allows a cloud project to use GitLab Issues', async () => {
    const workbenchServices = services()
    render(
      <CloudTodoWorkspace
        user={{ id: 1, user_name: 'local', email: 'local@example.com' } as User}
        localProjects={[]}
        services={workbenchServices}
      />
    )

    await userEvent.click(await screen.findByTestId('cloud-project-add'))
    expect(screen.getByTestId('cloud-project-location-cloud')).toHaveAttribute(
      'aria-pressed',
      'true'
    )
    await userEvent.type(screen.getByTestId('cloud-project-name'), 'Cloud GitLab board')
    await userEvent.click(screen.getByTestId('cloud-project-task-provider-gitlab'))
    await userEvent.type(screen.getByTestId('cloud-project-provider-repository'), 'group/project')
    await userEvent.click(screen.getByTestId('cloud-project-create-confirm'))

    await waitFor(() =>
      expect(workbenchServices.deliveryApi?.createCloudProject).toHaveBeenCalledWith({
        name: 'Cloud GitLab board',
        description: '',
        task_provider: 'gitlab',
        provider_config: {
          repository: 'group/project',
        },
        visibility: 'private',
      })
    )
  })

  it('creates a cloud DingTalk AI Table project from a shared link', async () => {
    const workbenchServices = services()
    render(
      <CloudTodoWorkspace
        user={{ id: 1, user_name: 'local', email: 'local@example.com' } as User}
        localProjects={[]}
        services={workbenchServices}
      />
    )

    await userEvent.click(await screen.findByTestId('cloud-project-add'))
    await userEvent.type(screen.getByTestId('cloud-project-name'), '钉钉需求池')
    await userEvent.click(screen.getByTestId('cloud-project-task-provider-dingtalk_aitable'))
    expect(screen.getByTestId('cloud-project-create-confirm')).toBeDisabled()
    fireEvent.change(screen.getByTestId('cloud-project-aitable-url'), {
      target: {
        value:
          'https://alidocs.dingtalk.com/i/nodes/pYLaezmVN63PAZGPTPKyr2X3VrMqPxX6?iframeQuery=entrance%3Ddata%26sheetId%3DhERWDMS%26viewId%3DqvGDAH2',
      },
    })
    expect(screen.queryByTestId('cloud-project-aitable-token')).not.toBeInTheDocument()
    await userEvent.click(screen.getByTestId('cloud-project-create-confirm'))

    await waitFor(() =>
      expect(workbenchServices.deliveryApi?.createCloudProject).toHaveBeenCalledWith({
        name: '钉钉需求池',
        description: '',
        task_provider: 'dingtalk_aitable',
        provider_config: {
          base_id: 'pYLaezmVN63PAZGPTPKyr2X3VrMqPxX6',
          table_id: 'hERWDMS',
          source_url:
            'https://alidocs.dingtalk.com/i/nodes/pYLaezmVN63PAZGPTPKyr2X3VrMqPxX6?iframeQuery=entrance%3Ddata%26sheetId%3DhERWDMS%26viewId%3DqvGDAH2',
          view_id: 'qvGDAH2',
        },
        visibility: 'private',
      })
    )
  })

  it('routes an explicitly local project to the local project-space API', async () => {
    const cloudServices = services()
    const localServices = services()
    localServices.deliveryApi!.listCloudProjects = vi.fn(async () => ({ items: [] }))
    cloudServices.projectSpaceApis = {
      local: localServices.deliveryApi,
      cloud: cloudServices.deliveryApi,
      defaultLocation: 'cloud',
    }
    render(
      <CloudTodoWorkspace
        user={{ id: 1, user_name: 'local', email: 'local@example.com' } as User}
        localProjects={[]}
        services={cloudServices}
      />
    )

    await userEvent.click(await screen.findByTestId('cloud-project-add'))
    await userEvent.click(screen.getByTestId('cloud-project-location-local'))
    await userEvent.type(screen.getByTestId('cloud-project-name'), 'Local board')
    await userEvent.click(screen.getByTestId('cloud-project-create-confirm'))

    await waitFor(() =>
      expect(localServices.deliveryApi?.createCloudProject).toHaveBeenCalledWith({
        name: 'Local board',
        description: '',
        task_provider: 'local',
        provider_config: {},
      })
    )
    expect(cloudServices.deliveryApi?.createCloudProject).not.toHaveBeenCalled()
  })

  it('opens project member management and searches tasks without hiding the board', async () => {
    const workbenchServices = services()
    render(
      <CloudTodoWorkspace
        user={{ id: 1, user_name: 'local', email: 'local@example.com' } as User}
        localProjects={[]}
        services={workbenchServices}
      />
    )

    await userEvent.click((await screen.findAllByText('Wegent V4'))[0])
    await userEvent.click(await screen.findByTestId('cloud-project-manage-view'))
    expect(screen.getByText('管理项目')).toBeInTheDocument()
    expect(await screen.findByText('2 位成员')).toBeInTheDocument()
    await userEvent.click(screen.getByTestId('cloud-project-members-toggle'))
    expect(await screen.findByTestId('cloud-project-member-1')).toBeInTheDocument()
    await userEvent.type(
      screen.getByTestId('cloud-project-member-capability-2'),
      '前端实现与交互验收'
    )
    await userEvent.tab()
    await waitFor(() =>
      expect(workbenchServices.deliveryApi?.updateCloudProjectMember).toHaveBeenCalledWith(
        project.id,
        2,
        { capability_description: '前端实现与交互验收' }
      )
    )
    await userEvent.click(screen.getByTestId('cloud-project-board-view'))

    await userEvent.click(screen.getByTestId('cloud-project-task-search-toggle'))
    await userEvent.type(screen.getByTestId('cloud-project-task-search-input'), 'missing')
    expect(screen.getByText('没有匹配的任务')).toBeInTheDocument()
    expect(screen.getByTestId('cloud-todo-card-WEG-1')).toBeInTheDocument()
  })

  it('shows the automation tab for local project spaces', async () => {
    const workbenchServices = services()
    const listCloudProjects = workbenchServices.deliveryApi!.listCloudProjects as ReturnType<
      typeof vi.fn
    >
    listCloudProjects.mockImplementation(async () => ({
      items: [{ ...project, project_store: 'local' as const }],
    }))

    render(
      <CloudTodoWorkspace
        user={{ id: 1, user_name: 'local', email: 'local@example.com' } as User}
        localProjects={[]}
        services={workbenchServices}
      />
    )

    await userEvent.click((await screen.findAllByText('Wegent V4'))[0])
    expect(screen.getByTestId('cloud-project-automation-view')).toBeInTheDocument()
    await userEvent.click(screen.getByTestId('cloud-project-automation-view'))
    expect(await screen.findByTestId('project-automation-view')).toBeInTheDocument()
  })

  it('hides the automation tab for DingTalk AI Table project spaces', async () => {
    const workbenchServices = services()
    const listCloudProjects = workbenchServices.deliveryApi!.listCloudProjects as ReturnType<
      typeof vi.fn
    >
    listCloudProjects.mockImplementation(async () => ({
      items: [{ ...project, task_provider: 'dingtalk_aitable' as const }],
    }))

    render(
      <CloudTodoWorkspace
        user={{ id: 1, user_name: 'local', email: 'local@example.com' } as User}
        localProjects={[]}
        services={workbenchServices}
      />
    )

    await userEvent.click((await screen.findAllByText('Wegent V4'))[0])
    expect(screen.queryByTestId('cloud-project-automation-view')).not.toBeInTheDocument()
    expect(screen.queryByText('自动化')).not.toBeInTheDocument()
  })

  it('opens the global search with Command+K and opens a task result', async () => {
    render(
      <CloudTodoWorkspace
        user={{ id: 1, user_name: 'local', email: 'local@example.com' } as User}
        localProjects={[]}
        services={services()}
      />
    )

    await screen.findAllByText('Wegent V4')
    await userEvent.keyboard('{Meta>}k{/Meta}')
    await userEvent.type(screen.getByTestId('cloud-global-search-input'), 'WEG-1')
    await userEvent.click(await screen.findByTestId('cloud-global-search-result-WEG-1'))

    expect(await screen.findByTestId('cloud-todo-detail')).toBeInTheDocument()
  })

  it('restores a missing cloud GitLab credential from project management', async () => {
    const workbenchServices = services()
    const externalProject = {
      ...project,
      task_provider: 'gitlab' as const,
      provider_config: {
        repository: 'group/project',
        domain: 'gitlab.example.com',
        api_base: 'https://gitlab.example.com/api/v4',
        credential_configured: false,
      },
    }
    workbenchServices.deliveryApi!.listCloudProjects = vi.fn(async () => ({
      items: [externalProject],
    }))
    workbenchServices.deliveryApi!.updateCloudProject = vi.fn(async (_projectId, values) => ({
      ...externalProject,
      provider_config: {
        repository: 'group/project',
        domain: 'gitlab.example.com',
        api_base: 'https://gitlab.example.com/api/v4',
        credential_configured: true,
      },
      version: values.version + 1,
    }))

    render(
      <CloudTodoWorkspace
        user={{ id: 1, user_name: 'local', email: 'local@example.com' } as User}
        localProjects={[]}
        services={workbenchServices}
      />
    )

    await userEvent.click((await screen.findAllByText('Wegent V4'))[0])
    await userEvent.click(await screen.findByTestId('cloud-project-manage-view'))
    expect(screen.getByText('需要配置令牌')).toBeInTheDocument()
    const tagHeading = screen.getByRole('heading', { name: '标签' })
    const providerHeading = screen.getByRole('heading', { name: '任务来源' })
    expect(
      tagHeading.compareDocumentPosition(providerHeading) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy()
    expect(screen.getByTestId('cloud-project-provider-manage-save')).toHaveClass(
      'bg-text-primary',
      'text-background',
      'disabled:bg-text-primary',
      'disabled:text-background'
    )
    await userEvent.click(screen.getByRole('button', { name: '＋ 新建标签' }))
    expect(screen.getByTestId('cloud-project-tag-create-confirm')).toHaveClass(
      'bg-text-primary',
      'text-background',
      'disabled:bg-text-primary',
      'disabled:text-background'
    )
    expect(screen.getByTestId('cloud-project-tag-create-confirm')).not.toHaveClass(
      'disabled:opacity-50'
    )
    await userEvent.type(screen.getByTestId('cloud-project-provider-manage-token'), 'gitlab-secret')
    await userEvent.click(screen.getByTestId('cloud-project-provider-manage-save'))

    await waitFor(() =>
      expect(workbenchServices.deliveryApi!.updateCloudProject).toHaveBeenCalledWith(11, {
        version: 1,
        provider_config: {
          repository: 'group/project',
          domain: 'gitlab.example.com',
          api_base: 'https://gitlab.example.com/api/v4',
          token: 'gitlab-secret',
        },
      })
    )
    expect(await screen.findByText('已保存')).toBeInTheDocument()
  }, 15_000)

  it('updates the DingTalk connection without exposing board mappings', async () => {
    const workbenchServices = services()
    const aitableProject = {
      ...project,
      task_provider: 'dingtalk_aitable' as const,
      provider_config: {
        base_id: 'base-1',
        table_id: 'table-1',
        source_url: 'https://alidocs.dingtalk.com/i/nodes/base-1?iframeQuery=sheetId%3Dtable-1',
        credential_configured: true,
        board_mapping: { title_field_id: 'fld-title' },
      },
    }
    workbenchServices.deliveryApi!.listCloudProjects = vi.fn(async () => ({
      items: [aitableProject],
    }))
    workbenchServices.deliveryApi!.updateCloudProject = vi.fn(async (_projectId, values) => ({
      ...aitableProject,
      provider_config: values.provider_config ?? aitableProject.provider_config,
      version: values.version + 1,
    }))
    workbenchServices.aitableApi = {
      configureProject: vi.fn(async () => undefined),
      describe: vi.fn(async () => ({
        base: {},
        tables: [],
        active_table: {},
        fields: [
          { id: 'fld-title', name: '需求名称', type: 'text', config: {}, raw: {} },
          { id: 'fld-status', name: '状态', type: 'singleSelect', config: {}, raw: {} },
        ],
      })),
      listRecords: vi.fn(async () => ({ items: [], cursor: null, has_more: false })),
      createRecord: vi.fn(),
      updateRecord: vi.fn(),
      deleteRecord: vi.fn(),
      createField: vi.fn(),
      updateField: vi.fn(),
      deleteField: vi.fn(),
    }
    workbenchServices.dwsApi = {
      authStatus: vi.fn(async () => ({
        authenticated: true,
        token_valid: true,
        corp_name: '测试组织',
      })),
      login: vi.fn(() => new Promise<void>(() => undefined)),
      logout: vi.fn(async () => undefined),
    }

    render(
      <CloudTodoWorkspace
        user={{ id: 1, user_name: 'local', email: 'local@example.com' } as User}
        localProjects={[]}
        services={workbenchServices}
      />
    )

    await userEvent.click((await screen.findAllByText('Wegent V4'))[0])
    await userEvent.click(await screen.findByTestId('cloud-project-manage-view'))
    expect(screen.queryByText('看板字段映射')).not.toBeInTheDocument()
    await userEvent.click(screen.getByTestId('aitable-manage-save'))

    expect(screen.queryByTestId('aitable-status-mode-custom')).not.toBeInTheDocument()

    await waitFor(() =>
      expect(workbenchServices.deliveryApi!.updateCloudProject).toHaveBeenCalledWith(11, {
        version: 1,
        provider_config: {
          base_id: 'base-1',
          table_id: 'table-1',
          source_url: 'https://alidocs.dingtalk.com/i/nodes/base-1?iframeQuery=sheetId%3Dtable-1',
        },
      })
    )
    await userEvent.click(screen.getByTestId('aitable-dws-login'))
    expect(workbenchServices.dwsApi.login).toHaveBeenCalledOnce()
    expect(screen.getByTestId('aitable-dws-login')).toHaveTextContent('等待浏览器授权…')
    expect(screen.getByTestId('aitable-dws-login')).toBeDisabled()
  }, 15_000)

  it('shows the DingTalk connect prompt on the board when dws is not authenticated', async () => {
    const workbenchServices = services()
    const aitableProject = {
      ...project,
      task_provider: 'dingtalk_aitable' as const,
      provider_config: {
        base_id: 'base-1',
        table_id: 'table-1',
        credential_configured: true,
      },
    }
    workbenchServices.deliveryApi!.listCloudProjects = vi.fn(async () => ({
      items: [aitableProject],
    }))
    let authCalls = 0
    workbenchServices.dwsApi = {
      authStatus: vi.fn(async () => {
        authCalls += 1
        return authCalls === 1
          ? { authenticated: false, token_valid: false }
          : { authenticated: true, token_valid: true, corp_name: '测试组织' }
      }),
      login: vi.fn(async () => undefined),
      logout: vi.fn(async () => undefined),
    }
    workbenchServices.deliveryApi!.listLoopItems = vi
      .fn()
      .mockRejectedValueOnce(new Error('DWS request failed: resolve access token ...'))
      .mockResolvedValueOnce({ items: [] })

    render(
      <CloudTodoWorkspace
        user={{ id: 1, user_name: 'local', email: 'local@example.com' } as User}
        localProjects={[]}
        services={workbenchServices}
      />
    )

    await userEvent.click(await screen.findByTestId('cloud-sidebar-project-11'))
    const connectButton = await screen.findByTestId('aitable-board-dws-login')
    expect(connectButton).toHaveTextContent('连接钉钉')

    await userEvent.click(connectButton)
    await waitFor(() => expect(workbenchServices.dwsApi!.login).toHaveBeenCalledOnce())
    await waitFor(
      () => expect(screen.queryByTestId('aitable-board-dws-login')).not.toBeInTheDocument(),
      { timeout: 5000 }
    )
  })

  it('keeps project header controls interactive above the macOS drag region', async () => {
    render(
      <CloudTodoWorkspace
        user={{ id: 1, user_name: 'local', email: 'local@example.com' } as User}
        localProjects={[]}
        services={services()}
      />
    )

    await userEvent.click((await screen.findAllByText('Wegent V4'))[0])
    expect(screen.getByTestId('cloud-project-header')).toHaveClass('relative', 'z-10')
    expect(screen.getByTestId('cloud-project-board-view').parentElement).toHaveClass(
      'electron-titlebar-interactive-region'
    )
    expect(screen.getByTestId('cloud-project-ask-ai')).toHaveClass(
      'electron-titlebar-interactive-region'
    )
    expect(screen.getByTestId('cloud-project-task-search-toggle')).toHaveClass(
      'electron-titlebar-interactive-region'
    )
    expect(screen.getByTestId('cloud-todo-add')).toHaveClass('electron-titlebar-interactive-region')
    await userEvent.click(screen.getByTestId('cloud-todo-add'))

    expect(screen.getByTestId('workspace-issue-composer')).toBeInTheDocument()
    expect(screen.getByTestId('workspace-issue-input')).toBeInTheDocument()
    expect(screen.getAllByText('新建 Issue')).toHaveLength(1)
  })

  it('keeps primary header actions usable when detail panes leave the board narrow', async () => {
    const clientWidth = vi
      .spyOn(HTMLElement.prototype, 'clientWidth', 'get')
      .mockImplementation(function () {
        return this.dataset.testid === 'cloud-project-header' ? 260 : 0
      })
    const boundingRect = vi
      .spyOn(HTMLElement.prototype, 'getBoundingClientRect')
      .mockImplementation(function () {
        const width =
          this.dataset.testid === 'cloud-project-header-title'
            ? 168
            : this.tagName === 'NAV'
              ? 260
              : this.dataset.testid === 'cloud-project-ask-ai'
                ? 92
                : this.dataset.testid === 'cloud-project-task-search-toggle'
                  ? 104
                  : this.dataset.testid === 'cloud-todo-add'
                    ? 112
                    : 32
        return {
          bottom: 32,
          height: 32,
          left: 0,
          right: width,
          top: 0,
          width,
          x: 0,
          y: 0,
          toJSON: () => ({}),
        }
      })

    try {
      render(
        <CloudTodoWorkspace
          user={{ id: 1, user_name: 'local', email: 'local@example.com' } as User}
          localProjects={[]}
          services={services()}
        />
      )

      await userEvent.click((await screen.findAllByText('Wegent V4'))[0])

      await waitFor(() =>
        expect(screen.getByTestId('cloud-project-header-title')).toHaveClass('hidden')
      )
      expect(screen.getByLabelText('视图切换')).toBeInTheDocument()
      expect(screen.getByTestId('cloud-todo-add')).toHaveAccessibleName('新建 Issue')
      expect(screen.getByTestId('cloud-todo-add')).toHaveTextContent('')
      expect(screen.queryByTestId('cloud-project-ask-ai')).not.toBeInTheDocument()
      expect(screen.queryByTestId('cloud-project-task-search-toggle')).not.toBeInTheDocument()

      await userEvent.click(screen.getByTestId('cloud-project-header-more'))
      await userEvent.click(screen.getByTestId('cloud-project-header-more-search'))
      expect(screen.getByTestId('cloud-project-task-search-panel')).toBeInTheDocument()

      await userEvent.click(screen.getByTestId('cloud-project-header-more'))
      await userEvent.click(screen.getByTestId('cloud-project-header-more-ask-ai'))
      expect(screen.getByTestId('project-space-chat-sidebar')).toBeInTheDocument()
    } finally {
      clientWidth.mockRestore()
      boundingRect.mockRestore()
    }
  })

  it('creates a top-level issue from the lightweight workspace composer', async () => {
    const user = userEvent.setup()
    const workbenchServices = services()
    workbenchServices.deliveryApi!.listLoopItems = vi.fn(async () => ({ items: [item] }))
    workbenchServices.deliveryApi!.createLoopItem = vi.fn(async (_projectId, values) => ({
      ...item,
      id: 'WEG-3',
      title: values.title,
      description: values.description ?? '',
      parent_id: null,
    }))
    render(
      <CloudTodoWorkspace
        user={{ id: 1, user_name: 'local', email: 'local@example.com' } as User}
        localProjects={[]}
        services={workbenchServices}
      />
    )

    await userEvent.click((await screen.findAllByText('Wegent V4'))[0])
    await screen.findByTestId('cloud-todo-card-WEG-1')
    await user.click(screen.getByTestId('cloud-todo-add'))
    const input = screen.getByTestId('workspace-issue-input')
    await user.click(input)
    await user.paste('Release readiness\nVerify the complete launch flow')
    await user.click(screen.getByTestId('workspace-issue-submit'))

    await waitFor(() =>
      expect(workbenchServices.deliveryApi.createLoopItem).toHaveBeenCalledWith(11, {
        title: 'Release readiness Verify the complete launch flow',
        description: 'Release readiness\nVerify the complete launch flow',
        status: 'inbox',
        parent_id: null,
      })
    )
    expect(telemetryMocks.track).toHaveBeenCalledWith('board_item_created', {
      has_parent: false,
      source: 'cloud',
    })
  })

  it('asks the user to choose one automation before creating a multiply matched issue', async () => {
    const user = userEvent.setup()
    const workbenchServices = services()
    workbenchServices.deliveryApi!.listLoopItems = vi.fn(async () => ({ items: [item] }))
    workbenchServices.deliveryApi!.createLoopItem = vi
      .fn()
      .mockRejectedValueOnce(
        new ApiError(
          'Multiple automations match this Issue',
          409,
          'automation_selection_required',
          {
            code: 'automation_selection_required',
            candidates: [
              {
                id: 'automation-implement',
                name: 'Implement',
                description: 'Build the requested change',
              },
              {
                id: 'automation-review',
                name: 'Review',
                description: 'Review the requested change',
              },
            ],
          }
        )
      )
      .mockResolvedValueOnce({
        ...item,
        id: 'WEG-3',
        title: 'Choose one workflow',
        description: 'Choose one workflow',
        parent_id: null,
      })
    render(
      <CloudTodoWorkspace
        user={{ id: 1, user_name: 'local', email: 'local@example.com' } as User}
        localProjects={[]}
        services={workbenchServices}
      />
    )

    await user.click((await screen.findAllByText('Wegent V4'))[0])
    await screen.findByTestId('cloud-todo-card-WEG-1')
    await user.click(screen.getByTestId('cloud-todo-add'))
    await user.type(screen.getByTestId('workspace-issue-input'), 'Choose one workflow')
    await user.click(screen.getByTestId('workspace-issue-submit'))

    expect(await screen.findByTestId('automation-selection-options')).toHaveTextContent('Implement')
    expect(screen.getByTestId('automation-selection-options')).toHaveTextContent('Review')
    await user.click(screen.getByTestId('automation-selection-option-automation-review'))
    await user.click(screen.getByTestId('automation-selection-confirm'))

    await waitFor(() =>
      expect(workbenchServices.deliveryApi!.createLoopItem).toHaveBeenLastCalledWith(11, {
        title: 'Choose one workflow',
        description: 'Choose one workflow',
        status: 'inbox',
        automation_rule_id: 'automation-review',
        parent_id: null,
      })
    )
    expect(screen.queryByTestId('automation-selection-options')).not.toBeInTheDocument()
  })

  it('creates a queued task and starts it without opening a task composer', async () => {
    const workbenchServices = services()
    workbenchServices.deliveryApi!.listLoopItems = vi.fn(async () => ({ items: [item] }))
    workbenchServices.deliveryApi!.createLoopItem = vi.fn(async (_projectId, values) => ({
      ...item,
      id: 'WEG-3',
      title: values.title,
      description: values.description ?? '',
      status: values.status ?? 'inbox',
      parent_id: null,
    }))

    render(
      <CloudTodoWorkspace
        user={{ id: 1, user_name: 'local', email: 'local@example.com' } as User}
        localProjects={[{ id: 91, name: '运营工作区', tasks: [] }]}
        services={workbenchServices}
      />
    )

    await userEvent.click((await screen.findAllByText('Wegent V4'))[0])
    await userEvent.click(screen.getByTestId('cloud-todo-add'))
    await userEvent.click(screen.getByTestId('workspace-create-task-tab'))
    await userEvent.type(screen.getByTestId('workspace-issue-input'), 'Start release work')
    await userEvent.click(screen.getByTestId('workspace-issue-submit'))

    await waitFor(() =>
      expect(workbenchServices.deliveryApi.createLoopItem).toHaveBeenCalledWith(11, {
        title: 'Start release work',
        description: 'Start release work',
        status: 'pending',
        parent_id: null,
      })
    )
    expect(screen.getByTestId('mock-start-background-task')).toBeInTheDocument()
    expect(screen.queryByTestId('ai-chat-modal')).not.toBeInTheDocument()
    expect(screen.queryByTestId('cloud-todo-panel-stack')).not.toBeInTheDocument()
    expect(screen.queryByTestId('cloud-todo-detail-dismiss-layer')).not.toBeInTheDocument()
  }, 10_000)

  it('requests task catalogs before opening the composer for a dragged issue', async () => {
    const inboxItem = { ...item, status: 'inbox' as const }
    const requestCatalogs = vi.fn()
    const workbenchServices = services()
    workbenchServices.deliveryApi!.listLoopItems = vi.fn(async () => ({ items: [inboxItem] }))
    workbenchServices.deliveryApi!.listTaskBindings = vi.fn(async () => [])
    const workbench = {
      projectChat: { requestCatalogs },
    } as unknown as WorkbenchContextValue

    render(
      <WorkbenchContext.Provider value={workbench}>
        <CloudTodoWorkspace
          user={{ id: 1, user_name: 'local', email: 'local@example.com' } as User}
          localProjects={[]}
          services={workbenchServices}
        />
      </WorkbenchContext.Provider>
    )

    await userEvent.click((await screen.findAllByText('Wegent V4'))[0])
    await screen.findByTestId('cloud-todo-card-WEG-1')

    fireEvent.click(screen.getByTestId('mock-dnd-drag-to-pending'))

    await waitFor(() => expect(requestCatalogs).toHaveBeenCalledTimes(1))
    expect(screen.getByTestId('ai-chat-modal')).toHaveAttribute('data-task-id', inboxItem.id)
  })

  it('opens execution configuration on the first move when automation adds a workflow', async () => {
    const inboxItem = { ...item, status: 'inbox' as const }
    const automatedItem = {
      ...inboxItem,
      status: 'in_progress' as const,
      version: inboxItem.version + 1,
      workflow: {
        version: 1,
        definition_version: 1,
        stage_mode: 'dag' as const,
        advancement_policy: 'manual' as const,
        nodes: [
          {
            id: 'implement',
            name: '实现',
            depends_on: [],
            required: true,
            workspace_policy: 'composer' as const,
            execution_mode: 'robot' as const,
            automation_rule_id: 'automation-implement',
            execution_config: null,
            execution_config_override: false,
            status: 'ready' as const,
            task_ids: [],
          },
        ],
      },
    }
    const workbenchServices = services()
    workbenchServices.deliveryApi!.listLoopItems = vi.fn(async () => ({ items: [inboxItem] }))
    workbenchServices.deliveryApi!.getLoopItem = vi.fn(async () => inboxItem)
    workbenchServices.deliveryApi!.updateLoopItem = vi.fn(async () => automatedItem)

    render(
      <CloudTodoWorkspace
        user={{ id: 1, user_name: 'local', email: 'local@example.com' } as User}
        localProjects={[]}
        services={workbenchServices}
      />
    )

    await userEvent.click((await screen.findAllByText('Wegent V4'))[0])
    await screen.findByTestId('cloud-todo-card-WEG-1')

    fireEvent.click(screen.getByTestId('mock-dnd-drag-to-in-progress'))

    expect(await screen.findByTestId('issue-execution-config-dialog')).toBeInTheDocument()
    expect(workbenchServices.deliveryApi!.updateLoopItem).toHaveBeenCalledTimes(1)
    expect(workbenchServices.deliveryApi!.updateLoopItem).toHaveBeenCalledWith(inboxItem.id, {
      version: inboxItem.version,
      status: 'in_progress',
    })

    await userEvent.click(screen.getByTestId('issue-execution-config-cancel'))
    await waitFor(() =>
      expect(screen.queryByTestId('issue-execution-config-dialog')).not.toBeInTheDocument()
    )

    await userEvent.click(
      screen.getByTestId(`cloud-todo-card-configure-execution-${automatedItem.id}`)
    )
    expect(await screen.findByTestId('issue-execution-config-dialog')).toBeInTheDocument()
  })

  it('asks the user to choose one automation before moving into processing', async () => {
    const user = userEvent.setup()
    const inboxItem = { ...item, status: 'inbox' as const }
    const selectedItem = {
      ...inboxItem,
      status: 'in_progress' as const,
      version: inboxItem.version + 1,
    }
    const workbenchServices = services()
    workbenchServices.deliveryApi!.listLoopItems = vi.fn(async () => ({ items: [inboxItem] }))
    workbenchServices.deliveryApi!.getLoopItem = vi.fn(async () => inboxItem)
    workbenchServices.deliveryApi!.updateLoopItem = vi
      .fn()
      .mockRejectedValueOnce(
        new ApiError(
          'Multiple automations match this Issue',
          409,
          'automation_selection_required',
          {
            code: 'automation_selection_required',
            candidates: [
              {
                id: 'automation-implement',
                name: 'Implement',
                description: 'Build the requested change',
              },
              {
                id: 'automation-review',
                name: 'Review',
                description: 'Review the requested change',
              },
            ],
          }
        )
      )
      .mockResolvedValueOnce(selectedItem)

    render(
      <CloudTodoWorkspace
        user={{ id: 1, user_name: 'local', email: 'local@example.com' } as User}
        localProjects={[]}
        services={workbenchServices}
      />
    )

    await user.click((await screen.findAllByText('Wegent V4'))[0])
    await screen.findByTestId('cloud-todo-card-WEG-1')

    fireEvent.click(screen.getByTestId('mock-dnd-drag-to-in-progress'))

    expect(await screen.findByTestId('automation-selection-options')).toHaveTextContent('Implement')
    expect(screen.getByTestId('cloud-todo-card-WEG-1')).toBeInTheDocument()
    await user.click(screen.getByTestId('automation-selection-option-automation-review'))
    await user.click(screen.getByTestId('automation-selection-confirm'))

    await waitFor(() =>
      expect(workbenchServices.deliveryApi!.updateLoopItem).toHaveBeenLastCalledWith(inboxItem.id, {
        version: inboxItem.version,
        status: 'in_progress',
        automation_rule_id: 'automation-review',
      })
    )
    expect(screen.queryByTestId('automation-selection-options')).not.toBeInTheDocument()
  })

  it('binds a human workflow task without inventing an automation queue state', async () => {
    const manualIssue = {
      ...item,
      status: 'pending' as const,
      workflow: {
        version: 1,
        definition_version: 1,
        stage_mode: 'dag' as const,
        advancement_policy: 'manual' as const,
        nodes: [
          {
            id: 'backend',
            name: '后端',
            depends_on: [],
            required: true,
            workspace_policy: 'composer' as const,
            automation_rule_id: null,
            status: 'ready' as const,
            task_ids: [],
          },
        ],
      },
    }
    const workbenchServices = services()
    workbenchServices.deliveryApi!.listLoopItems = vi.fn(async () => ({
      items: [manualIssue],
    }))
    workbenchServices.deliveryApi!.getLoopItem = vi.fn(async () => manualIssue)
    workbenchServices.deliveryApi!.getWorkflowStageContext = vi.fn(async () => ({
      version: 1,
      compiled_task_instruction:
        '## 任务定位\n\n- Issue：Implement cloud MCP (`WEG-1`)\n- 当前节点：后端 (`backend`)\n\n## 当前节点任务\n\nls',
    }))
    let taskBound = false
    workbenchServices.deliveryApi!.listTaskBindings = vi.fn(async () =>
      taskBound
        ? [
            {
              id: 41,
              loop_item_id: manualIssue.id,
              task_user_id: 1,
              device_id: 'local-device',
              task_id: 'runtime-created',
              task_title: manualIssue.title,
              backend_task_id: null,
              workflow_node_id: 'backend',
              linked_at: '2026-08-19T14:46:27Z',
            },
          ]
        : []
    )
    workbenchServices.deliveryApi!.bindTask = vi.fn(async () => {
      taskBound = true
    })

    render(
      <CloudTodoWorkspace
        user={{ id: 1, user_name: 'local', email: 'local@example.com' } as User}
        localProjects={[]}
        services={workbenchServices}
      />
    )

    await userEvent.click((await screen.findAllByText('Wegent V4'))[0])
    await userEvent.click(await screen.findByTestId('cloud-todo-card-WEG-1'))
    await userEvent.click(await screen.findByTestId('cloud-todo-create-workflow-task-backend'))
    expect(screen.getByTestId('ai-chat-modal')).toHaveAttribute('data-workflow-node-id', 'backend')
    expect(workbenchServices.deliveryApi!.getWorkflowStageContext).toHaveBeenCalledWith(
      'WEG-1',
      'backend'
    )
    expect(screen.getByTestId('ai-chat-modal')).toHaveAttribute(
      'data-initial-task-input',
      expect.stringContaining('## 当前节点任务')
    )
    expect(screen.getByTestId('ai-chat-modal')).toHaveAttribute(
      'data-initial-task-input',
      expect.stringContaining('ls')
    )

    vi.mocked(workbenchServices.deliveryApi!.updateLoopItem).mockClear()
    await userEvent.click(screen.getByTestId('mock-create-runtime-task'))

    await waitFor(() =>
      expect(workbenchServices.deliveryApi!.bindTask).toHaveBeenCalledWith(
        'WEG-1',
        { deviceId: 'local-device', taskId: 'runtime-created' },
        'Implement cloud MCP',
        'backend'
      )
    )
    expect(await screen.findByTestId('cloud-todo-open-workflow-task-backend-41')).toHaveTextContent(
      'Implement cloud MCP'
    )
    expect(screen.getByTestId('cloud-todo-open-workflow-task-backend-41')).toHaveTextContent(
      'local-device · 等待执行'
    )
    expect(workbenchServices.deliveryApi!.updateLoopItem).not.toHaveBeenCalled()
  })

  it('edits TODO metadata without changing historical deliveries', async () => {
    const workbenchServices = services()
    render(
      <CloudTodoWorkspace
        user={{ id: 1, user_name: 'local', email: 'local@example.com' } as User}
        localProjects={[]}
        services={workbenchServices}
      />
    )

    await userEvent.click((await screen.findAllByText('Wegent V4'))[0])
    await userEvent.click(await screen.findByTestId('cloud-todo-card-WEG-1'))
    expect(screen.queryByTestId('cloud-todo-save')).not.toBeInTheDocument()
    await userEvent.clear(screen.getByTestId('cloud-todo-detail-title'))
    await userEvent.type(screen.getByTestId('cloud-todo-detail-title'), 'Updated TODO')
    await userEvent.click(screen.getByTestId('cloud-todo-save'))

    await waitFor(() =>
      expect(workbenchServices.deliveryApi?.updateLoopItem).toHaveBeenCalledWith('WEG-1', {
        version: 1,
        title: 'Updated TODO',
        description: 'Use the shared workspace',
        parent_id: null,
        priority: 'high',
        status: 'in_progress',
        due_at: null,
        tags: [],
      })
    )
    expect((await screen.findAllByText('Updated TODO')).length).toBeGreaterThan(0)
  })

  it('offers every board status when editing a completed TODO', async () => {
    const workbenchServices = services()
    workbenchServices.deliveryApi!.listLoopItems = vi.fn(async () => ({
      items: [{ ...item, status: 'completed' as const }],
    }))
    render(
      <CloudTodoWorkspace
        user={{ id: 1, user_name: 'local', email: 'local@example.com' } as User}
        localProjects={[]}
        services={workbenchServices}
      />
    )

    await userEvent.click((await screen.findAllByText('Wegent V4'))[0])
    await userEvent.click(await screen.findByTestId('cloud-todo-card-WEG-1'))
    const status = screen.getByTestId('cloud-todo-detail-status')
    expect(status).toHaveValue('completed')
    expect(status.querySelectorAll('option')).toHaveLength(5)
    expect(status).toHaveTextContent('已完成')
    expect(status).toHaveTextContent('进行中')
    expect(status).toHaveTextContent('收集箱')
  })

  it('uses the DingTalk-style grouping, filtering, and search toolbar', async () => {
    const workbenchServices = services()
    workbenchServices.deliveryApi!.updateCloudProject = vi.fn(async (_projectId, values) => ({
      ...project,
      board_config: values.board_config,
      version: project.version + 1,
    }))
    render(
      <CloudTodoWorkspace
        user={{ id: 1, user_name: 'local', email: 'local@example.com' } as User}
        localProjects={[]}
        services={workbenchServices}
      />
    )

    await userEvent.click((await screen.findAllByText('Wegent V4'))[0])
    expect(await screen.findByTestId('cloud-todo-card-WEG-1')).toBeInTheDocument()
    expect(screen.getByTestId('cloud-todo-column-in_progress')).toHaveTextContent(
      'Implement cloud MCP'
    )
    expect(screen.getByTestId('cloud-board-toolbar')).toHaveClass(
      'overflow-x-auto',
      'scrollbar-none'
    )
    expect(screen.getByTestId('cloud-board-group-filter-label').parentElement).toHaveClass(
      'shrink-0',
      'whitespace-nowrap'
    )
    await userEvent.selectOptions(screen.getByTestId('cloud-board-group-filter'), 'in_progress')
    expect(screen.getByTestId('cloud-board-group-filter-label')).toHaveTextContent('进行中')
    await userEvent.click(screen.getByTestId('cloud-board-group-by'))
    await userEvent.click(screen.getByTestId('cloud-board-group-option-priority'))
    expect(localStorage.getItem('wework-board-group:1:11')).toBe('priority')
    expect(screen.getByTestId('cloud-todo-column-priority-high')).toBeInTheDocument()
    expect(screen.getByTestId('cloud-board-group-filter')).toBeInTheDocument()
    expect(screen.getByTestId('cloud-board-search')).toBeInTheDocument()
    await userEvent.click(screen.getByTestId('cloud-board-save-global'))
    await waitFor(() =>
      expect(workbenchServices.deliveryApi!.updateCloudProject).toHaveBeenCalledWith(
        11,
        expect.objectContaining({
          board_config: expect.objectContaining({ group_by: 'priority' }),
        })
      )
    )
    expect(screen.queryByTestId('cloud-board-save-global')).not.toBeInTheDocument()
  })

  it('groups native board tasks by tag and keeps the tag filter beside grouping', async () => {
    const workbenchServices = services()
    workbenchServices.deliveryApi!.listLoopItems = vi.fn(async () => ({
      items: [{ ...item, tags: ['发布'] }],
    }))
    render(
      <CloudTodoWorkspace
        user={{ id: 1, user_name: 'local', email: 'local@example.com' } as User}
        localProjects={[]}
        services={workbenchServices}
      />
    )

    await userEvent.click((await screen.findAllByText('Wegent V4'))[0])
    await userEvent.click(screen.getByTestId('cloud-board-group-by'))
    await userEvent.click(screen.getByTestId('cloud-board-group-option-tag'))

    expect(screen.getByTestId('cloud-todo-column-tag-发布')).toHaveTextContent(
      'Implement cloud MCP'
    )
    expect(screen.getByTestId('cloud-todo-column-tag-untagged')).not.toHaveTextContent(
      'Implement cloud MCP'
    )
    expect(screen.getByTestId('cloud-board-group-filter-label')).toHaveTextContent('全部标签')
  })

  it('defaults new issues to the inbox', async () => {
    const user = userEvent.setup()
    const workbenchServices = services()
    workbenchServices.deliveryApi!.createLoopItem = vi.fn(async (_projectId, values) => ({
      ...item,
      id: 'WEG-2',
      sequence_number: 2,
      title: values.title,
      description: values.description ?? '',
      status: values.status ?? 'inbox',
    }))
    render(
      <CloudTodoWorkspace
        user={{ id: 1, user_name: 'local', email: 'local@example.com' } as User}
        localProjects={[]}
        services={workbenchServices}
      />
    )

    await userEvent.click((await screen.findAllByText('Wegent V4'))[0])
    await user.click(screen.getByTestId('cloud-todo-add'))
    await user.click(screen.getByTestId('workspace-issue-input'))
    await user.paste('Inbox Issue')
    await user.click(screen.getByTestId('workspace-issue-submit'))

    await waitFor(() =>
      expect(workbenchServices.deliveryApi?.createLoopItem).toHaveBeenCalledWith(11, {
        title: 'Inbox Issue',
        description: 'Inbox Issue',
        status: 'inbox',
        parent_id: null,
      })
    )
  })

  it('opens task creation directly from the pending column', async () => {
    const workbenchServices = services()
    render(
      <CloudTodoWorkspace
        user={{ id: 1, user_name: 'local', email: 'local@example.com' } as User}
        localProjects={[]}
        services={workbenchServices}
      />
    )

    await userEvent.click((await screen.findAllByText('Wegent V4'))[0])
    await userEvent.click(screen.getByTestId('cloud-todo-column-add-pending'))
    expect(screen.getByTestId('workspace-issue-composer')).toBeVisible()
    expect(screen.getByTestId('workspace-create-task-tab')).toHaveAttribute('aria-selected', 'true')
  })

  it('creates a new issue with the status of the board column entry point', async () => {
    const user = userEvent.setup()
    const workbenchServices = services()
    workbenchServices.deliveryApi!.createLoopItem = vi.fn(async (_projectId, values) => ({
      ...item,
      id: 'WEG-2',
      sequence_number: 2,
      title: values.title,
      description: values.description ?? '',
      status: values.status ?? 'inbox',
    }))
    render(
      <CloudTodoWorkspace
        user={{ id: 1, user_name: 'local', email: 'local@example.com' } as User}
        localProjects={[]}
        services={workbenchServices}
      />
    )

    await user.click((await screen.findAllByText('Wegent V4'))[0])
    await user.click(screen.getByTestId('cloud-todo-column-add-pending'))
    const input = screen.getByTestId('workspace-issue-input')
    await waitFor(() => expect(input).toHaveFocus())
    await user.keyboard('Pending Issue')
    await user.click(screen.getByTestId('workspace-issue-submit'))

    await waitFor(() =>
      expect(workbenchServices.deliveryApi?.createLoopItem).toHaveBeenCalledWith(11, {
        title: 'Pending Issue',
        description: 'Pending Issue',
        status: 'pending',
        parent_id: null,
      })
    )
  })

  it('prompts for AI manager configuration after creating directly into pending', async () => {
    const user = userEvent.setup()
    const workbenchServices = services()
    workbenchServices.deliveryApi!.createLoopItem = vi.fn(async (_projectId, values) => ({
      ...item,
      id: 'WEG-AI-PENDING',
      sequence_number: 2,
      title: values.title,
      description: values.description ?? '',
      status: 'pending' as const,
      workflow: {
        version: 1,
        definition_version: 1,
        stage_mode: 'none' as const,
        advancement_policy: 'ai' as const,
        ai_automation_rule_id: 'ai-manager',
        execution_config: {
          agent_id: null,
          runtime_profile_id: 'runtime-incomplete',
          execution_device_id: 'local-device',
          model: null,
          model_type: null,
          model_options: {},
          workspace_binding: { type: 'standalone' as const },
        },
        nodes: [],
      },
    }))

    render(
      <CloudTodoWorkspace
        user={{ id: 1, user_name: 'local', email: 'local@example.com' } as User}
        localProjects={[]}
        services={workbenchServices}
      />
    )

    await user.click((await screen.findAllByText('Wegent V4'))[0])
    await user.click(screen.getByTestId('cloud-todo-column-add-pending'))
    await user.type(screen.getByTestId('workspace-issue-input'), 'Pending AI Issue')
    await user.click(screen.getByTestId('workspace-issue-submit'))

    expect(await screen.findByTestId('issue-execution-config-dialog')).toBeVisible()
    expect(workbenchServices.deliveryApi.createLoopItem).toHaveBeenCalledWith(11, {
      title: 'Pending AI Issue',
      description: 'Pending AI Issue',
      status: 'pending',
      parent_id: null,
    })
    expect(workbenchServices.deliveryApi.updateLoopItem).not.toHaveBeenCalled()
  })

  it('does not bypass execution configuration when project services are unavailable', async () => {
    const user = userEvent.setup()
    const workbenchServices = services()
    workbenchServices.deliveryApi!.createLoopItem = vi.fn(async (_projectId, values) => ({
      ...item,
      id: 'WEG-AI-UNAVAILABLE',
      sequence_number: 2,
      title: values.title,
      description: values.description ?? '',
      status: 'pending' as const,
      workflow: {
        version: 1,
        definition_version: 1,
        stage_mode: 'none' as const,
        advancement_policy: 'ai' as const,
        ai_automation_rule_id: 'ai-manager',
        execution_config: {
          agent_id: null,
          runtime_profile_id: 'runtime-incomplete',
          execution_device_id: 'local-device',
          model: null,
          model_type: null,
          model_options: {},
          workspace_binding: { type: 'standalone' as const },
        },
        nodes: [],
      },
    }))

    render(
      <CloudTodoWorkspace
        user={{ id: 1, user_name: 'local', email: 'local@example.com' } as User}
        localProjects={[]}
        services={workbenchServices}
      />
    )

    await user.click((await screen.findAllByText('Wegent V4'))[0])
    await user.click(screen.getByTestId('cloud-todo-column-add-pending'))
    delete workbenchServices.projectSpaceDetailServices?.cloud
    await user.type(screen.getByTestId('workspace-issue-input'), 'Unavailable AI Issue')
    await user.click(screen.getByTestId('workspace-issue-submit'))

    expect(await screen.findByRole('alert')).toHaveTextContent('运行服务当前不可用')
    expect(screen.queryByTestId('issue-execution-config-dialog')).not.toBeInTheDocument()
    expect(screen.queryByTestId('mock-start-background-task')).not.toBeInTheDocument()
  })

  it('opens the full issue composer popup with the quick title and lane', async () => {
    const workbenchServices = services()
    render(
      <CloudTodoWorkspace
        user={{ id: 1, user_name: 'local', email: 'local@example.com' } as User}
        localProjects={[]}
        services={workbenchServices}
      />
    )

    await userEvent.click((await screen.findAllByText('Wegent V4'))[0])
    await userEvent.click(screen.getByTestId('cloud-todo-column-empty-add-inbox'))
    await userEvent.type(
      screen.getByTestId('cloud-todo-column-quick-create-input-inbox'),
      'Issue with details'
    )
    await userEvent.click(screen.getByTestId('cloud-todo-column-quick-create-full-inbox'))

    expect(screen.getByTestId('workspace-issue-composer')).toBeVisible()
    expect(screen.getByTestId('workspace-issue-input')).toHaveValue('Issue with details')
    expect(screen.getByTestId('workspace-issue-composer')).toHaveClass('fixed')
    expect(screen.getByRole('heading', { name: '新建 Issue' })).toBeVisible()
    expect(screen.getByTestId('workspace-issue-close')).toBeVisible()
  })

  it('only offers direct creation in intake columns', async () => {
    const workbenchServices = services()
    render(
      <CloudTodoWorkspace
        user={{ id: 1, user_name: 'local', email: 'local@example.com' } as User}
        localProjects={[]}
        services={workbenchServices}
      />
    )

    await userEvent.click((await screen.findAllByText('Wegent V4'))[0])
    for (const state of ['inbox', 'pending', 'in_progress', 'in_review', 'completed']) {
      expect(screen.getByTestId(`cloud-todo-column-dropzone-${state}`)).toHaveClass(
        'overflow-y-auto',
        'overscroll-y-contain',
        'px-2',
        'pt-2'
      )
      expect(screen.getByTestId(`cloud-todo-column-dropzone-${state}`)).not.toHaveClass('p-2')
    }
    for (const state of ['inbox', 'pending']) {
      const emptyAdd = screen.getByTestId(`cloud-todo-column-empty-add-${state}`)
      expect(emptyAdd).toBeVisible()
      expect(emptyAdd).toContainElement(emptyAdd.querySelector('svg'))
      expect(emptyAdd).toHaveTextContent(
        state === 'inbox' ? '创建第一个 Issue' : '创建 Issue 到待开始'
      )
      expect(screen.getByTestId(`cloud-todo-column-dropzone-${state}`)).toContainElement(emptyAdd)
      expect(screen.queryByTestId(`cloud-todo-column-bottom-add-${state}`)).not.toBeInTheDocument()
    }
    for (const state of ['in_progress', 'in_review', 'completed']) {
      expect(screen.queryByTestId(`cloud-todo-column-bottom-add-${state}`)).not.toBeInTheDocument()
      expect(screen.queryByTestId(`cloud-todo-column-add-${state}`)).not.toBeInTheDocument()
    }
  })

  it('shows unbound runtime tasks in my work and opens the local task directly', async () => {
    const workbenchServices = services()
    const onOpenRuntimeTask = vi.fn()
    render(
      <CloudTodoWorkspace
        user={{ id: 1, user_name: 'local', email: 'local@example.com' } as User}
        localProjects={[]}
        runtimeWork={{
          projects: [
            {
              project: { key: 'local-project', name: 'Local project' },
              deviceWorkspaces: [
                {
                  deviceId: 'local-device',
                  workspacePath: '/tmp/local-project',
                  available: true,
                  tasks: [
                    {
                      taskId: 'runtime-unbound',
                      workspacePath: '/tmp/local-project',
                      title: 'Unbound local task',
                      runtime: 'codex',
                    },
                  ],
                },
              ],
            },
          ],
          chats: [],
          totalTasks: 1,
        }}
        services={workbenchServices}
        onOpenRuntimeTask={onOpenRuntimeTask}
      />
    )

    await userEvent.click(await screen.findByTestId('cloud-my-work'))
    await userEvent.click(await screen.findByTestId('my-work-group-action-runtime-unbound'))

    expect(onOpenRuntimeTask).toHaveBeenCalledWith({
      deviceId: 'local-device',
      taskId: 'runtime-unbound',
      runtime: 'codex',
      threadId: undefined,
      workspacePath: '/tmp/local-project',
      runtimeHandle: undefined,
    })
    expect(workbenchServices.deliveryApi!.listMyWork).not.toHaveBeenCalled()
  })

  it('shows runtime tasks regardless of optional cloud board association', async () => {
    render(
      <CloudTodoWorkspace
        user={{ id: 1, user_name: 'local', email: 'local@example.com' } as User}
        localProjects={[]}
        runtimeWork={{
          projects: [
            {
              project: { key: 'local-project', name: 'Local project' },
              deviceWorkspaces: [
                {
                  deviceId: 'local-device',
                  workspacePath: '/tmp/local-project',
                  available: true,
                  tasks: [
                    {
                      taskId: 'runtime-associated',
                      workspacePath: '/tmp/local-project',
                      title: 'Associated local task',
                      runtime: 'codex',
                      runtimeHandle: {
                        cloudProjectId: 'cloud-project',
                        loopItemId: 'WEG-1',
                      },
                    },
                    {
                      taskId: 'runtime-standalone',
                      workspacePath: '/tmp/local-project',
                      title: 'Standalone local task',
                      runtime: 'codex',
                    },
                  ],
                },
              ],
            },
          ],
          chats: [],
          totalTasks: 2,
        }}
        services={services()}
      />
    )

    await userEvent.click(await screen.findByTestId('cloud-my-work'))

    expect(screen.getByTestId('my-work-group-action-runtime-associated')).toBeVisible()
    expect(screen.getByTestId('my-work-group-action-runtime-standalone')).toBeVisible()
  })

  it('refreshes an open My Tasks board when runtime execution status changes', async () => {
    const defaultProject = {
      ...project,
      id: 'default-work-items',
      project_key: 'WORK',
      name: '我的任务',
      project_store: 'local' as const,
      metadata: { system_kind: 'default_work_items' },
    }
    const address = {
      deviceId: 'local-device',
      taskId: 'runtime-live-status',
    }
    const runtimeWork = {
      projects: [
        {
          project: { id: 91, key: 'project-a', name: 'Project A' },
          deviceWorkspaces: [
            {
              deviceId: address.deviceId,
              workspacePath: '/tmp/project-a',
              available: true,
              tasks: [
                {
                  taskId: address.taskId,
                  workspacePath: '/tmp/project-a',
                  title: 'Live status task',
                  runtime: 'codex' as const,
                  running: false,
                },
              ],
            },
          ],
        },
      ],
      chats: [],
      totalTasks: 1,
    }
    const lifecycleStore = new RuntimeTaskLifecycleStore(1)
    lifecycleStore.syncRuntimeWork(runtimeWork)
    let persistedStatus: 'in_review' | 'in_progress' = 'in_review'
    const trackedIssue = {
      ...item,
      cloud_project_id: defaultProject.id,
      title: 'Live status task',
    }
    const workbenchServices = services()
    vi.mocked(workbenchServices.deliveryApi!.listCloudProjects).mockResolvedValue({
      items: [defaultProject],
    })
    workbenchServices.deliveryApi!.getBoardSnapshot = vi.fn(async () => ({
      items: [{ ...trackedIssue, status: persistedStatus }],
      task_bindings: [
        {
          id: 1,
          loop_item_id: trackedIssue.id,
          task_user_id: 1,
          device_id: address.deviceId,
          task_id: address.taskId,
          task_title: trackedIssue.title,
          backend_task_id: null,
          linked_at: '2026-08-29T00:00:00Z',
        },
      ],
      members: [],
      agents: [],
    }))
    workbenchServices.projectSpaceApis = {
      local: workbenchServices.deliveryApi!,
      defaultLocation: 'local',
    }
    const workspace = (lifecycleSnapshot: ReturnType<RuntimeTaskLifecycleStore['getSnapshot']>) => (
      <CloudTodoWorkspace
        user={{ id: 1, user_name: 'local', email: 'local@example.com' } as User}
        localProjects={[{ id: 91, name: 'Project A', tasks: [] }]}
        runtimeWork={runtimeWork}
        runtimeTaskLifecycle={lifecycleSnapshot}
        services={workbenchServices}
        embedded
        activeProjectRef={{
          projectStore: 'local',
          projectId: defaultProject.id,
        }}
      />
    )
    const rendered = render(workspace(lifecycleStore.getSnapshot()))

    expect(await screen.findByTestId('cloud-todo-column-in_review')).toHaveTextContent(
      trackedIssue.title
    )
    const initialSnapshotRequests = vi.mocked(workbenchServices.deliveryApi!.getBoardSnapshot).mock
      .calls.length

    persistedStatus = 'in_progress'
    act(() => lifecycleStore.executorStarted(address))
    rendered.rerender(workspace(lifecycleStore.getSnapshot()))

    await waitFor(() => {
      expect(workbenchServices.deliveryApi!.getBoardSnapshot).toHaveBeenCalledTimes(
        initialSnapshotRequests + 1
      )
    })
    expect(screen.getByTestId('cloud-todo-column-in_progress')).toHaveTextContent(
      trackedIssue.title
    )
    expect(screen.getByTestId('cloud-todo-column-in_review')).not.toHaveTextContent(
      trackedIssue.title
    )
  })

  it('shows only current system Issues in My Tasks and batch archives completed tasks', async () => {
    const defaultProject = {
      ...project,
      id: 'default-work-items',
      project_key: 'WORK',
      name: '我的任务',
      metadata: { system_kind: 'default_work_items' },
    }
    const workbenchServices = services()
    const stoppedIssue = {
      ...item,
      cloud_project_id: defaultProject.id,
      title: 'Stopped task Issue',
      status: 'in_review' as const,
    }
    const completedIssue = {
      ...item,
      cloud_project_id: defaultProject.id,
      id: 'WEG-2',
      sequence_number: 2,
      title: 'Completed task Issue',
      status: 'completed' as const,
      completed_at: '2026-08-21T00:00:00Z',
    }
    const archivedIssue = {
      ...item,
      cloud_project_id: defaultProject.id,
      id: 'WEG-3',
      sequence_number: 3,
      title: 'Archived task Issue',
      status: 'completed' as const,
      completed_at: '2026-08-20T00:00:00Z',
    }
    const noResponseIssue = {
      ...item,
      cloud_project_id: defaultProject.id,
      id: 'WEG-4',
      sequence_number: 4,
      title: 'Stopped without final response',
      status: 'in_review' as const,
    }
    vi.mocked(workbenchServices.deliveryApi!.listCloudProjects).mockResolvedValue({
      items: [defaultProject, project],
    })
    workbenchServices.deliveryApi!.getBoardSnapshot = vi.fn(async () => ({
      items: [stoppedIssue, completedIssue, archivedIssue, noResponseIssue],
      task_bindings: [
        {
          id: 1,
          loop_item_id: stoppedIssue.id,
          task_user_id: 1,
          device_id: 'local-device',
          task_id: 'stopped-task',
          task_title: 'Stopped task',
          backend_task_id: null,
          linked_at: '2026-08-21T00:00:00Z',
        },
        {
          id: 2,
          loop_item_id: completedIssue.id,
          task_user_id: 1,
          device_id: 'local-device',
          task_id: 'completed-task',
          task_title: 'Completed task',
          backend_task_id: null,
          linked_at: '2026-08-21T00:00:00Z',
        },
        {
          id: 3,
          loop_item_id: archivedIssue.id,
          task_user_id: 1,
          device_id: 'local-device',
          task_id: 'archived-task',
          task_title: 'Archived task',
          backend_task_id: null,
          linked_at: '2026-08-20T00:00:00Z',
        },
        {
          id: 4,
          loop_item_id: noResponseIssue.id,
          task_user_id: 1,
          device_id: 'local-device',
          task_id: 'no-response-task',
          task_title: 'Stopped without final response',
          backend_task_id: null,
          linked_at: '2026-08-21T00:00:00Z',
        },
      ],
      members: [],
      agents: [],
    }))
    const getRuntimeTranscript = vi.fn(async request => ({
      taskId: request.taskId,
      workspacePath: '/tmp/project-a',
      runtime: 'codex' as const,
      running: false,
      messages: [],
      turns:
        request.taskId === 'stopped-task'
          ? [
              {
                id: 'turn-final',
                items: [
                  {
                    id: 'assistant-final',
                    type: 'assistant_text' as const,
                    content:
                      '第一行：已经完成修复\n第二行：测试全部通过\n第三行：可以开始验收\n第四行：不应展示',
                  },
                ],
              },
            ]
          : [],
    }))
    workbenchServices.runtimeWorkApi = {
      getRuntimeTranscript,
    } as WorkbenchServices['runtimeWorkApi']
    const onOpenRuntimeTask = vi.fn()
    const onArchiveRuntimeTask = vi.fn(async () => ({ status: 'archived' as const }))

    render(
      <CloudTodoWorkspace
        user={{ id: 1, user_name: 'local', email: 'local@example.com' } as User}
        localProjects={[
          { id: 91, name: 'Project A', tasks: [] },
          { id: 92, name: 'Project B', tasks: [] },
        ]}
        runtimeWork={{
          projects: [
            {
              project: { id: 91, key: 'project-a', name: 'Project A' },
              deviceWorkspaces: [
                {
                  deviceId: 'local-device',
                  workspacePath: '/tmp/project-a',
                  available: true,
                  tasks: [
                    {
                      taskId: 'stopped-task',
                      workspacePath: '/tmp/project-a',
                      title: 'Stopped task',
                      runtime: 'codex',
                      running: false,
                      status: 'cancelled',
                      turnStatus: 'interrupted',
                      runtimeHandle: {
                        cloudProjectId: defaultProject.id,
                        loopItemId: stoppedIssue.id,
                      },
                    },
                    {
                      taskId: 'completed-task',
                      workspacePath: '/tmp/project-a',
                      title: 'Completed task',
                      runtime: 'codex',
                      running: false,
                      completedAt: 1_700_000_000,
                      runtimeHandle: {
                        cloudProjectId: defaultProject.id,
                        loopItemId: completedIssue.id,
                      },
                    },
                    {
                      taskId: 'no-response-task',
                      workspacePath: '/tmp/project-a',
                      title: 'Stopped without final response',
                      runtime: 'codex',
                      running: false,
                      status: 'cancelled',
                      turnStatus: 'interrupted',
                      runtimeHandle: {
                        cloudProjectId: defaultProject.id,
                        loopItemId: noResponseIssue.id,
                      },
                    },
                  ],
                },
              ],
            },
          ],
          chats: [],
          totalTasks: 3,
        }}
        services={workbenchServices}
        embedded
        activeProjectRef={{ projectStore: 'backend', projectId: 'default-work-items' }}
        onOpenRuntimeTask={onOpenRuntimeTask}
        onArchiveRuntimeTask={onArchiveRuntimeTask}
      />
    )

    expect(await screen.findByTestId('cloud-local-project-filter')).toHaveValue('all')
    expect(workbenchServices.deliveryApi!.listMyWork).not.toHaveBeenCalled()
    expect(await screen.findByTestId('cloud-todo-column-in_review')).toHaveTextContent(
      'Stopped task Issue'
    )
    expect(await screen.findByTestId('cloud-todo-card-tasks-WEG-1')).toHaveAttribute(
      'aria-label',
      'Stopped task'
    )
    expect(screen.getByTestId('cloud-todo-card-tasks-WEG-1')).not.toHaveTextContent('Stopped task')
    expect(await screen.findByTestId('cloud-todo-card-final-response-WEG-1')).toHaveTextContent(
      '第四行：不应展示'
    )
    expect(screen.getByTestId('cloud-todo-card-final-response-WEG-1')).not.toHaveTextContent(
      '第一行：已经完成修复'
    )
    expect(screen.queryByTestId('cloud-todo-card-final-response-WEG-4')).not.toBeInTheDocument()
    expect(getRuntimeTranscript).toHaveBeenCalledWith(
      expect.objectContaining({
        deviceId: 'local-device',
        taskId: 'stopped-task',
        limit: 50,
      })
    )
    expect(screen.getByTestId('cloud-todo-column-completed')).toHaveTextContent(
      'Completed task Issue'
    )
    await waitFor(() =>
      expect(screen.getByTestId('cloud-todo-column-completed')).not.toHaveTextContent(
        'Archived task Issue'
      )
    )

    await userEvent.click(screen.getByText('Stopped task Issue'))
    expect(screen.getByTestId('cloud-todo-detail')).toHaveTextContent('Stopped task Issue')
    expect(onOpenRuntimeTask).not.toHaveBeenCalled()

    await userEvent.click(screen.getByTestId('cloud-my-tasks-archive-completed'))
    expect(screen.getByText('归档已完成任务？')).toBeInTheDocument()
    await userEvent.click(screen.getByTestId('cloud-my-tasks-archive-completed-confirm'))

    await waitFor(() =>
      expect(onArchiveRuntimeTask).toHaveBeenCalledWith(
        expect.objectContaining({ deviceId: 'local-device', taskId: 'completed-task' }),
        undefined
      )
    )
    expect(workbenchServices.deliveryApi!.archiveLoopItem).toHaveBeenCalledWith('WEG-2')
    expect(screen.getByTestId('cloud-todo-column-completed')).not.toHaveTextContent(
      'Completed task Issue'
    )
  })

  it('uses pointer dragging for TODO cards without starting a native system drag', async () => {
    const workbenchServices = services()
    render(
      <CloudTodoWorkspace
        user={{ id: 1, user_name: 'local', email: 'local@example.com' } as User}
        localProjects={[]}
        services={workbenchServices}
      />
    )
    await userEvent.click((await screen.findAllByText('Wegent V4'))[0])
    const card = await screen.findByTestId('cloud-todo-card-WEG-1')
    expect(card).not.toHaveAttribute('draggable')
  })

  it('creates a shared cloud folder from the files view', async () => {
    const workbenchServices = services()
    render(
      <CloudTodoWorkspace
        user={{ id: 1, user_name: 'local', email: 'local@example.com' } as User}
        localProjects={[]}
        services={workbenchServices}
      />
    )

    await userEvent.click((await screen.findAllByText('Wegent V4'))[0])
    await userEvent.click(screen.getByRole('button', { name: '文件' }))
    expect(
      screen.getByTestId('cloud-project-header').querySelector('.electron-titlebar-drag-region')
    ).toBeInTheDocument()
    await userEvent.click(await screen.findByTestId('cloud-folder-add'))
    await userEvent.type(screen.getByTestId('cloud-folder-name'), 'docs')
    await userEvent.click(screen.getByTestId('cloud-folder-create-confirm'))

    await waitFor(() =>
      expect(workbenchServices.deliveryApi?.createCloudFolder).toHaveBeenCalledWith(11, 'docs')
    )
  })
})
