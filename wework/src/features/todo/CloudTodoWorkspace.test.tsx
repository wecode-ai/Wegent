import type { DndContextProps, DragCancelEvent, DragEndEvent, DragStartEvent } from '@dnd-kit/core'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import '@/i18n'

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
  getRuntimeConversationTurns,
  reconcileRuntimeConversationSnapshot,
} from '@/features/workbench/runtimeConversationCache'
import type { RuntimeTaskCreateRequest, RuntimeTranscriptResponse, User } from '@/types/api'
import { CloudTodoWorkspace } from './CloudTodoWorkspace'
import { workItemTaskInput } from './workItemTaskInput'
import { publishProjectSpaceTaskBindingChanged } from './projectSpaceSelection'
import {
  createWeworkSharedWorkspaceApi,
  createWeworkWorkspaceRuntimePort,
} from '@/features/collaboration/weworkSharedWorkspaceApi'

const telemetryMocks = vi.hoisted(() => ({
  track: vi.fn(),
}))
const notificationActionMocks = vi.hoisted(() => ({
  action: null as
    | null
    | ((input: {
        projectId: string
        itemId: string
        issueId: string
        dispatchTaskId: string
        idempotencyKey: string
        humanAssignmentId: string
        dispatchId: string
        roundId: string
        assignmentId: string
        taskTitle: string
        instructions: string
        workflowStageId?: string
      }) => Promise<void>),
}))

vi.mock('@/telemetry/client', () => telemetryMocks)
vi.mock('@/features/notifications/useIssueDispatchNotificationActionRegistration', () => ({
  useIssueDispatchNotificationActionRegistration: (
    _id: string,
    _active: boolean,
    action: NonNullable<typeof notificationActionMocks.action>
  ) => {
    notificationActionMocks.action = action
  },
}))

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
    scrollOrigin,
  }: {
    testId: string
    initialAddress?: {
      deviceId: string
      taskId: string
      runtimeHandle?: { modelSelection?: { modelName?: string } }
    } | null
    collapseComposerWhenIdle?: boolean
    scrollOrigin?: 'top' | 'bottom'
  }) => (
    <div
      data-testid={testId}
      data-device-id={initialAddress?.deviceId}
      data-task-id={initialAddress?.taskId}
      data-model-name={initialAddress?.runtimeHandle?.modelSelection?.modelName}
      data-collapse-composer={String(collapseComposerWhenIdle)}
      data-scroll-origin={scrollOrigin}
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
    initialTaskRequest,
    initialTaskInput,
  }: {
    task?: { id: string }
    open: boolean
    onClose: () => void
    onBack?: () => void
    initialAddress?: {
      deviceId: string
      taskId: string
      runtimeHandle?: { modelSelection?: { modelName?: string } }
    } | null
    onOpenRuntimeTask?: (address: { deviceId: string; taskId: string }) => void
    onAddressChange?: (address: { deviceId: string; taskId: string }) => void
    onTaskCreated?: (address: { deviceId: string; taskId: string }) => void | Promise<void>
    prepareTask?: (address: {
      deviceId: string
      taskId: string
    }) => void | Promise<void | (() => void | Promise<void>)>
    initialTaskRequest?: {
      projectId?: number
      modelId?: string
      forceStart?: boolean
      deviceId?: string
      workspacePath?: string
    }
    initialTaskInput?: string
  }) => (
    <div
      data-testid="ai-chat-modal"
      data-task-id={task?.id}
      data-open={open ? 'yes' : 'no'}
      data-runtime-task-id={initialAddress?.taskId}
      data-model-name={initialAddress?.runtimeHandle?.modelSelection?.modelName}
      data-task-project-id={initialTaskRequest?.projectId}
      data-task-model-id={initialTaskRequest?.modelId}
      data-task-force-start={String(initialTaskRequest?.forceStart ?? false)}
      data-task-device-id={initialTaskRequest?.deviceId}
      data-task-workspace-path={initialTaskRequest?.workspacePath}
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
        data-testid="mock-create-runtime-task-with-model"
        onClick={() => {
          const address = {
            deviceId: 'local-device',
            taskId: 'runtime-created-with-model',
            runtimeHandle: {
              modelSelection: {
                modelName: 'deepseek-v4-pro-responses',
                modelType: 'public',
                options: { reasoning: 'high' },
              },
            },
          }
          void Promise.resolve(prepareTask?.(address)).then(() => {
            onAddressChange?.(address)
            return onTaskCreated?.(address)
          })
        }}
      >
        使用模型创建 Runtime 任务
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
    taskRequest,
  }: {
    onAddressChange: (address: { deviceId: string; taskId: string }) => void
    taskRequest?: RuntimeTaskCreateRequest | null
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
      data-task-request={JSON.stringify(taskRequest ?? null)}
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
    create: vi.fn(),
    update: vi.fn(),
  }
  workbenchServices.projectChatAgentApi = projectChatAgentApi
  workbenchServices.sharedWorkspaceApi = createWeworkSharedWorkspaceApi({
    client: {
      get: vi.fn(async (url: string) => {
        if (url.endsWith('/chat-agents')) return []
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

async function expandIssueExecutionDetails() {
  const toggle = screen.queryByTestId('cloud-todo-toggle-tasks')
  if (toggle?.getAttribute('aria-expanded') === 'false') {
    await userEvent.click(toggle)
  }
}

async function openIssueMoreProperties() {
  const trigger = screen.getByTestId('cloud-todo-more-properties')
  if (!trigger.closest('details')?.open) {
    await userEvent.click(trigger)
  }
}

async function openIssueFromBoard(itemId = 'WEG-1') {
  const openTask = screen.queryByTestId(`cloud-todo-card-open-task-${itemId}`)
  await userEvent.click(openTask ?? screen.getByTestId(`cloud-todo-card-${itemId}`))
}

describe('CloudTodoWorkspace', () => {
  beforeEach(() => {
    clearRuntimeConversationCacheForTests()
    telemetryMocks.track.mockClear()
    notificationActionMocks.action = null
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

  it('opens the requested Issue after a parent rerender cancels the pending focus effect', async () => {
    const workbenchServices = services()
    vi.mocked(workbenchServices.deliveryApi!.listCloudProjects).mockResolvedValue({
      items: [{ ...project, id: String(project.id) }],
    })
    vi.mocked(workbenchServices.deliveryApi!.listLoopItems).mockResolvedValue({
      items: [{ ...item, cloud_project_id: String(project.id) }],
    })
    const props = {
      user: { id: 1, user_name: 'local', email: 'local@example.com' } as User,
      localProjects: [],
      services: workbenchServices,
      embedded: true,
      activeProjectRef: { projectStore: 'backend' as const, projectId: String(project.id) },
    }
    const view = render(<CloudTodoWorkspace {...props} />)
    await screen.findByTestId(`cloud-todo-card-${item.id}`, undefined, { timeout: 10_000 })

    const pending: VoidFunction[] = []
    const microtasks = vi.spyOn(globalThis, 'queueMicrotask').mockImplementation(callback => {
      pending.push(callback)
    })
    const staleHandled = vi.fn()
    const handled = vi.fn()
    view.rerender(
      <CloudTodoWorkspace {...props} focusedItemId={item.id} onFocusedItemHandled={staleHandled} />
    )
    view.rerender(
      <CloudTodoWorkspace {...props} focusedItemId={item.id} onFocusedItemHandled={handled} />
    )
    microtasks.mockRestore()
    await act(async () => {
      pending.forEach(callback => callback())
    })

    expect(staleHandled).not.toHaveBeenCalled()
    expect(handled).toHaveBeenCalledTimes(1)
    expect(await screen.findByTestId('cloud-todo-detail-title')).toHaveValue(item.title)
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

    await screen.findByTestId('cloud-project-header', undefined, { timeout: 10_000 })
    expect(screen.getByTestId('cloud-project-header')).toHaveTextContent('协作')
    const workspace = screen.getByTestId('cloud-todo-workspace')
    expect(workspace).toHaveAttribute('data-embedded', 'true')
    expect(workspace.querySelector('aside')).not.toBeInTheDocument()
    expect(screen.getByTestId('cloud-todo-main')).toHaveClass('min-h-0', 'overflow-hidden')
    expect(screen.queryByTestId('cloud-todo-collapsed-chrome-controls')).not.toBeInTheDocument()
  })

  it('uses the selected project title for an embedded project view', async () => {
    const workbenchServices = services()
    vi.mocked(workbenchServices.deliveryApi!.listCloudProjects).mockResolvedValue({
      items: [{ ...project, id: String(project.id), name: '我的任务' }],
    })
    render(
      <CloudTodoWorkspace
        user={{ id: 1, user_name: 'local', email: 'local@example.com' } as User}
        localProjects={[]}
        services={workbenchServices}
        embedded
        embeddedTitle="project"
        activeProjectRef={{
          projectStore: 'backend',
          projectId: String(project.id),
        }}
      />
    )

    expect(await screen.findByTestId('cloud-project-header')).toHaveTextContent('我的任务')
  })

  it.each([
    {
      actionTestId: 'cloud-todo-create-assignee-add-member',
      selectedTabTestId: 'collaboration-participants-tab-members',
      targetTestId: 'cloud-member-search',
    },
    {
      actionTestId: 'cloud-todo-create-assignee-add-agent',
      selectedTabTestId: 'collaboration-participants-tab-agents',
      targetTestId: 'wework-agent-resource-creator',
    },
  ])('routes the create-assignee action into project settings: %j', async values => {
    const workbenchServices = services(
      values.actionTestId === 'cloud-todo-create-assignee-add-agent'
        ? {
            agentResourceApi: {
              listModels: vi.fn(async () => []),
              listSkills: vi.fn(async () => []),
              createAgent: vi.fn(),
              getAgent: vi.fn(),
              updateAgent: vi.fn(),
            } as unknown as WorkbenchServices['agentResourceApi'],
          }
        : {}
    )
    render(
      <CloudTodoWorkspace
        user={{ id: 1, user_name: 'local', email: 'local@example.com' } as User}
        localProjects={[]}
        services={workbenchServices}
        activeProjectRef={{
          projectStore: 'backend',
          projectId: String(project.id),
        }}
      />
    )

    await screen.findByTestId('cloud-project-header')
    await userEvent.click(screen.getByTestId('cloud-project-table-view'))
    await userEvent.click(await screen.findByTestId('collaboration-issue-table-create'))
    await userEvent.click(await screen.findByTestId('cloud-todo-create-assignee'))
    await userEvent.click(screen.getByTestId(values.actionTestId))

    expect(await screen.findByTestId('project-settings-shell')).toBeInTheDocument()
    expect(await screen.findByTestId(values.selectedTabTestId)).toHaveAttribute(
      'aria-selected',
      'true'
    )
    const target = await screen.findByTestId(values.targetTestId)
    expect(target).toBeVisible()
    if (values.targetTestId === 'cloud-member-search') expect(target).toHaveFocus()
    expect(screen.queryByTestId('cloud-todo-create-panel')).not.toBeInTheDocument()
  })

  it('shows authoritative assignment target names in the project Issue table', async () => {
    const workbenchServices = services()
    const listAssignments = vi.fn(async () => [
      {
        id: 'assignment-1',
        issue_id: item.id,
        target_type: 'agent' as const,
        target_id: 'agent-1',
        target_name: 'Codex 产品工程师',
        workflow_step: 'implementation',
        comment_id: null,
        created_by_user_id: 1,
        created_by_user_name: 'local',
        status: 'active' as const,
        created_at: '2026-09-11T00:00:00Z',
        updated_at: '2026-09-11T00:00:00Z',
      },
    ])
    workbenchServices.sharedWorkspaceApi!.assignments!.list = listAssignments
    render(
      <CloudTodoWorkspace
        user={{ id: 1, user_name: 'local', email: 'local@example.com' } as User}
        localProjects={[]}
        services={workbenchServices}
        activeProjectRef={{
          projectStore: 'backend',
          projectId: String(project.id),
        }}
      />
    )

    await screen.findByTestId('cloud-project-header')
    await userEvent.click(screen.getByTestId('cloud-project-table-view'))

    expect(await screen.findByTestId('collaboration-issue-table')).toHaveTextContent(
      'Codex 产品工程师'
    )
    expect(listAssignments).toHaveBeenCalledWith(item.id)
  })

  it('loads Git-backed boards by column and fetches details only after opening a card', async () => {
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
        task: {
          deviceId: 'local-device',
          taskId: 'runtime-moved-to-board',
        },
        project: {
          projectStore: 'backend',
          projectId: String(project.id),
        },
        type: 'bound',
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
    expect(screen.queryByTestId('cloud-project-board-view')).not.toBeInTheDocument()
    expect(screen.queryByTestId('cloud-project-table-view')).not.toBeInTheDocument()
    expect(screen.queryByTestId('cloud-project-files-view')).not.toBeInTheDocument()
    expect(screen.queryByTestId('cloud-project-manage-view')).not.toBeInTheDocument()
    expect(
      screen.queryByTestId('cloud-sidebar-project-more-default-work-items')
    ).not.toBeInTheDocument()
    await waitFor(() => {
      expect(onActiveProjectChange).toHaveBeenCalledWith(
        expect.objectContaining({
          id: 'default-work-items',
          project_store: 'backend',
        })
      )
    })
  })

  it('loads the local default My Tasks board without a separate project click', async () => {
    const defaultProject = {
      ...project,
      id: 'default-work-items',
      public_id: 'default-work-items',
      project_key: 'WORK',
      name: '我的任务',
      project_store: 'local' as const,
      metadata: { system_kind: 'default_work_items' },
    }
    const localServices = services()
    const localApi = localServices.deliveryApi!
    localApi.listCloudProjects = vi.fn(async () => ({ items: [defaultProject] }))
    localApi.listLoopItems = vi.fn(async () => ({ items: [] }))
    const workbenchServices = services({
      sharedWorkspaceApi: undefined,
      projectSpaceApis: {
        local: localApi,
        defaultLocation: 'local',
      },
    })

    render(
      <CloudTodoWorkspace
        user={{ id: 1, user_name: 'local', email: 'local@example.com' } as User}
        localProjects={[]}
        services={workbenchServices}
        defaultProjectRequested
      />
    )

    expect(await screen.findByTestId('cloud-project-header')).toHaveTextContent('我的任务')
    expect(await screen.findByTestId('cloud-todo-column-inbox')).toBeVisible()
    expect(localApi.getBoardSnapshot).toHaveBeenCalledWith('default-work-items')
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

  it('shows live process text and the unwrapped command on a running task card', async () => {
    const workbenchServices = services()
    const getRuntimeGoal = vi.fn(async () => ({
      accepted: true,
      taskId: 'runtime-2',
      goal: {
        threadId: 'thread-runtime-2',
        objective: '验证看板悬浮预览始终展示当前会话目标和最新进展',
        status: 'active' as const,
        tokenBudget: null,
        tokensUsed: 800,
        timeUsedSeconds: 60,
        createdAt: 1,
        updatedAt: 2,
      },
    }))
    workbenchServices.runtimeWorkApi = {
      getRuntimeGoal,
    } as WorkbenchServices['runtimeWorkApi']
    workbenchServices.deliveryApi!.listTaskBindings = vi.fn(async () => [
      {
        id: 2,
        loop_item_id: item.id,
        task_user_id: 1,
        device_id: 'local-device',
        task_id: 'runtime-2',
        task_title: '验证完整工作流',
        backend_task_id: null,
        modelSelection: {
          modelName: 'gpt-5.6-codex',
          modelType: 'public',
          options: { reasoning: 'high' },
        },
        linked_at: '2026-08-16T00:01:00Z',
      },
    ])
    const address = { deviceId: 'local-device', taskId: 'runtime-2' }
    applyRuntimeConversationAction(address, {
      type: 'assistant_started',
      taskId: address.taskId,
      subtaskId: 'turn-previous',
    })
    applyRuntimeConversationAction(address, {
      type: 'assistant_chunk',
      subtaskId: 'turn-previous',
      itemId: 'assistant-previous',
      content: '上一轮已经完成的回复，不应覆盖当前进展',
    })
    applyRuntimeConversationAction(address, {
      type: 'assistant_done',
      subtaskId: 'turn-previous',
    })
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
    expect(await screen.findByTestId('cloud-todo-card-activity-WEG-1')).toBeInTheDocument()
    expect(screen.queryByText('Investigating board data flow')).not.toBeInTheDocument()
    expect(screen.getByTestId('cloud-todo-card-tasks-WEG-1')).not.toHaveTextContent(
      '上一轮已经完成的回复'
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
          toolInput: { cmd: "/bin/zsh -lc 'pnpm test'" },
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

    expect(screen.getByTestId('cloud-todo-card-process-WEG-1')).toHaveTextContent(
      '先检查项目看板如何组织运行中的消息。'
    )
    expect(screen.getByTestId('cloud-todo-card-process-WEG-1')).toHaveClass(
      'line-clamp-2',
      'leading-5'
    )
    expect(screen.getByTestId('cloud-todo-card-process-WEG-1')).not.toHaveClass('h-15')
    expect(screen.queryByText('Rendering latest thinking')).not.toBeInTheDocument()
    expect(screen.getByTestId('cloud-todo-card-tool-WEG-1-tool-1')).toHaveTextContent(
      '运行命令 · pnpm test'
    )
    expect(screen.getByTestId('cloud-todo-card-tool-WEG-1-tool-1')).not.toHaveTextContent(
      '/bin/zsh -lc'
    )
    expect(screen.getByTestId('cloud-todo-card-tool-line-WEG-1')).toHaveClass(
      'ml-2',
      'border-l',
      'pl-3'
    )
    expect(
      screen
        .getByTestId('cloud-todo-card-process-WEG-1')
        .compareDocumentPosition(screen.getByTestId('cloud-todo-card-tool-WEG-1-tool-1')) &
        Node.DOCUMENT_POSITION_FOLLOWING
    ).not.toBe(0)

    const focusView = screen.getByTestId('cloud-board-focus-running')
    const viewActions = screen.getByTestId('cloud-board-view-actions')
    expect(viewActions).toHaveClass('ml-auto')
    expect(viewActions).toContainElement(focusView)
    expect(focusView).toHaveAttribute('aria-pressed', 'false')
    expect(screen.getByTestId('cloud-todo-column-in_progress')).toHaveClass('w-[292px]')
    expect(screen.getByTestId('cloud-todo-column-in_review')).toHaveClass('w-[292px]')

    await userEvent.click(focusView)

    expect(focusView).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByTestId('cloud-todo-column-in_progress')).toHaveClass('w-[480px]')
    expect(screen.getByTestId('cloud-todo-column-in_review')).toHaveClass('w-[480px]')
    expect(screen.getByTestId('cloud-todo-column-pending')).toHaveClass('w-[292px]')
    expect(screen.getByTestId('cloud-todo-card-process-WEG-1')).toHaveClass('line-clamp-[8]')
    expect(screen.getByTestId('cloud-todo-card-process-WEG-1')).not.toHaveClass('line-clamp-2')
    expect(localStorage.getItem('wework-board-focus-execution:v1:1:backend:11')).toBe('true')

    act(() => {
      for (const [id, cmd] of [
        ['tool-2', 'pnpm lint'],
        ['tool-3', 'pnpm typecheck'],
      ]) {
        applyRuntimeConversationAction(address, {
          type: 'block_created',
          subtaskId: 'turn-1',
          block: {
            id,
            subtaskId: 'turn-1',
            type: 'tool',
            toolName: 'functions.exec_command',
            toolInput: { cmd },
            status: 'streaming',
            createdAt: Date.now(),
          },
        })
      }
    })

    expect(screen.getByTestId('cloud-todo-card-tool-WEG-1-tool-1')).toBeInTheDocument()
    expect(screen.getByTestId('cloud-todo-card-tool-WEG-1-tool-2')).toBeInTheDocument()
    expect(screen.getByTestId('cloud-todo-card-tool-WEG-1-tool-3')).toBeInTheDocument()

    await userEvent.click(focusView)

    expect(screen.getByTestId('cloud-todo-column-in_progress')).toHaveClass('w-[292px]')
    expect(screen.getByTestId('cloud-todo-column-in_review')).toHaveClass('w-[292px]')
    expect(screen.queryByTestId('cloud-todo-card-tool-WEG-1-tool-1')).not.toBeInTheDocument()
    expect(screen.queryByTestId('cloud-todo-card-tool-WEG-1-tool-2')).not.toBeInTheDocument()
    expect(screen.getByTestId('cloud-todo-card-tool-WEG-1-tool-3')).toBeInTheDocument()
    expect(localStorage.getItem('wework-board-focus-execution:v1:1:backend:11')).toBeNull()

    expect(await screen.findByTestId('cloud-todo-card-goal-WEG-1-2')).toHaveAttribute(
      'title',
      expect.stringContaining('验证看板悬浮预览始终展示当前会话目标和最新进展')
    )

    await userEvent.click(screen.getByTestId('cloud-todo-card-WEG-1'))
    expect(await screen.findByTestId('cloud-todo-detail')).toBeInTheDocument()
    expect(screen.queryByTestId('cloud-todo-card-progress-popup-WEG-1')).not.toBeInTheDocument()
    expect(getRuntimeGoal).toHaveBeenCalledWith({
      address: expect.objectContaining(address),
    })
  })

  it('opens each Issue drawer directly from its board card', async () => {
    const secondItem = {
      ...item,
      id: 'WEG-2',
      sequence_number: 2,
      title: 'Verify pinned preview switching',
      status: 'in_review' as const,
      sort_order: 1,
    }
    const workbenchServices = services()
    workbenchServices.deliveryApi!.listLoopItems = vi.fn(async () => ({
      items: [{ ...item, status: 'in_review' as const }, secondItem],
    }))
    workbenchServices.deliveryApi!.listTaskBindings = vi.fn(async itemId => [
      {
        id: itemId === item.id ? 1 : 2,
        loop_item_id: itemId,
        task_user_id: 1,
        device_id: 'local-device',
        task_id: itemId === item.id ? 'runtime-1' : 'runtime-2',
        task_title: itemId === item.id ? 'First task progress' : 'Second task progress',
        backend_task_id: null,
        linked_at: '2026-09-09T00:00:00Z',
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
    expect(await screen.findByTestId('cloud-todo-detail-title')).toHaveValue(item.title)
    expect(screen.queryByTestId('cloud-todo-card-progress-popup-WEG-1')).not.toBeInTheDocument()
    expect(screen.queryByTestId('cloud-todo-card-open-task-WEG-1')).not.toBeInTheDocument()
    await userEvent.click(screen.getByTestId('cloud-todo-detail-close'))
    await userEvent.click(screen.getByTestId('cloud-todo-card-WEG-2'))
    expect(await screen.findByTestId('cloud-todo-detail-title')).toHaveValue(secondItem.title)
    expect(screen.queryByTestId('cloud-todo-card-progress-popup-WEG-2')).not.toBeInTheDocument()
  })

  it('restores the execution-stage focus view for the selected project', async () => {
    localStorage.setItem('wework-board-focus-execution:v1:1:backend:11', 'true')

    render(
      <CloudTodoWorkspace
        user={{ id: 1, user_name: 'local', email: 'local@example.com' } as User}
        localProjects={[]}
        services={services()}
      />
    )

    await userEvent.click((await screen.findAllByText('Wegent V4'))[0])

    await waitFor(() =>
      expect(screen.getByTestId('cloud-board-focus-running')).toHaveAttribute(
        'aria-pressed',
        'true'
      )
    )
    expect(screen.getByTestId('cloud-todo-column-in_progress')).toHaveClass('w-[480px]')
    expect(screen.getByTestId('cloud-todo-column-in_review')).toHaveClass('w-[480px]')
    expect(screen.getByTestId('cloud-todo-column-inbox')).toHaveClass('w-[292px]')

    const boardScroll = screen.getByTestId('cloud-board-scroll')
    boardScroll.scrollLeft = 320
    await userEvent.click(screen.getByTestId('cloud-board-group-by'))
    await userEvent.click(screen.getByTestId('cloud-board-group-option-priority'))

    expect(screen.queryByTestId('cloud-board-focus-running')).not.toBeInTheDocument()
    expect(screen.getByTestId('cloud-todo-column-priority-high')).toHaveClass('w-[292px]')
    expect(boardScroll.scrollLeft).toBe(0)

    boardScroll.scrollLeft = 240
    await userEvent.click(screen.getByTestId('cloud-board-group-by'))
    await userEvent.click(screen.getByTestId('cloud-board-group-option-status'))

    expect(screen.getByTestId('cloud-board-focus-running')).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByTestId('cloud-todo-column-in_progress')).toHaveClass('w-[480px]')
    expect(screen.getByTestId('cloud-todo-column-in_review')).toHaveClass('w-[480px]')
    expect(boardScroll.scrollLeft).toBe(0)
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

    await userEvent.click(screen.getByTestId('cloud-todo-card-WEG-1'))
    expect(await screen.findByTestId('cloud-todo-detail')).toBeInTheDocument()
    expect(screen.queryByTestId('cloud-todo-card-progress-popup-WEG-1')).not.toBeInTheDocument()
  })

  it('loads persisted task output for an in-progress Issue on the board', async () => {
    const workbenchServices = services()
    const address = { deviceId: 'local-device', taskId: 'runtime-in-progress' }
    applyRuntimeConversationAction(address, {
      type: 'assistant_started',
      taskId: address.taskId,
      subtaskId: 'stale-turn',
    })
    applyRuntimeConversationAction(address, {
      type: 'assistant_chunk',
      subtaskId: 'stale-turn',
      itemId: 'stale-assistant',
      content: '旧的工具输出',
    })
    applyRuntimeConversationAction(address, {
      type: 'assistant_done',
      subtaskId: 'stale-turn',
    })
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
      fullContent: true,
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
      turns: [
        {
          id: 'turn-output',
          status: 'done',
          items: [
            {
              id: 'assistant-output',
              type: 'assistant_text' as const,
              content: '已经定位问题\n正在验证修复',
              createdAt: '2026-08-23T00:02:00Z',
            },
          ],
        },
      ],
    }))
    workbenchServices.runtimeWorkApi = {
      ...workbenchServices.runtimeWorkApi,
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
    expect(screen.getByTestId('cloud-todo-card-final-response-WEG-1')).not.toHaveTextContent(
      '旧的工具输出'
    )
    expect(getRuntimeTranscript).toHaveBeenCalledWith(
      expect.objectContaining({
        deviceId: 'local-device',
        taskId: 'runtime-in-progress',
        limit: 20,
      })
    )

    await userEvent.click(screen.getByTestId('cloud-todo-card-WEG-1'))
    expect(await screen.findByTestId('cloud-todo-detail')).toBeInTheDocument()
    expect(screen.queryByTestId('cloud-todo-card-popup-conversation-WEG-1')).not.toBeInTheDocument()
  })

  it('preloads a task conversation once per runtime task signature', async () => {
    const workbenchServices = services()
    workbenchServices.deliveryApi!.listTaskBindings = vi.fn(async () => [
      {
        id: 2,
        loop_item_id: item.id,
        task_user_id: 1,
        device_id: 'local-device',
        task_id: 'runtime-failed-preload',
        task_title: '失败的会话预加载',
        backend_task_id: null,
        linked_at: '2026-08-23T00:01:00Z',
      },
    ])
    const getRuntimeTranscript = vi.fn(async () => {
      throw new Error('thread not loaded')
    })
    workbenchServices.runtimeWorkApi = {
      ...workbenchServices.runtimeWorkApi,
      getRuntimeTranscript,
    } as WorkbenchServices['runtimeWorkApi']
    const runtimeWork = (updatedAt: number, status?: string) => ({
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
                  taskId: 'runtime-failed-preload',
                  workspacePath: '/tmp/wegent',
                  title: '失败的会话预加载',
                  runtime: 'codex' as const,
                  running: false,
                  updatedAt,
                  status,
                },
              ],
            },
          ],
        },
      ],
      chats: [],
      totalTasks: 1,
    })
    const props = {
      user: { id: 1, user_name: 'local', email: 'local@example.com' } as User,
      localProjects: [],
      services: workbenchServices,
    }
    const view = render(
      <CloudTodoWorkspace
        {...props}
        runtimeWork={runtimeWork(1_700_000_000)}
        workspaceActive={false}
      />
    )

    await userEvent.click((await screen.findAllByText('Wegent V4'))[0])
    expect(getRuntimeTranscript).not.toHaveBeenCalled()

    view.rerender(
      <CloudTodoWorkspace {...props} runtimeWork={runtimeWork(1_700_000_000)} workspaceActive />
    )
    await waitFor(() => expect(getRuntimeTranscript).toHaveBeenCalledTimes(1))

    view.rerender(
      <CloudTodoWorkspace {...props} runtimeWork={runtimeWork(1_700_000_000)} workspaceActive />
    )
    await waitFor(() => expect(getRuntimeTranscript).toHaveBeenCalledTimes(1))

    view.rerender(
      <CloudTodoWorkspace {...props} runtimeWork={runtimeWork(1_700_000_001)} workspaceActive />
    )
    await waitFor(() => expect(getRuntimeTranscript).toHaveBeenCalledTimes(2))

    view.rerender(
      <CloudTodoWorkspace
        {...props}
        runtimeWork={runtimeWork(1_700_000_001, 'completed')}
        workspaceActive
      />
    )
    await waitFor(() => expect(getRuntimeTranscript).toHaveBeenCalledTimes(3))
  })

  it('discards a stale preload response and keeps the refreshed task transcript', async () => {
    const workbenchServices = services()
    const address = { deviceId: 'local-device', taskId: 'runtime-stale-preload' }
    workbenchServices.deliveryApi!.listTaskBindings = vi.fn(async () => [
      {
        id: 2,
        loop_item_id: item.id,
        task_user_id: 1,
        device_id: address.deviceId,
        task_id: address.taskId,
        task_title: '陈旧的会话预加载',
        backend_task_id: null,
        linked_at: '2026-08-23T00:01:00Z',
      },
    ])
    let resolveTranscript!: (response: RuntimeTranscriptResponse) => void
    const transcriptPromise = new Promise<RuntimeTranscriptResponse>(resolve => {
      resolveTranscript = resolve
    })
    const getRuntimeTranscript = vi
      .fn()
      .mockReturnValueOnce(transcriptPromise)
      .mockResolvedValueOnce({
        taskId: address.taskId,
        workspacePath: '/tmp/wegent',
        runtime: 'codex',
        running: false,
        fullContent: true,
        messages: [],
        turns: [
          {
            id: 'fresh-turn',
            status: 'done',
            items: [
              {
                id: 'fresh-assistant',
                type: 'assistant_text',
                content: 'fresh response',
                createdAt: '2026-08-23T00:03:00Z',
              },
            ],
          },
        ],
      } satisfies RuntimeTranscriptResponse)
    workbenchServices.runtimeWorkApi = {
      ...workbenchServices.runtimeWorkApi,
      getRuntimeTranscript,
    } as WorkbenchServices['runtimeWorkApi']
    const runtimeWork = (updatedAt: number, status?: string) => ({
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
                  title: '陈旧的会话预加载',
                  runtime: 'codex' as const,
                  running: false,
                  updatedAt,
                  status,
                },
              ],
            },
          ],
        },
      ],
      chats: [],
      totalTasks: 1,
    })
    const props = {
      user: { id: 1, user_name: 'local', email: 'local@example.com' } as User,
      localProjects: [],
      services: workbenchServices,
      workspaceActive: true,
    }
    const view = render(<CloudTodoWorkspace {...props} runtimeWork={runtimeWork(1_700_000_000)} />)

    await userEvent.click((await screen.findAllByText('Wegent V4'))[0])
    await waitFor(() => expect(getRuntimeTranscript).toHaveBeenCalledTimes(1))

    view.rerender(
      <CloudTodoWorkspace {...props} runtimeWork={runtimeWork(1_700_000_000, 'completed')} />
    )
    await waitFor(() => expect(getRuntimeTranscript).toHaveBeenCalledTimes(2))
    resolveTranscript({
      taskId: address.taskId,
      workspacePath: '/tmp/wegent',
      runtime: 'codex',
      running: false,
      fullContent: true,
      messages: [],
      turns: [
        {
          id: 'stale-turn',
          status: 'done',
          items: [
            {
              id: 'stale-assistant',
              type: 'assistant_text',
              content: 'stale response',
              createdAt: '2026-08-23T00:02:00Z',
            },
          ],
        },
      ],
    })

    await act(async () => {
      await transcriptPromise
    })
    await waitFor(() =>
      expect(getRuntimeConversationTurns(address).map(turn => turn.id)).toEqual(['fresh-turn'])
    )
  })

  it('applies a completed preload while a newer task signature refresh is still pending', async () => {
    const workbenchServices = services()
    const address = { deviceId: 'local-device', taskId: 'runtime-terminal-preload' }
    workbenchServices.deliveryApi!.listTaskBindings = vi.fn(async () => [
      {
        id: 2,
        loop_item_id: item.id,
        task_user_id: 1,
        device_id: address.deviceId,
        task_id: address.taskId,
        task_title: '终态会话预加载',
        backend_task_id: null,
        linked_at: '2026-08-23T00:01:00Z',
      },
    ])
    let resolveCompletedTranscript!: (response: RuntimeTranscriptResponse) => void
    const completedTranscriptPromise = new Promise<RuntimeTranscriptResponse>(resolve => {
      resolveCompletedTranscript = resolve
    })
    const pendingRefresh = new Promise<RuntimeTranscriptResponse>(() => undefined)
    const getRuntimeTranscript = vi
      .fn()
      .mockReturnValueOnce(completedTranscriptPromise)
      .mockReturnValueOnce(pendingRefresh)
    workbenchServices.runtimeWorkApi = {
      ...workbenchServices.runtimeWorkApi,
      getRuntimeTranscript,
    } as WorkbenchServices['runtimeWorkApi']
    const runtimeWork = (updatedAt: number, status?: string) => ({
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
                  title: '终态会话预加载',
                  runtime: 'codex' as const,
                  running: status !== 'completed',
                  updatedAt,
                  status,
                },
              ],
            },
          ],
        },
      ],
      chats: [],
      totalTasks: 1,
    })
    const props = {
      user: { id: 1, user_name: 'local', email: 'local@example.com' } as User,
      localProjects: [],
      services: workbenchServices,
      workspaceActive: true,
    }
    const view = render(<CloudTodoWorkspace {...props} runtimeWork={runtimeWork(1_700_000_000)} />)

    await userEvent.click((await screen.findAllByText('Wegent V4'))[0])
    await waitFor(() => expect(getRuntimeTranscript).toHaveBeenCalledTimes(1))

    view.rerender(
      <CloudTodoWorkspace {...props} runtimeWork={runtimeWork(1_700_000_001, 'completed')} />
    )
    await waitFor(() => expect(getRuntimeTranscript).toHaveBeenCalledTimes(2))
    resolveCompletedTranscript({
      taskId: address.taskId,
      workspacePath: '/tmp/wegent',
      runtime: 'codex',
      running: false,
      fullContent: true,
      messages: [],
      turns: [
        {
          id: 'completed-turn',
          status: 'done',
          items: [
            {
              id: 'completed-assistant',
              type: 'assistant_text',
              content: 'completed response',
              createdAt: '2026-08-23T00:02:00Z',
            },
          ],
        },
      ],
    })

    await act(async () => {
      await completedTranscriptPromise
    })
    await waitFor(() =>
      expect(getRuntimeConversationTurns(address).map(turn => turn.id)).toEqual(['completed-turn'])
    )
  })

  it('preserves older cached turns when the board preload transcript is bounded', async () => {
    const workbenchServices = services()
    const address = { deviceId: 'local-device', taskId: 'runtime-bounded' }
    reconcileRuntimeConversationSnapshot(address, [
      {
        id: 'older-turn',
        status: 'done',
        items: [
          {
            id: 'older-assistant',
            type: 'assistant_text',
            content: 'older cached response',
            createdAt: '2026-08-22T00:02:00Z',
          },
        ],
      },
    ])
    workbenchServices.deliveryApi!.listTaskBindings = vi.fn(async () => [
      {
        id: 2,
        loop_item_id: item.id,
        task_user_id: 1,
        device_id: 'local-device',
        task_id: 'runtime-bounded',
        task_title: '保留完整会话',
        backend_task_id: null,
        linked_at: '2026-08-23T00:01:00Z',
      },
    ])
    const getRuntimeTranscript = vi.fn(async request => ({
      taskId: request.taskId,
      workspacePath: '/tmp/wegent',
      runtime: 'codex' as const,
      running: false,
      fullContent: false,
      hasMoreBefore: true,
      beforeCursor: 'older-cursor',
      messages: [],
      turns: [
        {
          id: 'newer-turn',
          status: 'done',
          items: [
            {
              id: 'newer-assistant',
              type: 'assistant_text' as const,
              content: 'newer bounded response',
              createdAt: '2026-08-23T00:02:00Z',
            },
          ],
        },
      ],
    }))
    workbenchServices.runtimeWorkApi = {
      getRuntimeTranscript,
      getRuntimeGoal: vi.fn(async () => ({ accepted: false })),
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
                      taskId: 'runtime-bounded',
                      workspacePath: '/tmp/wegent',
                      title: '保留完整会话',
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
    await waitFor(() =>
      expect(screen.getByTestId('cloud-todo-card-final-response-WEG-1')).toHaveTextContent(
        'newer bounded response'
      )
    )
    expect(getRuntimeConversationTurns(address).map(turn => turn.id)).toEqual([
      'older-turn',
      'newer-turn',
    ])
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
      expect.objectContaining({ id: '11', name: 'Wegent V4' })
    )
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

  it('keeps the local project IssueComposer flow', async () => {
    const localProject = {
      ...project,
      id: 21,
      name: 'Local Board',
      project_store: 'local' as const,
    }
    const localApi = services().deliveryApi!
    localApi.listCloudProjects = vi.fn(async () => ({ items: [localProject] }))
    localApi.listLoopItems = vi.fn(async () => ({ items: [] }))
    const cloudApi = services().deliveryApi!
    cloudApi.listCloudProjects = vi.fn(async () => ({ items: [] }))

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

    await userEvent.click(await screen.findByTestId('cloud-sidebar-project-21'))
    await userEvent.click(screen.getByTestId('cloud-todo-add'))

    expect(screen.getByTestId('workspace-issue-composer')).toBeVisible()
    expect(screen.getByTestId('workspace-issue-input')).toBeVisible()
    expect(screen.queryByTestId('cloud-todo-detail')).not.toBeInTheDocument()
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
    localServices.localProjectChatAgentApi = {
      list: vi.fn(async () => []),
      create: vi.fn(),
      update: vi.fn(),
    } as never
    const localApi = localServices.deliveryApi!
    localApi.listCloudProjects = vi.fn(async () => ({
      items: [localProject, { ...localProject, id: 'default-work-items', name: 'My tasks' }],
    }))
    localApi.listLoopItems = vi.fn(async () => ({ items: [localItem] }))
    const cloudServices = services()
    const cloudApi = cloudServices.deliveryApi!
    cloudApi.listCloudProjects = vi.fn(() => new Promise(() => undefined))
    const workbenchServices = {
      ...localServices,
      agentResourceApi: {
        listModels: vi.fn(async () => []),
        listSkills: vi.fn(async () => []),
        createAgent: vi.fn(),
        getAgent: vi.fn(),
        updateAgent: vi.fn(),
      } as unknown as WorkbenchServices['agentResourceApi'],
      deliveryApi: cloudApi,
      sharedWorkspaceApi: undefined,
      projectSpaceApis: {
        local: localApi,
        cloud: cloudApi,
        defaultLocation: 'local' as const,
      },
      projectSpaceDetailServices: {
        local: {
          deliveryApi: localApi,
          projectChatAgentApi: localServices.localProjectChatAgentApi,
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
    expect(
      [
        'cloud-project-board-view',
        'cloud-project-table-view',
        'cloud-project-files-view',
        'cloud-project-manage-view',
      ].map(testId => screen.getByTestId(testId).textContent)
    ).toEqual(['看板', '表格', '文件', '项目设置'])
    await userEvent.click(screen.getByTestId('cloud-project-files-view'))
    expect(await screen.findByTestId('cloud-files-upload')).toBeInTheDocument()
    await userEvent.click(screen.getByTestId('cloud-project-manage-view'))
    expect
      .soft(
        Array.from(
          screen
            .getByTestId('project-settings-shell')
            .querySelectorAll<HTMLButtonElement>('aside nav button')
        ).map(button => button.textContent)
      )
      .toEqual(['基本信息', '协作成员', '执行环境', '自动处理'])
    await userEvent.click(screen.getByTestId('cloud-project-settings-participants'))
    expect(screen.getByTestId('collaboration-participants-tab-agents')).toHaveAttribute(
      'aria-selected',
      'true'
    )
    expect(
      [
        'collaboration-participants-tab-agents',
        'collaboration-participants-tab-members',
        'collaboration-participants-tab-groups',
      ].map(testId => screen.getByTestId(testId).textContent)
    ).toEqual(['智能体', '项目成员', '协作小组'])
    await userEvent.click(screen.getByTestId('collaboration-participants-tab-groups'))
    expect(await screen.findByTestId('collaboration-group-open-create')).toBeInTheDocument()
    await userEvent.click(screen.getByTestId('collaboration-participants-tab-agents'))
    expect(await screen.findByTestId('project-agent-config')).toBeInTheDocument()
    await userEvent.click(await screen.findByTestId('project-agent-add'))
    expect(await screen.findByTestId('cloud-project-chat-agent-editor')).toBeInTheDocument()
    expect(screen.queryByTestId('wework-agent-resource-creator')).not.toBeInTheDocument()
    expect(screen.queryByTestId('project-agent-dialog')).not.toBeInTheDocument()
    expect(screen.queryByTestId('project-agent-mode-existing')).not.toBeInTheDocument()
    expect(screen.queryByTestId('project-agent-mode-create')).not.toBeInTheDocument()
    expect(screen.queryByTestId('project-agent-wegent-team')).not.toBeInTheDocument()
    expect(screen.queryByTestId('project-agent-wegent-create')).not.toBeInTheDocument()
    expect(screen.queryByTestId('project-agent-open-create')).not.toBeInTheDocument()
    expect(screen.queryByTestId('project-agent-execution-environment')).not.toBeInTheDocument()
    await userEvent.click(screen.getByTestId('cloud-project-chat-agent-cancel'))
    await userEvent.click(screen.getByTestId('cloud-project-settings-automatic-processing'))
    expect(await screen.findByTestId('automatic-processing')).toBeInTheDocument()

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
    expect(screen.getByTestId('project-settings-shell')).toBeInTheDocument()

    view.rerender(
      <CloudTodoWorkspace
        user={user}
        localProjects={[]}
        services={workbenchServices}
        activeProjectRef={{ projectStore: 'backend', projectId: controlledProject.id }}
      />
    )

    expect(screen.getByTestId('project-settings-shell')).toBeInTheDocument()

    view.rerender(
      <CloudTodoWorkspace
        user={user}
        localProjects={[]}
        services={workbenchServices}
        activeProjectRef={null}
      />
    )

    await waitFor(() =>
      expect(screen.queryByTestId('project-settings-shell')).not.toBeInTheDocument()
    )
    expect(screen.getByTestId('cloud-project-unavailable')).toBeInTheDocument()
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

    await userEvent.click(await screen.findByTestId('cloud-project-manage-view'))
    await userEvent.click(screen.getByTestId('cloud-project-settings-participants'))
    await userEvent.click(screen.getByTestId('collaboration-participants-tab-groups'))
    await userEvent.click(await screen.findByTestId('collaboration-group-open-create'))
    expect(await screen.findByTestId('collaboration-group-form')).toBeInTheDocument()

    view.rerender(
      <CloudTodoWorkspace
        {...props}
        activeProjectRef={{ projectStore: 'backend', projectId: controlledProject.id }}
      />
    )

    expect(screen.getByTestId('collaboration-group-form')).toBeInTheDocument()
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
      expect(workbenchServices.deliveryApi!.updateCloudProject).toHaveBeenCalledWith('11', {
        name: 'Wegent Next',
        version: 1,
      })
    )
    expect((await screen.findAllByText('Wegent Next')).length).toBeGreaterThan(0)

    await userEvent.click(screen.getByTestId('cloud-sidebar-project-more-11'))
    await userEvent.click(screen.getByTestId('cloud-sidebar-archive-project-11'))
    await userEvent.click(screen.getByTestId('cloud-project-archive-confirm'))

    await waitFor(() =>
      expect(workbenchServices.deliveryApi!.archiveCloudProject).toHaveBeenCalledWith('11', 2)
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
    expect(screen.getByTestId('cloud-project-ask-ai')).toHaveTextContent('问AI')
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
    await screen.findByTestId('cloud-todo-card-WEG-1')
    await openIssueFromBoard()

    expect(screen.getByTestId('cloud-todo-panel-stack')).toHaveAttribute(
      'data-conversation-open',
      'false'
    )
    await expandIssueExecutionDetails()
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
    await expandIssueExecutionDetails()
    await userEvent.click(await screen.findByTestId('cloud-todo-open-task-conversation-1'))
    await userEvent.click(screen.getByTestId('mock-update-runtime-address'))
    await userEvent.click(screen.getByTestId('ai-chat-modal-back'))
    expect(screen.queryByTestId('ai-chat-modal')).not.toBeInTheDocument()
    expect(screen.getByTestId('cloud-todo-panel-stack')).toHaveAttribute(
      'data-conversation-open',
      'false'
    )
    await expandIssueExecutionDetails()
    await userEvent.click(await screen.findByTestId('cloud-todo-open-task-conversation-1'))
    await userEvent.click(screen.getByTestId('ai-chat-modal-close'))
    expect(screen.queryByTestId('ai-chat-modal')).not.toBeInTheDocument()
    expect(screen.queryByTestId('cloud-todo-detail')).not.toBeInTheDocument()
  }, 10_000)

  it('opens the existing personal task from an Issue dispatch notification', async () => {
    const workbenchServices = services()
    const onOpenRuntimeTask = vi.fn()

    render(
      <CloudTodoWorkspace
        user={{ id: 1, user_name: 'local', email: 'local@example.com' } as User}
        localProjects={[]}
        services={workbenchServices}
        embedded
        activeProjectRef={{ projectStore: 'backend', projectId: String(project.id) }}
        onOpenRuntimeTask={onOpenRuntimeTask}
      />
    )
    await screen.findByTestId('cloud-project-header')

    await act(async () => {
      await notificationActionMocks.action?.({
        projectId: String(project.id),
        itemId: item.id,
        issueId: 'parent-issue',
        dispatchTaskId: 'human-assignment-1',
        humanAssignmentId: 'human-assignment-1',
        dispatchId: 'dispatch-1',
        roundId: 'round-1',
        assignmentId: 'collect-cpu',
        taskTitle: 'Collect CPU evidence',
        instructions: 'Collect read-only CPU evidence and deliver it.',
        workflowStageId: 'investigate',
        idempotencyKey: 'human-assignment:human-assignment-1',
      })
    })

    expect(workbenchServices.deliveryApi!.listTaskBindings).toHaveBeenCalledWith(item.id)
    expect(onOpenRuntimeTask).toHaveBeenCalledWith({
      deviceId: 'local-device',
      taskId: 'runtime-248868498',
    })
  })

  it('creates an unbound personal task only once for the dispatch idempotency key', async () => {
    const workbenchServices = services()
    vi.mocked(workbenchServices.deliveryApi!.listTaskBindings).mockResolvedValue([])
    const onOpenRuntimeTask = vi.fn()
    const action = {
      projectId: String(project.id),
      itemId: item.id,
      issueId: 'parent-issue',
      dispatchTaskId: 'human-assignment-2',
      humanAssignmentId: 'human-assignment-2',
      dispatchId: 'dispatch-1',
      roundId: 'round-1',
      assignmentId: 'review-cpu',
      taskTitle: 'Review CPU evidence',
      instructions: 'Review the CPU evidence and deliver a verdict.',
      workflowStageId: 'review',
      idempotencyKey: 'human-assignment:human-assignment-2',
    }

    render(
      <CloudTodoWorkspace
        user={{ id: 1, user_name: 'local', email: 'local@example.com' } as User}
        localProjects={[{ id: 91, name: '运营工作区', tasks: [] }]}
        services={workbenchServices}
        embedded
        activeProjectRef={{ projectStore: 'backend', projectId: String(project.id) }}
        onOpenRuntimeTask={onOpenRuntimeTask}
      />
    )
    await screen.findByTestId('cloud-project-header')

    await act(async () => {
      await notificationActionMocks.action?.(action)
      await notificationActionMocks.action?.(action)
    })

    expect(screen.getAllByTestId('mock-start-background-task')).toHaveLength(1)
    await userEvent.click(screen.getByTestId('mock-start-background-task'))
    await waitFor(() =>
      expect(workbenchServices.deliveryApi!.bindTask).toHaveBeenCalledWith(
        item.id,
        { deviceId: 'local-device', taskId: 'runtime-created' },
        'Review CPU evidence',
        null,
        {
          humanAssignmentId: 'human-assignment-2',
          dispatchId: 'dispatch-1',
          dispatchRoundId: 'round-1',
          assignmentId: 'review-cpu',
        }
      )
    )
    expect(onOpenRuntimeTask).not.toHaveBeenCalled()
  })

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
    await screen.findByTestId('cloud-todo-card-WEG-1')
    await openIssueFromBoard()
    await userEvent.click(screen.getByTestId('cloud-todo-create-task'))
    await userEvent.click(screen.getByTestId('mock-create-runtime-task'))
    await waitFor(() => expect(workbenchServices.deliveryApi!.bindTask).toHaveBeenCalledTimes(1))

    await userEvent.click(screen.getByTestId('ai-chat-modal-close'))
    await openIssueFromBoard()
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

  it('preserves the selected model when a new runtime task becomes the task conversation', async () => {
    const workbenchServices = services()

    render(
      <CloudTodoWorkspace
        user={{ id: 1, user_name: 'local', email: 'local@example.com' } as User}
        localProjects={[{ id: 91, name: '运营工作区', tasks: [] }]}
        services={workbenchServices}
      />
    )

    await userEvent.click((await screen.findAllByText('Wegent V4'))[0])
    await screen.findByTestId('cloud-todo-card-WEG-1')
    await openIssueFromBoard()
    await userEvent.click(screen.getByTestId('cloud-todo-create-task'))
    await userEvent.click(screen.getByTestId('mock-create-runtime-task-with-model'))

    await waitFor(() =>
      expect(screen.getByTestId('ai-chat-modal')).toHaveAttribute(
        'data-runtime-task-id',
        'runtime-created-with-model'
      )
    )
    expect(screen.getByTestId('ai-chat-modal')).toHaveAttribute(
      'data-model-name',
      'deepseek-v4-pro-responses'
    )
  }, 10_000)

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
    expect(boardCard).toBeInTheDocument()
    await openIssueFromBoard()

    expect(await screen.findByTestId('cloud-todo-detail')).toBeInTheDocument()
    await expandIssueExecutionDetails()
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
    await screen.findByTestId('cloud-todo-card-WEG-1')
    await openIssueFromBoard()
    await userEvent.click(screen.getByTestId('cloud-todo-create-task'))

    expect(await screen.findByTestId('cloud-todo-detail')).toBeInTheDocument()
    expect(screen.getByTestId('cloud-todo-panel-stack')).toHaveAttribute(
      'data-conversation-open',
      'true'
    )
    expect(screen.getByTestId('ai-chat-modal')).toHaveAttribute('data-task-id', item.id)
    expect(screen.queryByTestId('mock-start-background-task')).not.toBeInTheDocument()
  })

  it('uses the prepared project environment when starting a task from the Issue detail', async () => {
    const preparedProject = {
      ...project,
      execution_environment: {
        repositories: [],
        setup_steps: [],
        devices: {
          'project-runtime-device': {
            status: 'ready' as const,
            workspace_path: '/srv/projects/wegent-v4',
            prepared_at: '2026-09-21T08:00:00Z',
          },
        },
      },
    }
    const workbenchServices = services()
    workbenchServices.deliveryApi!.listCloudProjects = vi.fn(async () => ({
      items: [preparedProject],
    }))
    workbenchServices.deliveryApi!.listLoopItems = vi.fn(async () => ({
      items: [{ ...item, status: 'pending' as const }],
    }))
    workbenchServices.deliveryApi!.listTaskBindings = vi.fn(async () => [])

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

    expect(screen.getByTestId('ai-chat-modal')).toHaveAttribute(
      'data-task-device-id',
      'project-runtime-device'
    )
    expect(screen.getByTestId('ai-chat-modal')).toHaveAttribute(
      'data-task-workspace-path',
      '/srv/projects/wegent-v4'
    )
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
    await screen.findByTestId('cloud-todo-card-WEG-1')
    await openIssueFromBoard()

    expect(await screen.findByTestId('cloud-todo-detail')).toBeInTheDocument()
    expect(screen.getByTestId('cloud-todo-detail').parentElement).toHaveClass(
      'task-detail-workspace-panel-shell'
    )
    expect(screen.getByTestId('cloud-todo-detail')).toHaveClass('todo-floating-panel-surface')
    expect(screen.getByTestId('cloud-todo-detail-dismiss-layer')).toHaveClass('todo-panel-backdrop')

    await expandIssueExecutionDetails()
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
    expect(screen.getByTestId('cloud-todo-card-WEG-1').closest('article')).toHaveTextContent(
      '负责人'
    )
    expect(screen.getByTestId('cloud-todo-card-assignee-WEG-1')).toHaveTextContent('hongyu9')
    expect(screen.getByTestId('cloud-todo-card-WEG-1')).toHaveTextContent('高')
    expect(screen.getAllByText('发布').length).toBeGreaterThan(0)

    await userEvent.click(screen.getByTestId('cloud-board-settings'))
    expect(screen.getByTestId('project-board-settings-dialog')).toBeInTheDocument()
    expect(screen.getByTestId('cloud-project-board-layout-settings')).toBeInTheDocument()
    await userEvent.click(screen.getByTestId('cloud-board-display-menu'))
    expect(screen.getByTestId('cloud-project-card-display-settings')).toBeInTheDocument()
    await userEvent.click(screen.getByTestId('cloud-board-display-assignee'))
    await waitFor(() =>
      expect(workbenchServices.deliveryApi!.updateCloudProject).toHaveBeenCalledWith(
        '11',
        expect.objectContaining({
          card_display: expect.objectContaining({ show_assignee: false }),
        })
      )
    )
    await userEvent.click(screen.getByTestId('project-board-settings-close'))
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

    expect(
      (await screen.findByTestId('cloud-todo-card-WEG-1')).closest('article')
    ).toHaveTextContent('未指定')
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
    expect(screen.getByTestId('cloud-todo-card-WEG-1').closest('article')).not.toHaveTextContent(
      '未指定'
    )
    expect(screen.getByTestId('cloud-todo-card-WEG-1').closest('article')).toHaveTextContent(
      '发布机器人'
    )
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
    expect(screen.getByTestId('cloud-todo-card-WEG-1').closest('article')).not.toHaveTextContent(
      '未指定'
    )
    expect(screen.getByTestId('cloud-todo-card-WEG-1').closest('article')).toHaveTextContent(
      '发布机器人'
    )
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

  it('clears previous project items and keeps the active workspace on its loading animation', async () => {
    const otherProject = {
      ...project,
      id: '12',
      project_key: 'OTHER',
      name: 'Other Project',
    }
    const otherItem = {
      ...item,
      id: 'OTHER-1',
      cloud_project_id: '12',
      title: 'Other project task',
    }
    const resolveBoardFetches = new Map<string, () => void>()
    const workbenchServices = services()
    workbenchServices.deliveryApi!.listCloudProjects = vi.fn(async () => ({
      items: [project, otherProject],
    }))
    const selectedProjectIds = new Set<string>()
    workbenchServices.deliveryApi!.listLoopItems = vi.fn(async (projectId: string) => {
      // Keep each project's first snapshot pending so the switching skeleton
      // can be asserted while home preloading and board loading share requests.
      if (!selectedProjectIds.has(projectId)) {
        selectedProjectIds.add(projectId)
        await new Promise<void>(resolve => {
          resolveBoardFetches.set(projectId, () => resolve())
        })
      }
      return { items: projectId === '12' ? [otherItem] : [item] }
    })
    render(
      <CloudTodoWorkspace
        user={{ id: 1, user_name: 'local', email: 'local@example.com' } as User}
        localProjects={[]}
        services={workbenchServices}
        startupActive
      />
    )

    await userEvent.click((await screen.findAllByText('Wegent V4'))[0])
    await waitFor(() =>
      expect(screen.getByTestId('cloud-todo-startup-animation')).toBeInTheDocument()
    )
    expect(screen.queryByTestId('cloud-todo-board-loading')).not.toBeInTheDocument()
    expect(screen.queryByTestId('cloud-todo-card-WEG-1')).not.toBeInTheDocument()
    resolveBoardFetches.get(project.id)?.()
    expect(await screen.findByTestId('cloud-todo-card-WEG-1')).toBeInTheDocument()
    expect(screen.queryByTestId('cloud-todo-startup-animation')).not.toBeInTheDocument()
    expect(screen.queryByTestId('cloud-todo-board-loading')).not.toBeInTheDocument()

    await userEvent.click(screen.getAllByText('Other Project')[0])

    // The previous project's cards disappear immediately and the loading
    // animation stays until the new project's items resolve.
    expect(screen.queryByTestId('cloud-todo-card-WEG-1')).not.toBeInTheDocument()
    expect(screen.getByTestId('cloud-todo-startup-animation')).toBeInTheDocument()
    expect(screen.queryByTestId('cloud-todo-board-loading')).not.toBeInTheDocument()

    resolveBoardFetches.get(otherProject.id)?.()
    expect(await screen.findByTestId('cloud-todo-card-OTHER-1')).toBeInTheDocument()
    expect(screen.queryByTestId('cloud-todo-startup-animation')).not.toBeInTheDocument()
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
    await screen.findByTestId('cloud-todo-card-WEG-1')
    await openIssueFromBoard()
    await userEvent.click(screen.getByTestId('cloud-todo-detail-parent'))
    await userEvent.click(await screen.findByTestId('cloud-todo-detail-parent-option-WEG-2'))
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
    await screen.findByTestId('cloud-todo-card-WEG-1')
    await openIssueFromBoard()

    expect(await screen.findByText('任务详情')).toBeInTheDocument()
    await expandIssueExecutionDetails()
    await openIssueMoreProperties()
    expect(screen.getAllByText('Implement cloud MCP').length).toBeGreaterThan(0)
    expect(screen.getAllByText('Implement cloud delivery').length).toBeGreaterThan(0)
    expect(screen.getByTitle('local')).toBeInTheDocument()
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
    await screen.findByTestId('cloud-todo-card-WEG-1')
    await openIssueFromBoard()

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

    await userEvent.click(await screen.findByTestId('cloud-sidebar-project-11'))
    await userEvent.click(screen.getByTestId('cloud-sidebar-project-more-11'))
    expect(screen.getByTestId('cloud-sidebar-project-menu-11')).toBeInTheDocument()
    await userEvent.click(screen.getByTestId('cloud-project-header'))
    expect(screen.queryByTestId('cloud-sidebar-project-menu-11')).not.toBeInTheDocument()

    await userEvent.click(screen.getByTestId('cloud-sidebar-project-more-11'))
    await userEvent.keyboard('{Escape}')
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
    await screen.findByTestId('cloud-todo-card-WEG-1')
    await openIssueFromBoard()
    await openIssueMoreProperties()
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
    expect(await screen.findByTitle('alice')).toBeInTheDocument()
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
    await expandIssueExecutionDetails()
    expect(screen.queryByTestId('cloud-todo-detail-add-child')).not.toBeInTheDocument()
    expect(screen.queryByTestId('cloud-todo-children')).not.toBeInTheDocument()
    expect(screen.getByTestId('cloud-todo-tasks')).toHaveTextContent('执行任务')
    expect(screen.getByTestId('cloud-todo-execution-task-count')).toHaveTextContent('1')
    expect(screen.getByTestId('cloud-todo-open-child-task-WEG-2')).toHaveTextContent('实现快速排序')
    expect(screen.getByTestId('cloud-todo-open-child-task-WEG-2')).toHaveTextContent('开发机器人')

    await userEvent.click(screen.getByTestId('cloud-todo-open-child-task-WEG-2'))
    expect(screen.getByTestId('cloud-todo-detail-title')).toHaveValue('实现快速排序')
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
    await screen.findByTestId('cloud-todo-card-WEG-1')
    await openIssueFromBoard()
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
    await screen.findByTestId('cloud-todo-card-WEG-1')
    await openIssueFromBoard()

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
    await screen.findByTestId('cloud-todo-card-WEG-1')
    await openIssueFromBoard()
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

    await userEvent.click(await screen.findByTestId('cloud-sidebar-project-11'))
    expect(screen.getByTestId('cloud-todo-sidebar-chrome-controls')).toHaveClass('gap-1')
    await userEvent.click(screen.getByTestId('cloud-todo-collapse-sidebar'))
    expect(screen.queryByTestId('cloud-todo-collapsed-app-current')).not.toBeInTheDocument()
    expect(screen.getByTestId('cloud-todo-collapsed-chrome-controls')).toHaveClass(
      'electron-titlebar-interactive-region',
      'pointer-events-auto',
      'left-2'
    )
    expect(
      screen.getByTestId('cloud-project-header').querySelector('.electron-titlebar-drag-region')
    ).toHaveClass('left-12')

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
    expect(screen.getByTestId('cloud-project-location-local')).toHaveAttribute(
      'aria-pressed',
      'false'
    )
    expect(screen.queryByTestId('cloud-project-task-provider-local')).not.toBeInTheDocument()
    await userEvent.click(screen.getByTestId('collaboration-project-create-advanced'))
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
        default_issue_security: 'open',
      })
    )
    expect(onActiveProjectChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ id: '12', name: 'Wegent Test', location: 'cloud' })
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
    await userEvent.click(screen.getByTestId('collaboration-project-create-advanced'))
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
    expect(screen.getByTestId('cloud-project-location-local')).toHaveAttribute(
      'aria-pressed',
      'false'
    )
    await userEvent.type(screen.getByTestId('cloud-project-name'), 'Cloud GitLab board')
    await userEvent.click(screen.getByTestId('collaboration-project-create-advanced'))
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
        default_issue_security: 'open',
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
    await userEvent.click(screen.getByTestId('collaboration-project-create-advanced'))
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

    fireEvent.click((await screen.findAllByText('Wegent V4'))[0])
    fireEvent.click(await screen.findByTestId('cloud-project-manage-view'))
    expect(screen.getByTestId('project-settings-shell')).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: '基本信息' })).toBeInTheDocument()
    fireEvent.click(screen.getByTestId('cloud-project-settings-participants'))
    expect(screen.getByTestId('collaboration-participants-tab-agents')).toHaveAttribute(
      'aria-selected',
      'true'
    )
    fireEvent.click(screen.getByTestId('collaboration-participants-tab-members'))
    expect(await screen.findByTestId('cloud-project-member-1')).toBeInTheDocument()
    expect(screen.getByTestId('cloud-project-member-capability-heading')).toHaveTextContent(
      '职责与能力'
    )
    expect(
      screen.getByText(
        '管理成员访问和项目角色。填写职责与能力后会自动保存，AI 托管会据此选择合适的负责人。'
      )
    ).toBeInTheDocument()
    const capabilityInput = screen.getByTestId('cloud-project-member-capability-2')
    expect(capabilityInput).toHaveAttribute('placeholder', '例如：前端开发、产品验收')
    fireEvent.change(capabilityInput, { target: { value: '前端实现与交互验收' } })
    fireEvent.blur(capabilityInput)
    await waitFor(() =>
      expect(workbenchServices.deliveryApi?.updateCloudProjectMember).toHaveBeenCalledWith(
        project.id,
        2,
        { capability_description: '前端实现与交互验收' }
      )
    )
    fireEvent.click(screen.getByTestId('cloud-project-board-view'))

    fireEvent.click(screen.getByTestId('cloud-project-task-search-toggle'))
    fireEvent.change(screen.getByTestId('cloud-project-task-search-input'), {
      target: { value: 'missing' },
    })
    expect(screen.getByText('没有匹配的任务')).toBeInTheDocument()
    expect(screen.getByTestId('cloud-todo-card-WEG-1')).toBeInTheDocument()
  })

  it('uses collaboration groups for a cloud-owned project with local task storage', async () => {
    const workbenchServices = services({
      projectChatAgentApi: {
        list: vi.fn(async () => [
          {
            id: 'local-agent',
            projectId: String(project.id),
            name: 'Local agent',
            runtime: 'codex',
            model: null,
            systemPrompt: '',
            status: 'active',
            version: 1,
            createdAt: '',
            updatedAt: '',
          },
        ]),
        create: vi.fn(),
        update: vi.fn(),
      } as never,
    })
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
    await userEvent.click(screen.getByTestId('cloud-project-manage-view'))
    await userEvent.click(screen.getByTestId('cloud-project-settings-participants'))
    await userEvent.click(screen.getByTestId('collaboration-participants-tab-groups'))
    expect(screen.getByTestId('collaboration-participants-tab-groups')).toHaveAttribute(
      'aria-selected',
      'true'
    )
    expect(screen.getByTestId('collaboration-participants-panel-groups')).toBeInTheDocument()
    expect(screen.queryByText('项目管理者')).not.toBeInTheDocument()
    expect(screen.queryByTestId('automatic-processing')).not.toBeInTheDocument()
    await userEvent.click(await screen.findByTestId('collaboration-group-open-create'))
    expect(await screen.findByTestId('collaboration-group-form')).toBeInTheDocument()
    expect(screen.queryByTestId('project-automation-policy')).not.toBeInTheDocument()
  })

  it('hides automatic processing settings for DingTalk AI Table project spaces', async () => {
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
    expect(screen.queryByText('自动化')).not.toBeInTheDocument()
    await userEvent.click(screen.getByTestId('cloud-project-manage-view'))
    expect(screen.getByTestId('cloud-project-settings-participants')).toBeInTheDocument()
    expect(
      screen.queryByTestId('cloud-project-settings-automatic-processing')
    ).not.toBeInTheDocument()
  })

  it('uses shared project view permissions for restricted analysts', async () => {
    const workbenchServices = services()
    const listCloudProjects = workbenchServices.deliveryApi!.listCloudProjects as ReturnType<
      typeof vi.fn
    >
    listCloudProjects.mockImplementation(async () => ({
      items: [{ ...project, access_role: 'RestrictedAnalyst' as const }],
    }))

    render(
      <CloudTodoWorkspace
        user={{ id: 1, user_name: 'local', email: 'local@example.com' } as User}
        localProjects={[]}
        services={workbenchServices}
      />
    )

    await userEvent.click((await screen.findAllByText('Wegent V4'))[0])
    expect(screen.getByTestId('cloud-project-board-view')).toBeInTheDocument()
    expect(screen.queryByTestId('cloud-project-files-view')).not.toBeInTheDocument()
    expect(screen.queryByTestId('cloud-project-manage-view')).not.toBeInTheDocument()
  })

  it('preserves owner project views when a backend payload omits access_role', async () => {
    const workbenchServices = services()
    const listCloudProjects = workbenchServices.deliveryApi!.listCloudProjects as ReturnType<
      typeof vi.fn
    >
    listCloudProjects.mockImplementation(async () => ({
      items: [{ ...project, access_role: undefined }],
    }))

    render(
      <CloudTodoWorkspace
        user={{ id: 1, user_name: 'local', email: 'local@example.com' } as User}
        localProjects={[]}
        services={workbenchServices}
      />
    )

    await userEvent.click((await screen.findAllByText('Wegent V4'))[0])
    expect(screen.getByTestId('cloud-project-board-view')).toBeInTheDocument()
    expect(screen.getByTestId('cloud-project-table-view')).toBeInTheDocument()
    expect(screen.getByTestId('cloud-project-files-view')).toBeInTheDocument()
    expect(screen.getByTestId('cloud-project-manage-view')).toBeInTheDocument()
    await userEvent.click(screen.getByTestId('cloud-project-manage-view'))
    expect(screen.getByTestId('cloud-project-settings-project')).toBeInTheDocument()
    expect(screen.getByTestId('cloud-project-settings-participants')).toBeInTheDocument()
    expect(screen.getByTestId('cloud-project-settings-automatic-processing')).toBeInTheDocument()
  })

  it('keeps project views restricted when a non-owner payload omits access_role', async () => {
    const workbenchServices = services()
    const listCloudProjects = workbenchServices.deliveryApi!.listCloudProjects as ReturnType<
      typeof vi.fn
    >
    listCloudProjects.mockImplementation(async () => ({
      items: [{ ...project, access_role: undefined }],
    }))

    render(
      <CloudTodoWorkspace
        user={{ id: 2, user_name: 'member', email: 'member@example.com' } as User}
        localProjects={[]}
        services={workbenchServices}
      />
    )

    await userEvent.click((await screen.findAllByText('Wegent V4'))[0])
    expect(screen.queryByTestId('cloud-project-files-view')).not.toBeInTheDocument()
    expect(screen.queryByTestId('cloud-project-manage-view')).not.toBeInTheDocument()
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
      expect(workbenchServices.deliveryApi!.updateCloudProject).toHaveBeenCalledWith('11', {
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
      expect(workbenchServices.deliveryApi!.updateCloudProject).toHaveBeenCalledWith('11', {
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
    expect(screen.getByTestId('workspace-issue-composer')).toHaveTextContent('创建 Issue')
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

  it('creates a top-level cloud issue from the Wework composer through the shared API', async () => {
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
    expect(screen.getByTestId('workspace-issue-composer')).toBeVisible()
    await user.type(screen.getByTestId('workspace-issue-input'), 'Release readiness')
    await user.click(screen.getByTestId('workspace-issue-submit'))

    await waitFor(() =>
      expect(workbenchServices.deliveryApi.createLoopItem).toHaveBeenCalledWith('11', {
        title: 'Release readiness',
        description: 'Release readiness',
        status: 'inbox',
        parent_id: null,
      })
    )
    expect(telemetryMocks.track).toHaveBeenCalledWith('board_item_created', {
      has_parent: false,
      source: 'cloud',
    })
  })

  it('creates a human-assigned cloud issue without a follow-up assignment race', async () => {
    const user = userEvent.setup()
    const workbenchServices = services()
    const createLoopItem = vi.fn(async (_projectId, values) => ({
      ...item,
      id: 'WEG-3',
      title: values.title,
      description: values.description ?? '',
      assignee_user_id: values.assignee_user_id ?? null,
      parent_id: null,
    }))
    const assignLoopItem = vi.fn(async () => ({ ...item, id: 'WEG-3' }))
    workbenchServices.deliveryApi!.listLoopItems = vi.fn(async () => ({ items: [item] }))
    workbenchServices.deliveryApi!.createLoopItem = createLoopItem
    workbenchServices.deliveryApi!.assignLoopItem = assignLoopItem
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
    await user.click(screen.getByTestId('workspace-issue-expand'))
    await user.type(screen.getByTestId('workspace-issue-title'), 'Human-owned Issue')
    await user.selectOptions(screen.getByTestId('workspace-issue-assignee'), '1')
    await user.click(screen.getByTestId('workspace-issue-fullscreen-submit'))

    await waitFor(() =>
      expect(createLoopItem).toHaveBeenCalledWith('11', {
        title: 'Human-owned Issue',
        description: '',
        status: 'inbox',
        assignee_user_id: 1,
        notify_assignee: true,
        parent_id: null,
      })
    )
    expect(assignLoopItem).not.toHaveBeenCalled()
  })

  it('starts the Runtime extension after creating through the Wework composer', async () => {
    const user = userEvent.setup()
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

    await user.click((await screen.findAllByText('Wegent V4'))[0])
    await user.click(screen.getByTestId('cloud-todo-add'))
    await user.click(screen.getByTestId('workspace-create-task-tab'))
    await user.click(screen.getByTestId('workspace-issue-input'))
    await user.paste('Start release work')
    await user.click(screen.getByTestId('workspace-issue-submit'))

    await waitFor(() =>
      expect(workbenchServices.deliveryApi.createLoopItem).toHaveBeenCalledWith('11', {
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

  it('fails closed when dragging a cloud Issue without can_edit', async () => {
    const readOnlyItem = {
      ...item,
      status: 'inbox' as const,
      can_edit: undefined,
      project_store: 'backend' as const,
    }
    const workbenchServices = services()
    workbenchServices.deliveryApi!.listLoopItems = vi.fn(async () => ({
      items: [readOnlyItem],
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
    fireEvent.click(screen.getByTestId('mock-dnd-drag-to-pending'))

    expect(workbenchServices.deliveryApi!.updateLoopItem).not.toHaveBeenCalled()
    expect(screen.queryByTestId('ai-chat-modal')).not.toBeInTheDocument()
  })

  it('forces a newly created runtime task when pending work is dragged into execution', async () => {
    const pendingItem = { ...item, status: 'pending' as const }
    const workbenchServices = services()
    workbenchServices.deliveryApi!.listLoopItems = vi.fn(async () => ({ items: [pendingItem] }))
    workbenchServices.deliveryApi!.listTaskBindings = vi.fn(async () => [])
    workbenchServices.deliveryApi!.getLoopItem = vi.fn(async () => pendingItem)

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

    await waitFor(() =>
      expect(workbenchServices.deliveryApi!.updateLoopItem).toHaveBeenCalledWith('WEG-1', {
        version: pendingItem.version,
        status: 'in_progress',
      })
    )
    expect(screen.getByTestId('mock-start-background-task')).toHaveAttribute(
      'data-task-request',
      JSON.stringify({
        runtime: 'codex',
        message: 'Implement cloud MCP',
        forceStart: true,
      })
    )
  })

  it('force starts an existing queued runtime task dragged from pending into execution', async () => {
    const pendingItem = { ...item, status: 'pending' as const }
    const forceStartRuntimeTask = vi.fn().mockResolvedValue(undefined)
    const workbenchServices = services()
    workbenchServices.deliveryApi!.listLoopItems = vi.fn(async () => ({ items: [pendingItem] }))
    workbenchServices.deliveryApi!.getLoopItem = vi.fn(async () => pendingItem)
    const workbench = {
      forceStartRuntimeTask,
      projectChat: { requestCatalogs: vi.fn() },
    } as unknown as WorkbenchContextValue

    render(
      <WorkbenchContext.Provider value={workbench}>
        <CloudTodoWorkspace
          user={{ id: 1, user_name: 'local', email: 'local@example.com' } as User}
          localProjects={[]}
          runtimeWork={{
            projects: [
              {
                project: { id: 91, name: 'Runtime project' },
                deviceWorkspaces: [
                  {
                    deviceId: 'local-device',
                    workspacePath: '/tmp/runtime-project',
                    available: true,
                    tasks: [
                      {
                        taskId: 'runtime-248868498',
                        workspacePath: '/tmp/runtime-project',
                        title: pendingItem.title,
                        runtime: 'codex',
                        status: 'queued',
                        running: false,
                        runtimeHandle: {
                          cloudProjectId: String(project.id),
                          loopItemId: pendingItem.id,
                        },
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
      </WorkbenchContext.Provider>
    )

    await userEvent.click((await screen.findAllByText('Wegent V4'))[0])
    await screen.findByTestId('cloud-todo-card-WEG-1')
    fireEvent.click(screen.getByTestId('mock-dnd-drag-to-in-progress'))

    await waitFor(() =>
      expect(forceStartRuntimeTask).toHaveBeenCalledWith(
        expect.objectContaining({
          deviceId: 'local-device',
          taskId: 'runtime-248868498',
        })
      )
    )
    expect(screen.queryByTestId('ai-chat-modal')).not.toBeInTheDocument()
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
    await screen.findByTestId('cloud-todo-card-WEG-1')
    await openIssueFromBoard()
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
    const groupMenu = screen.getByTestId('cloud-board-group-menu')
    expect(groupMenu.parentElement).toBe(document.body)
    expect(groupMenu.closest('[data-testid="cloud-board-toolbar"]')).toBeNull()
    fireEvent.scroll(groupMenu)
    expect(screen.getByTestId('cloud-board-group-menu')).toBeInTheDocument()
    fireEvent.scroll(document.body)
    expect(screen.queryByTestId('cloud-board-group-menu')).not.toBeInTheDocument()
    await userEvent.click(screen.getByTestId('cloud-board-group-by'))
    await userEvent.click(screen.getByTestId('cloud-board-group-option-priority'))
    expect(localStorage.getItem('wework-board-group:1:11')).toBe('priority')
    expect(screen.getByTestId('cloud-todo-column-priority-high')).toBeInTheDocument()
    expect(screen.getByTestId('cloud-board-group-filter')).toBeInTheDocument()
    expect(screen.getByTestId('cloud-board-search')).toBeInTheDocument()
    await userEvent.click(screen.getByTestId('cloud-board-save-global'))
    await waitFor(() =>
      expect(workbenchServices.deliveryApi!.updateCloudProject).toHaveBeenCalledWith(
        '11',
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
    await user.type(screen.getByTestId('workspace-issue-input'), 'Inbox Issue')
    await user.click(screen.getByTestId('workspace-issue-submit'))

    await waitFor(() =>
      expect(workbenchServices.deliveryApi?.createLoopItem).toHaveBeenCalledWith('11', {
        title: 'Inbox Issue',
        description: 'Inbox Issue',
        status: 'inbox',
        parent_id: null,
      })
    )
  })

  it('opens the Wework composer in task mode from the pending column', async () => {
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
      expect(workbenchServices.deliveryApi?.createLoopItem).toHaveBeenCalledWith('11', {
        title: 'Pending Issue',
        description: 'Pending Issue',
        status: 'pending',
        parent_id: null,
      })
    )
  })

  it('opens the Wework composer with the quick title and lane', async () => {
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
    // This scenario verifies title handoff, not per-character keyboard behavior.
    fireEvent.change(screen.getByTestId('cloud-todo-column-quick-create-input-inbox'), {
      target: { value: 'Issue with details' },
    })
    await userEvent.click(screen.getByTestId('cloud-todo-column-quick-create-full-inbox'))

    expect(screen.getByTestId('workspace-issue-composer')).toBeVisible()
    expect(screen.getByTestId('workspace-issue-input')).toHaveTextContent('Issue with details')
    expect(screen.getByTestId('workspace-issue-composer')).toHaveTextContent('创建 Issue')
  })

  it('only offers direct Issue creation in the inbox column', async () => {
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
      expect(screen.getByTestId(`cloud-todo-column-dropzone-${state}-viewport`)).toHaveClass(
        'overscroll-y-contain',
        'pr-1.5'
      )
      expect(screen.getByTestId(`cloud-todo-column-dropzone-${state}-content`)).toHaveClass(
        'px-2',
        'pt-2',
        'pb-2'
      )
      expect(screen.getByTestId(`cloud-todo-column-dropzone-${state}`)).not.toHaveClass('p-2')
    }
    const inboxAdd = screen.getByTestId('cloud-todo-column-empty-add-inbox')
    expect(inboxAdd).toBeVisible()
    expect(inboxAdd).toContainElement(inboxAdd.querySelector('svg'))
    expect(inboxAdd).toHaveTextContent('创建第一个 Issue')
    expect(screen.getByTestId('cloud-todo-column-dropzone-inbox')).toContainElement(inboxAdd)
    expect(screen.queryByTestId('cloud-todo-column-empty-add-pending')).not.toBeInTheDocument()
    expect(screen.getByTestId('cloud-todo-column-dropzone-pending')).toHaveTextContent(
      '目标和负责人明确后，从这里等待开始。'
    )
    for (const state of ['inbox', 'pending']) {
      expect(screen.queryByTestId(`cloud-todo-column-bottom-add-${state}`)).not.toBeInTheDocument()
    }
    for (const state of ['in_progress', 'in_review', 'completed']) {
      expect(screen.queryByTestId(`cloud-todo-column-bottom-add-${state}`)).not.toBeInTheDocument()
      expect(screen.queryByTestId(`cloud-todo-column-add-${state}`)).not.toBeInTheDocument()
    }
  })

  it('projects active Runtime Task lifecycle without bypassing persisted Issue review', async () => {
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
    let currentRuntimeWork = runtimeWork
    const lifecycleStore = new RuntimeTaskLifecycleStore(1)
    lifecycleStore.syncRuntimeWork(runtimeWork)
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
      items: [{ ...trackedIssue, status: 'in_review' }],
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
        runtimeWork={currentRuntimeWork}
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

    currentRuntimeWork = {
      ...runtimeWork,
      projects: runtimeWork.projects.map(projectWork => ({
        ...projectWork,
        deviceWorkspaces: projectWork.deviceWorkspaces.map(workspace => ({
          ...workspace,
          tasks: [],
        })),
      })),
      totalTasks: 0,
    }
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

    currentRuntimeWork = {
      ...runtimeWork,
      projects: runtimeWork.projects.map(projectWork => ({
        ...projectWork,
        deviceWorkspaces: projectWork.deviceWorkspaces.map(workspace => ({
          ...workspace,
          tasks: workspace.tasks.map(task => ({
            ...task,
            running: false,
            status: 'done',
            completedAt: 1_700_000_000,
          })),
        })),
      })),
    }
    lifecycleStore.syncRuntimeWork(currentRuntimeWork)
    rendered.rerender(workspace(lifecycleStore.getSnapshot()))

    await waitFor(() => {
      expect(screen.getByTestId('cloud-todo-column-in_review')).toHaveTextContent(
        trackedIssue.title
      )
    })
    expect(screen.getByTestId('cloud-todo-column-completed')).not.toHaveTextContent(
      trackedIssue.title
    )
  })

  it('shows an ordinary Runtime Task in My Tasks and opens the real Runtime Task', async () => {
    const defaultProject = {
      ...project,
      id: 'default-work-items',
      project_key: 'WORK',
      name: '我的任务',
      project_store: 'local' as const,
      metadata: { system_kind: 'default_work_items' },
    }
    const runtimeTask = {
      deviceId: 'local-device',
      taskId: 'ordinary-runtime-task',
      runtime: 'codex' as const,
      workspacePath: '/tmp/project-a',
      workspaceKind: 'workspace',
    }
    const workbenchServices = services()
    vi.mocked(workbenchServices.deliveryApi!.listCloudProjects).mockResolvedValue({
      items: [defaultProject],
    })
    workbenchServices.deliveryApi!.getBoardSnapshot = vi.fn(async () => ({
      items: [],
      task_bindings: [],
      members: [],
      agents: [],
    }))
    workbenchServices.projectSpaceApis = {
      local: workbenchServices.deliveryApi!,
      defaultLocation: 'local',
    }
    const onOpenRuntimeTask = vi.fn()

    render(
      <CloudTodoWorkspace
        user={{ id: 1, user_name: 'local', email: 'local@example.com' } as User}
        localProjects={[{ id: 91, name: 'Project A', tasks: [] }]}
        runtimeWork={{
          projects: [
            {
              project: { id: 91, key: 'project-a', name: 'Project A' },
              deviceWorkspaces: [
                {
                  deviceId: runtimeTask.deviceId,
                  workspacePath: runtimeTask.workspacePath,
                  workspaceKind: runtimeTask.workspaceKind,
                  available: true,
                  tasks: [
                    {
                      taskId: runtimeTask.taskId,
                      workspacePath: runtimeTask.workspacePath,
                      workspaceKind: runtimeTask.workspaceKind,
                      title: 'Ordinary Runtime Task',
                      runtime: runtimeTask.runtime,
                      completedAt: 1_700_000_000,
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
        embedded
        activeProjectRef={{
          projectStore: 'local',
          projectId: defaultProject.id,
        }}
        onOpenRuntimeTask={onOpenRuntimeTask}
      />
    )

    const card = await screen.findByTestId(
      'cloud-todo-card-runtime:local-device:ordinary-runtime-task'
    )

    await userEvent.click(card)

    expect(onOpenRuntimeTask).toHaveBeenCalledWith(expect.objectContaining(runtimeTask))
    expect(screen.queryByTestId('cloud-todo-detail-title')).not.toBeInTheDocument()
  })

  it('shows an Issue-bound Runtime Task only once in the unified My Tasks board', async () => {
    const defaultProject = {
      ...project,
      id: 'default-work-items',
      project_key: 'WORK',
      name: '我的任务',
      project_store: 'local' as const,
      metadata: { system_kind: 'default_work_items' },
    }
    const persistedIssue = {
      ...item,
      id: 'WORK-1',
      cloud_project_id: defaultProject.id,
      title: 'Issue-bound Runtime Task',
      status: 'completed' as const,
      is_unread: true,
    }
    const firstAddress = {
      deviceId: 'local-device',
      taskId: 'bound-runtime-task',
    }
    const secondAddress = {
      deviceId: 'local-device',
      taskId: 'second-bound-runtime-task',
    }
    const runtimeWork = {
      projects: [
        {
          project: { id: 91, key: 'project-a', name: 'Project A' },
          deviceWorkspaces: [
            {
              deviceId: firstAddress.deviceId,
              workspacePath: '/tmp/project-a',
              available: true,
              tasks: [
                {
                  taskId: firstAddress.taskId,
                  workspacePath: '/tmp/project-a',
                  title: persistedIssue.title,
                  runtime: 'codex' as const,
                  completedAt: 1_700_000_000,
                },
                {
                  taskId: secondAddress.taskId,
                  workspacePath: '/tmp/project-a',
                  title: 'Second bound Runtime Task',
                  runtime: 'codex' as const,
                  completedAt: 1_700_000_001,
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
    lifecycleStore.markRead(firstAddress)
    lifecycleStore.markRead(secondAddress)
    expect(lifecycleStore.getSnapshot().unreadTaskKeys).toEqual(new Set())
    const workbenchServices = services()
    vi.mocked(workbenchServices.deliveryApi!.listCloudProjects).mockResolvedValue({
      items: [defaultProject],
    })
    workbenchServices.deliveryApi!.getBoardSnapshot = vi.fn(async () => ({
      items: [persistedIssue],
      task_bindings: [
        {
          id: 1,
          loop_item_id: persistedIssue.id,
          task_user_id: 1,
          device_id: firstAddress.deviceId,
          task_id: firstAddress.taskId,
          task_title: persistedIssue.title,
          backend_task_id: null,
          linked_at: '2026-09-12T00:00:00Z',
        },
        {
          id: 2,
          loop_item_id: persistedIssue.id,
          task_user_id: 1,
          device_id: secondAddress.deviceId,
          task_id: secondAddress.taskId,
          task_title: 'Second bound Runtime Task',
          backend_task_id: null,
          linked_at: '2026-09-12T00:01:00Z',
        },
      ],
      members: [],
      agents: [],
    }))
    workbenchServices.deliveryApi!.listLoopItems = vi.fn(async () => ({
      items: [persistedIssue],
    }))
    workbenchServices.projectSpaceApis = {
      local: workbenchServices.deliveryApi!,
      defaultLocation: 'local',
    }
    const onMarkRuntimeTaskRead = vi.fn((runtimeAddress: typeof firstAddress) =>
      lifecycleStore.markRead(runtimeAddress)
    )
    const workspace = (
      lifecycleSnapshot: ReturnType<RuntimeTaskLifecycleStore['getSnapshot']>,
      focusedItemId?: string
    ) => (
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
        focusedItemId={focusedItemId}
        onMarkRuntimeTaskRead={onMarkRuntimeTaskRead}
      />
    )

    const rendered = render(workspace(lifecycleStore.getSnapshot()))

    expect(await screen.findByTestId(`cloud-todo-card-${persistedIssue.id}`)).toBeInTheDocument()
    expect(
      screen.queryByTestId('cloud-todo-card-runtime:local-device:bound-runtime-task')
    ).not.toBeInTheDocument()
    expect(
      screen.queryByTestId(`cloud-todo-card-unread-${persistedIssue.id}`)
    ).not.toBeInTheDocument()

    act(() => {
      lifecycleStore.executorStarted(firstAddress)
      lifecycleStore.executorSettled(firstAddress)
      lifecycleStore.executorStarted(secondAddress)
      lifecycleStore.executorSettled(secondAddress)
    })
    rendered.rerender(workspace(lifecycleStore.getSnapshot()))

    expect(
      await screen.findByTestId(`cloud-todo-card-unread-${persistedIssue.id}`)
    ).toBeInTheDocument()

    await userEvent.click(screen.getByTestId(`cloud-todo-card-${persistedIssue.id}`))

    expect(onMarkRuntimeTaskRead).toHaveBeenCalledTimes(2)
    expect(onMarkRuntimeTaskRead).toHaveBeenCalledWith(firstAddress)
    expect(onMarkRuntimeTaskRead).toHaveBeenCalledWith(secondAddress)
    expect(workbenchServices.deliveryApi!.markLoopItemRead).not.toHaveBeenCalled()

    await userEvent.click(screen.getByTestId('cloud-todo-detail-close'))
    onMarkRuntimeTaskRead.mockClear()
    act(() => {
      lifecycleStore.executorStarted(firstAddress)
      lifecycleStore.executorSettled(firstAddress)
      lifecycleStore.executorStarted(secondAddress)
      lifecycleStore.executorSettled(secondAddress)
    })
    rendered.rerender(workspace(lifecycleStore.getSnapshot(), persistedIssue.id))

    await waitFor(() => expect(onMarkRuntimeTaskRead).toHaveBeenCalledTimes(2))
    expect(onMarkRuntimeTaskRead).toHaveBeenCalledWith(firstAddress)
    expect(onMarkRuntimeTaskRead).toHaveBeenCalledWith(secondAddress)

    await userEvent.click(screen.getByTestId('cloud-todo-detail-close'))
    rendered.rerender(workspace(lifecycleStore.getSnapshot()))
    onMarkRuntimeTaskRead.mockClear()
    act(() => {
      lifecycleStore.executorStarted(firstAddress)
      lifecycleStore.executorSettled(firstAddress)
      lifecycleStore.executorStarted(secondAddress)
      lifecycleStore.executorSettled(secondAddress)
    })
    rendered.rerender(workspace(lifecycleStore.getSnapshot()))
    await userEvent.keyboard('{Meta>}k{/Meta}')
    await userEvent.type(screen.getByTestId('cloud-global-search-input'), persistedIssue.id)
    await userEvent.click(
      await screen.findByTestId(`cloud-global-search-result-${persistedIssue.id}`)
    )

    expect(onMarkRuntimeTaskRead).toHaveBeenCalledTimes(2)
    expect(onMarkRuntimeTaskRead).toHaveBeenCalledWith(firstAddress)
    expect(onMarkRuntimeTaskRead).toHaveBeenCalledWith(secondAddress)
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
    const secondCompletedIssue = {
      ...item,
      cloud_project_id: defaultProject.id,
      id: 'WEG-5',
      sequence_number: 5,
      title: 'Second completed task Issue',
      status: 'completed' as const,
      completed_at: '2026-08-22T00:00:00Z',
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
      items: [stoppedIssue, completedIssue, archivedIssue, noResponseIssue, secondCompletedIssue],
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
        {
          id: 5,
          loop_item_id: secondCompletedIssue.id,
          task_user_id: 1,
          device_id: 'local-device',
          task_id: 'second-completed-task',
          task_title: 'Second completed task',
          backend_task_id: null,
          linked_at: '2026-08-22T00:00:00Z',
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
    const onArchiveRuntimeTasks = vi
      .fn()
      .mockResolvedValueOnce({ status: 'failed' as const })
      .mockResolvedValue({ status: 'archived' as const })
    let secondItemArchiveFailed = false
    vi.mocked(workbenchServices.deliveryApi!.archiveLoopItem).mockImplementation(async itemId => {
      if (itemId === 'WEG-5' && !secondItemArchiveFailed) {
        secondItemArchiveFailed = true
        throw new Error('archive failed')
      }
    })

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
                    {
                      taskId: 'second-completed-task',
                      workspacePath: '/tmp/project-a',
                      title: 'Second completed task',
                      runtime: 'codex',
                      running: false,
                      completedAt: 1_700_000_001,
                      runtimeHandle: {
                        cloudProjectId: defaultProject.id,
                        loopItemId: secondCompletedIssue.id,
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
        onArchiveRuntimeTasks={onArchiveRuntimeTasks}
      />
    )

    expect(await screen.findByTestId('cloud-local-project-filter')).toHaveValue('all')
    expect(await screen.findByTestId('cloud-todo-column-in_review')).toHaveTextContent(
      'Stopped task Issue'
    )
    expect(screen.queryByTestId('cloud-todo-batch-confirm-review')).not.toBeInTheDocument()
    expect(await screen.findByTestId('cloud-todo-card-open-task-WEG-1')).toHaveAttribute(
      'aria-label',
      '打开任务页：Stopped task Issue'
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
        limit: 20,
      })
    )
    expect(screen.getByTestId('cloud-todo-column-completed')).toHaveTextContent(
      'Completed task Issue'
    )
    expect(screen.getByTestId('cloud-todo-column-completed')).toHaveTextContent(
      'Second completed task Issue'
    )
    await waitFor(() =>
      expect(screen.getByTestId('cloud-todo-column-completed')).not.toHaveTextContent(
        'Archived task Issue'
      )
    )

    await openIssueFromBoard()
    expect(screen.getByTestId('cloud-todo-detail')).toHaveTextContent('Stopped task Issue')
    expect(onOpenRuntimeTask).not.toHaveBeenCalled()

    await userEvent.click(screen.getByTestId('cloud-my-tasks-archive-completed'))
    expect(screen.getByText('归档已完成任务？')).toBeInTheDocument()
    expect(screen.getByText(/归档 2 个已完成任务/)).toBeInTheDocument()
    await userEvent.click(screen.getByTestId('cloud-my-tasks-archive-completed-confirm'))

    await waitFor(() =>
      expect(onArchiveRuntimeTasks).toHaveBeenCalledWith(
        expect.arrayContaining([
          expect.objectContaining({ deviceId: 'local-device', taskId: 'completed-task' }),
          expect.objectContaining({
            deviceId: 'local-device',
            taskId: 'second-completed-task',
          }),
        ])
      )
    )
    expect(workbenchServices.deliveryApi!.archiveLoopItem).not.toHaveBeenCalled()
    expect(screen.getByTestId('cloud-todo-column-completed')).toHaveTextContent(
      'Completed task Issue'
    )
    expect(screen.getByTestId('cloud-todo-column-completed')).toHaveTextContent(
      'Second completed task Issue'
    )
    expect(screen.getByText('归档已完成任务？')).toBeInTheDocument()

    await userEvent.click(screen.getByTestId('cloud-my-tasks-archive-completed-confirm'))

    await waitFor(() => expect(onArchiveRuntimeTasks).toHaveBeenCalledTimes(2))
    expect(onArchiveRuntimeTasks).toHaveBeenLastCalledWith(
      expect.arrayContaining([
        expect.objectContaining({ deviceId: 'local-device', taskId: 'completed-task' }),
        expect.objectContaining({
          deviceId: 'local-device',
          taskId: 'second-completed-task',
        }),
      ])
    )
    expect(workbenchServices.deliveryApi!.archiveLoopItem).toHaveBeenCalledWith('WEG-2')
    expect(workbenchServices.deliveryApi!.archiveLoopItem).toHaveBeenCalledWith('WEG-5')
    expect(screen.getByTestId('cloud-todo-column-completed')).not.toHaveTextContent(
      'Completed task Issue'
    )
    expect(screen.getByTestId('cloud-todo-column-completed')).toHaveTextContent(
      'Second completed task Issue'
    )
    expect(screen.getByText('归档已完成任务？')).toBeInTheDocument()
    expect(screen.getByText(/归档 1 个已完成任务/)).toBeInTheDocument()

    await userEvent.click(screen.getByTestId('cloud-my-tasks-archive-completed-confirm'))

    await waitFor(() => expect(onArchiveRuntimeTasks).toHaveBeenCalledTimes(3))
    expect(onArchiveRuntimeTasks).toHaveBeenLastCalledWith([
      expect.objectContaining({
        deviceId: 'local-device',
        taskId: 'second-completed-task',
      }),
    ])
    expect(workbenchServices.deliveryApi!.archiveLoopItem).toHaveBeenCalledTimes(3)
    expect(workbenchServices.deliveryApi!.archiveLoopItem).toHaveBeenLastCalledWith('WEG-5')
    expect(screen.getByTestId('cloud-todo-column-completed')).not.toHaveTextContent(
      'Second completed task Issue'
    )
    expect(screen.queryByText('归档已完成任务？')).not.toBeInTheDocument()
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

  it('confirms every editable item in the review column from one batch action', async () => {
    const reviewItems = [
      { ...item, status: 'in_review' as const },
      {
        ...item,
        id: 'WEG-2',
        sequence_number: 2,
        title: 'Review the release notes',
        status: 'in_review' as const,
        sort_order: 1,
      },
    ]
    const workbenchServices = services()
    vi.mocked(workbenchServices.deliveryApi!.listLoopItems).mockResolvedValue({
      items: reviewItems,
    })
    vi.mocked(workbenchServices.deliveryApi!.updateLoopItem).mockImplementation(
      async (itemId, values) => ({
        ...reviewItems.find(candidate => candidate.id === itemId)!,
        ...values,
        version: 2,
      })
    )

    render(
      <CloudTodoWorkspace
        user={{ id: 1, user_name: 'local', email: 'local@example.com' } as User}
        localProjects={[]}
        services={workbenchServices}
      />
    )

    await userEvent.click((await screen.findAllByText('Wegent V4'))[0])
    expect(await screen.findByTestId('cloud-todo-column-in_review')).toHaveTextContent(
      'Implement cloud MCP'
    )
    expect(screen.getByTestId('cloud-todo-column-in_review')).toHaveTextContent(
      'Review the release notes'
    )

    await userEvent.click(screen.getByTestId('cloud-todo-batch-confirm-review'))
    expect(screen.getByTestId('cloud-todo-batch-confirm-review-dialog')).toHaveTextContent(
      '将当前列中的 2 个事项标记为已完成'
    )
    await userEvent.click(screen.getByTestId('cloud-todo-batch-confirm-review-confirm'))

    await waitFor(() =>
      expect(workbenchServices.deliveryApi!.updateLoopItem).toHaveBeenCalledTimes(2)
    )
    expect(workbenchServices.deliveryApi!.updateLoopItem).toHaveBeenCalledWith('WEG-1', {
      version: 1,
      status: 'completed',
    })
    expect(workbenchServices.deliveryApi!.updateLoopItem).toHaveBeenCalledWith('WEG-2', {
      version: 1,
      status: 'completed',
    })
    await waitFor(() =>
      expect(screen.queryByTestId('cloud-todo-batch-confirm-review-dialog')).not.toBeInTheDocument()
    )
    expect(screen.getByTestId('cloud-todo-column-in_review')).not.toHaveTextContent(
      'Implement cloud MCP'
    )
    expect(screen.getByTestId('cloud-todo-column-completed')).toHaveTextContent(
      'Implement cloud MCP'
    )
    expect(screen.getByTestId('cloud-todo-column-completed')).toHaveTextContent(
      'Review the release notes'
    )
  })

  it('refreshes a failed local item before retrying batch confirmation', async () => {
    const localProject = {
      ...project,
      id: 'local-review',
      project_key: 'LOCAL',
      name: 'Local Review',
      project_store: 'local' as const,
    }
    const localReviewItem = {
      ...item,
      id: 'LOCAL-1',
      cloud_project_id: localProject.id,
      title: 'Confirm local review',
      status: 'in_review' as const,
      project_store: 'local' as const,
    }
    const workbenchServices = services()
    const localApi = workbenchServices.deliveryApi!
    localApi.listCloudProjects = vi.fn(async () => ({ items: [localProject] }))
    localApi.listLoopItems = vi.fn(async () => ({ items: [localReviewItem] }))
    localApi.getLoopItem = vi.fn(async () => ({ ...localReviewItem, version: 2 }))
    localApi.updateLoopItem = vi
      .fn()
      .mockRejectedValueOnce(new Error('version conflict'))
      .mockImplementation(async (_itemId, values) => ({
        ...localReviewItem,
        ...values,
        version: values.version + 1,
      }))
    workbenchServices.projectSpaceApis = {
      local: localApi,
      defaultLocation: 'local',
    }

    render(
      <CloudTodoWorkspace
        user={{ id: 1, user_name: 'local', email: 'local@example.com' } as User}
        localProjects={[]}
        services={workbenchServices}
      />
    )

    await userEvent.click((await screen.findAllByText('Local Review'))[0])
    expect(await screen.findByTestId('cloud-todo-column-in_review')).toHaveTextContent(
      'Confirm local review'
    )

    await userEvent.click(screen.getByTestId('cloud-todo-batch-confirm-review'))
    await userEvent.click(screen.getByTestId('cloud-todo-batch-confirm-review-confirm'))

    expect(await screen.findByRole('alert')).toHaveTextContent('1 个事项确认失败，请稍后重试')
    expect(localApi.updateLoopItem).toHaveBeenCalledWith('LOCAL-1', {
      version: 1,
      status: 'completed',
    })
    expect(localApi.getLoopItem).not.toHaveBeenCalled()

    await userEvent.click(screen.getByTestId('cloud-todo-batch-confirm-review-confirm'))

    await waitFor(() => expect(localApi.getLoopItem).toHaveBeenCalledWith('LOCAL-1'))
    expect(localApi.updateLoopItem).toHaveBeenLastCalledWith('LOCAL-1', {
      version: 2,
      status: 'completed',
    })
    expect(screen.queryByTestId('cloud-todo-batch-confirm-review-dialog')).not.toBeInTheDocument()
    expect(screen.getByTestId('cloud-todo-column-completed')).toHaveTextContent(
      'Confirm local review'
    )
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
    await userEvent.click(screen.getByTestId('cloud-project-files-view'))
    expect(
      screen.getByTestId('cloud-project-header').querySelector('.electron-titlebar-drag-region')
    ).toBeInTheDocument()
    await userEvent.click(await screen.findByTestId('cloud-folder-add'))
    await userEvent.type(screen.getByTestId('cloud-folder-name'), 'docs')
    await userEvent.click(screen.getByTestId('cloud-folder-create-confirm'))

    await waitFor(() =>
      expect(workbenchServices.deliveryApi?.createCloudFolder).toHaveBeenCalledWith('11', 'docs')
    )
  })
})
