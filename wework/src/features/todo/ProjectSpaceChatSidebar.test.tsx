import '@/i18n'

import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useRef } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type {
  Attachment,
  ModelOptions,
  ModelType,
  RuntimeSendRequest,
  RuntimeTaskAddress,
} from '@/types/api'
import { ProjectSpaceChatSidebar } from './ProjectSpaceChatSidebar'

const mocks = vi.hoisted(() => ({
  createProjectRuntimeTask: vi.fn(),
  bindTask: vi.fn(),
  readLocalIdentity: vi.fn(),
  sendError: vi.fn(),
  chatPanelMounts: 0,
  drafts: {} as Record<string, string>,
  writeDraft: vi.fn(),
  draftChange: null as null | ((value: string) => void),
  state: {
    runtimeWork: {
      projects: [],
      chats: [],
      totalTasks: 0,
    },
  },
}))

vi.mock('@/features/workbench/useWorkbench', () => ({
  useWorkbenchPaneContext: () => ({
    services: {
      deliveryApi: { bindTask: mocks.bindTask },
      getLocalRuntimeSidebarIdentity: mocks.readLocalIdentity,
    },
    projectChat: { inputByScope: mocks.drafts, setInputForScope: mocks.writeDraft },
    state: mocks.state,
    createProjectRuntimeTask: mocks.createProjectRuntimeTask,
  }),
}))

interface MockChatPanelProps {
  instanceId?: string
  draft?: { value: string; onChange(value: string): void }
  initialInput?: string
  initialAddress?: RuntimeTaskAddress | null
  emptyStateText?: string
  placeholder?: string
  runtimeContext?: Pick<RuntimeSendRequest, 'cloudProjectId' | 'origin' | 'additionalContext'>
  createTask?: (
    message: string,
    options: {
      attachments: Attachment[]
      executionModel: {
        modelId?: string
        modelType?: ModelType | null
        modelOptions?: ModelOptions
      }
      optimisticUserMessage: import('@/types/workbench').WorkbenchMessage & { role: 'user' }
      onError: (message: string) => void
      onRuntimeTaskOptimisticOpen: (address: RuntimeTaskAddress) => void
    }
  ) => Promise<RuntimeTaskAddress | false>
  onAddressChange?: (address: RuntimeTaskAddress | null) => void
}

vi.mock('@/components/layout/workspace-panels/TemporaryChatPanel', () => ({
  TemporaryChatPanel: ({
    instanceId,
    draft,
    initialAddress,
    initialInput,
    emptyStateText,
    placeholder,
    runtimeContext,
    createTask,
    onAddressChange,
  }: MockChatPanelProps) => {
    const mountId = useRef(++mocks.chatPanelMounts).current
    mocks.draftChange = draft?.onChange ?? null
    return (
      <div
        data-testid="mock-chat-panel"
        data-task-id={initialAddress?.taskId ?? ''}
        data-initial-input={initialInput ?? ''}
        data-mount-id={mountId}
        data-instance-id={instanceId}
        data-draft-value={draft?.value ?? ''}
        data-empty-state-text={emptyStateText ?? ''}
        data-placeholder={placeholder ?? ''}
        data-runtime-context={JSON.stringify(runtimeContext)}
      >
        <button
          type="button"
          data-testid="mock-chat-send"
          onClick={() => {
            void createTask?.('管理当前项目', {
              attachments: [],
              executionModel: {
                modelId: 'backend-codex',
                modelType: 'user',
                modelOptions: { reasoningEffort: 'high' },
              },
              optimisticUserMessage: {
                id: 'queued-side-chat-1',
                role: 'user',
                content: '管理当前项目',
                status: 'done',
              },
              onError: mocks.sendError,
              onRuntimeTaskOptimisticOpen: address => onAddressChange?.(address),
            })
          }}
        >
          发送
        </button>
      </div>
    )
  },
}))

const project = {
  id: 11,
  public_id: 'cloud-public-id',
  project_key: 'WEG',
  name: 'Wegent V4',
  description: 'Shared project',
  project_store: 'backend' as const,
  task_provider: 'dingtalk_aitable' as const,
  provider_config: { base_id: 'base-1', table_id: 'table-1' },
  created_by_user_id: 1,
  status: 'active',
  version: 1,
  created_at: '2026-07-22T00:00:00Z',
  updated_at: '2026-07-22T00:00:00Z',
}

describe('ProjectSpaceChatSidebar', () => {
  beforeEach(() => {
    window.localStorage.clear()
    mocks.createProjectRuntimeTask.mockReset()
    mocks.bindTask.mockReset()
    mocks.readLocalIdentity.mockReset().mockResolvedValue({ deviceId: 'this-mac' })
    mocks.sendError.mockReset()
    mocks.chatPanelMounts = 0
    mocks.drafts = {}
    mocks.draftChange = null
    mocks.writeDraft.mockReset().mockImplementation((key: string, value: string) => {
      mocks.drafts[key] = value
    })
    mocks.state.runtimeWork.projects = []
    mocks.state.runtimeWork.chats = [
      {
        deviceId: 'device-1',
        available: true,
        workspacePath: '/chat',
        tasks: [
          {
            taskId: 'older-task',
            workspacePath: '/chat/older',
            title: '旧会话',
            runtime: 'codex',
            updatedAt: '2026-07-20T00:00:00Z',
            runtimeHandle: { cloudProjectId: '11' },
          },
          {
            taskId: 'latest-task',
            workspacePath: '/chat/latest',
            title: '最近会话',
            runtime: 'codex',
            updatedAt: '2026-07-22T00:00:00Z',
            runtimeHandle: { cloudProjectId: 11 },
          },
          {
            taskId: 'other-project-task',
            workspacePath: '/chat/other',
            title: '其他项目',
            runtime: 'codex',
            updatedAt: '2026-07-23T00:00:00Z',
            runtimeHandle: { cloudProjectId: '12' },
          },
        ],
      },
    ]
  })

  it.each(['local', 'backend'] as const)(
    'creates a %s project conversation on this device with its storage context',
    async projectStore => {
      mocks.createProjectRuntimeTask.mockResolvedValue(false)
      render(
        <ProjectSpaceChatSidebar
          project={{ ...project, project_store: projectStore }}
          localProjects={[]}
          localExecution
          onClose={vi.fn()}
        />
      )
      expect(mocks.readLocalIdentity).not.toHaveBeenCalled()
      expect(screen.queryByTestId('project-space-chat-runtime-project')).not.toBeInTheDocument()
      await userEvent.click(screen.getByTestId('project-space-chat-new'))
      await userEvent.click(screen.getByTestId('mock-chat-send'))
      await waitFor(() => expect(mocks.createProjectRuntimeTask).toHaveBeenCalledOnce())
      expect(mocks.createProjectRuntimeTask).toHaveBeenCalledWith(
        '管理当前项目',
        expect.objectContaining({
          deviceId: 'this-mac',
          deviceWorkspaceId: null,
          origin: {
            type: 'project_chat',
            cloudProjectId: '11',
            projectStore,
          },
        })
      )
    }
  )

  it('reports unavailable local execution and allows sending after recovery', async () => {
    mocks.readLocalIdentity.mockResolvedValueOnce(null)
    mocks.createProjectRuntimeTask.mockResolvedValue(false)
    render(
      <ProjectSpaceChatSidebar
        project={project}
        localProjects={[]}
        localExecution
        onClose={vi.fn()}
      />
    )
    await userEvent.click(screen.getByTestId('project-space-chat-new'))
    await userEvent.click(screen.getByTestId('mock-chat-send'))
    await waitFor(() => expect(mocks.sendError).toHaveBeenCalledOnce())
    expect(mocks.createProjectRuntimeTask).not.toHaveBeenCalled()
    await userEvent.click(screen.getByTestId('mock-chat-send'))
    await waitFor(() => expect(mocks.createProjectRuntimeTask).toHaveBeenCalledOnce())
  })

  it('keeps local and cloud conversations separate when their project IDs match', async () => {
    mocks.state.runtimeWork.chats.push({
      deviceId: 'this-mac',
      available: true,
      workspacePath: '/local',
      tasks: [
        {
          taskId: 'local-chat',
          title: '本地看板会话',
          runtime: 'codex',
          workspacePath: '/local',
          runtimeHandle: {
            cloudProjectId: '11',
            origin: { projectStore: 'local' },
          },
        },
      ],
    } as never)
    render(
      <ProjectSpaceChatSidebar
        project={{ ...project, project_store: 'local' }}
        localProjects={[]}
        onClose={vi.fn()}
      />
    )
    expect(screen.getByTestId('mock-chat-panel')).toHaveAttribute('data-task-id', 'local-chat')
    await userEvent.click(screen.getByTestId('project-space-chat-menu'))
    expect(screen.getByTestId('project-space-chat-menu-list')).toHaveTextContent('本地看板会话')
    expect(screen.getByTestId('project-space-chat-menu-list')).not.toHaveTextContent('最近会话')
  })

  it.each(['local', 'backend'] as const)(
    'refreshes project Issue context for existing and new %s conversations',
    async projectStore => {
      if (projectStore === 'local') {
        mocks.state.runtimeWork.chats[0]!.tasks[1]!.runtimeHandle = {
          cloudProjectId: '11',
          origin: { projectStore: 'local' },
        } as never
      }
      render(
        <ProjectSpaceChatSidebar
          project={{ ...project, project_store: projectStore }}
          localProjects={[]}
          onClose={vi.fn()}
        />
      )
      const context = () =>
        JSON.parse(screen.getByTestId('mock-chat-panel').getAttribute('data-runtime-context')!)

      expect(screen.getByTestId('mock-chat-panel')).toHaveAttribute('data-task-id', 'latest-task')
      const capabilities = screen.getByTestId('project-space-chat-capabilities')
      for (const text of [project.name, 'Issue', '查一下事项', '查个人任务']) {
        expect(capabilities).toHaveTextContent(text)
      }
      expect(context()).toMatchObject({
        cloudProjectId: '11',
        origin: { type: 'project_chat', cloudProjectId: '11', projectStore },
        additionalContext: {
          projectSpaceChat: {
            value: expect.stringContaining('"事项", "查一下事项"'),
          },
        },
      })
      const existingContext = context()
      await userEvent.click(screen.getByTestId('project-space-chat-new'))
      expect(context()).toEqual(existingContext)
    }
  )

  it('creates a formal project-scoped conversation from a new draft', async () => {
    const address = {
      deviceId: 'device-1',
      taskId: 'new-task',
      workspacePath: '/workspace/project',
    }
    mocks.createProjectRuntimeTask.mockImplementation(async (_message, options) => {
      options.onRuntimeTaskOptimisticOpen?.(address)
      return address
    })

    const { rerender } = render(
      <ProjectSpaceChatSidebar
        project={project}
        localProjects={[{ id: 91, name: '运营工作区', tasks: [] }]}
        onClose={vi.fn()}
      />
    )

    await userEvent.click(screen.getByTestId('project-space-chat-new'))
    expect(screen.getByTestId('project-space-chat-runtime-project')).toBeInTheDocument()
    await userEvent.click(screen.getByTestId('mock-chat-send'))
    const createdChatMountId = screen.getByTestId('mock-chat-panel').getAttribute('data-mount-id')
    const createdChatInstanceId = screen
      .getByTestId('mock-chat-panel')
      .getAttribute('data-instance-id')
    const writePendingDraft = mocks.draftChange!

    await waitFor(() => expect(mocks.createProjectRuntimeTask).toHaveBeenCalledTimes(1))
    expect(mocks.createProjectRuntimeTask).toHaveBeenCalledWith(
      '管理当前项目',
      expect.objectContaining({
        project: expect.objectContaining({ id: 91 }),
        workspaceExecution: null,
        runtime: 'codex',
        optimisticUserMessage: expect.objectContaining({
          id: 'queued-side-chat-1',
          role: 'user',
        }),
        executionModel: {
          modelId: 'backend-codex',
          modelType: 'user',
          modelOptions: { reasoningEffort: 'high' },
        },
        cloudProjectId: '11',
        additionalContext: expect.objectContaining({
          projectSpaceChat: expect.objectContaining({
            kind: 'application',
            value: expect.stringContaining('current_project_space'),
          }),
          dingtalkAITableProject: expect.objectContaining({
            kind: 'application',
            value: expect.stringContaining('"base_id": "base-1"'),
          }),
        }),
      })
    )
    expect(mocks.createProjectRuntimeTask.mock.calls[0]?.[1]).not.toHaveProperty('initialGoal')
    expect(window.localStorage.getItem('wework-project-space-chat:backend:11')).toBe(
      'device-1:new-task'
    )

    mocks.state.runtimeWork = {
      ...mocks.state.runtimeWork,
      chats: [
        ...mocks.state.runtimeWork.chats,
        {
          deviceId: 'device-1',
          available: true,
          workspacePath: '/workspace/project',
          tasks: [
            {
              taskId: 'new-task',
              workspacePath: '/workspace/project',
              title: '管理当前项目',
              runtime: 'codex',
              running: true,
              runtimeHandle: { cloudProjectId: '11' },
            },
          ],
        },
      ],
    }
    rerender(
      <ProjectSpaceChatSidebar
        project={project}
        localProjects={[{ id: 91, name: '运营工作区', tasks: [] }]}
        onClose={vi.fn()}
      />
    )

    expect(screen.getByTestId('mock-chat-panel')).toHaveAttribute(
      'data-mount-id',
      createdChatMountId
    )
    expect(screen.getByTestId('mock-chat-panel')).toHaveAttribute(
      'data-instance-id',
      createdChatInstanceId
    )
    act(() => writePendingDraft('next question typed before discovery'))
    expect(mocks.writeDraft).toHaveBeenLastCalledWith(
      'pane:project-space:backend:11:device-1:new-task',
      'next question typed before discovery'
    )
  })

  it('keeps draft ownership when starting and cancelling another conversation', async () => {
    render(<ProjectSpaceChatSidebar project={project} localProjects={[]} onClose={vi.fn()} />)
    const existingFrame = screen.getByTestId('mock-chat-panel').getAttribute('data-mount-id')
    const writeExisting = mocks.draftChange!
    act(() => writeExisting('existing conversation draft'))
    await userEvent.click(screen.getByTestId('project-space-chat-new'))
    const newFrame = screen.getByTestId('mock-chat-panel').getAttribute('data-mount-id')
    expect(newFrame).not.toBe(existingFrame)
    const writeNew = mocks.draftChange!
    act(() => writeNew('new conversation draft'))
    // Pending writes from the previous frame retain that frame's owner.
    act(() => writeExisting('late existing draft'))
    expect(mocks.writeDraft).toHaveBeenLastCalledWith(
      'pane:project-space:backend:11:device-1:latest-task',
      'late existing draft'
    )
    await userEvent.click(screen.getByTestId('project-space-chat-new'))
    expect(screen.getByTestId('mock-chat-panel')).not.toHaveAttribute('data-mount-id', newFrame)
    expect(screen.getByTestId('mock-chat-panel')).toHaveAttribute(
      'data-draft-value',
      'late existing draft'
    )
    await userEvent.click(screen.getByTestId('project-space-chat-new'))
    expect(screen.getByTestId('mock-chat-panel')).toHaveAttribute(
      'data-draft-value',
      'new conversation draft'
    )
  })

  it('moves a published follow-up into its created conversation without replacing the frame', async () => {
    mocks.state.runtimeWork.chats = []
    const address = { deviceId: 'device-1', taskId: 'created-task', workspacePath: '/chat/created' }
    let finishCreation!: () => void
    mocks.createProjectRuntimeTask.mockImplementation(
      (_message, options) =>
        new Promise(resolve => {
          finishCreation = () => {
            options.onRuntimeTaskOptimisticOpen(address)
            resolve(address)
          }
        })
    )
    const view = render(
      <ProjectSpaceChatSidebar project={project} localProjects={[]} onClose={vi.fn()} />
    )
    const frameId = screen.getByTestId('mock-chat-panel').getAttribute('data-instance-id')
    await userEvent.click(screen.getByTestId('mock-chat-send'))
    await waitFor(() => expect(mocks.createProjectRuntimeTask).toHaveBeenCalledOnce())
    const publishPending = mocks.draftChange!
    act(() => publishPending('published before task binding'))
    mocks.state.runtimeWork = {
      ...mocks.state.runtimeWork,
      chats: [
        {
          deviceId: 'device-1',
          available: true,
          workspacePath: '/chat',
          tasks: [
            {
              taskId: 'created-task',
              workspacePath: '/chat/created',
              title: 'Created',
              runtime: 'codex',
              runtimeHandle: { cloudProjectId: '11' },
            },
          ],
        },
      ],
    }
    view.rerender(
      <ProjectSpaceChatSidebar project={project} localProjects={[]} onClose={vi.fn()} />
    )
    expect(screen.getByTestId('mock-chat-panel')).toHaveAttribute('data-instance-id', frameId)
    expect(screen.getByTestId('mock-chat-panel')).toHaveAttribute(
      'data-draft-value',
      'published before task binding'
    )
    await act(async () => finishCreation())
    const canonical = 'pane:project-space:backend:11:device-1:created-task'
    expect(screen.getByTestId('mock-chat-panel')).toHaveAttribute('data-instance-id', frameId)
    expect(screen.getByTestId('mock-chat-panel')).toHaveAttribute(
      'data-draft-value',
      'published before task binding'
    )
    expect(mocks.drafts[canonical]).toBe('published before task binding')
    expect(mocks.drafts['pane:project-space:backend:11:new']).toBe('')
    act(() => publishPending('late buffered follow-up'))
    expect(mocks.drafts[canonical]).toBe('late buffered follow-up')
    view.unmount()
    render(<ProjectSpaceChatSidebar project={project} localProjects={[]} onClose={vi.fn()} />)
    expect(screen.getByTestId('mock-chat-panel')).toHaveAttribute(
      'data-draft-value',
      'late buffered follow-up'
    )
  })

  it('keeps drafts separate when a refresh changes the fallback conversation', () => {
    mocks.drafts['pane:project-space:backend:11:device-1:older-task'] = 'older draft'
    const view = render(
      <ProjectSpaceChatSidebar project={project} localProjects={[]} onClose={vi.fn()} />
    )
    act(() => mocks.draftChange!('latest draft'))
    mocks.state.runtimeWork = {
      ...mocks.state.runtimeWork,
      chats: mocks.state.runtimeWork.chats.map(workspace => ({
        ...workspace,
        tasks: workspace.tasks.map(task =>
          task.taskId === 'older-task' ? { ...task, updatedAt: '2099-01-01T00:00:00Z' } : task
        ),
      })),
    }
    view.rerender(
      <ProjectSpaceChatSidebar project={project} localProjects={[]} onClose={vi.fn()} />
    )
    expect(screen.getByTestId('mock-chat-panel')).toHaveAttribute('data-task-id', 'older-task')
    expect(screen.getByTestId('mock-chat-panel')).toHaveAttribute('data-draft-value', 'older draft')
    expect(mocks.drafts['pane:project-space:backend:11:device-1:latest-task']).toBe('latest draft')
  })

  it('uses the displayed fallback draft when the stored selection no longer exists', () => {
    window.localStorage.setItem('wework-project-space-chat:backend:11', 'device-1:deleted-task')
    mocks.drafts['pane:project-space:backend:11:device-1:deleted-task'] = 'deleted draft'
    mocks.drafts['pane:project-space:backend:11:device-1:latest-task'] = 'latest draft'
    render(<ProjectSpaceChatSidebar project={project} localProjects={[]} onClose={vi.fn()} />)
    expect(screen.getByTestId('mock-chat-panel')).toHaveAttribute('data-task-id', 'latest-task')
    expect(screen.getByTestId('mock-chat-panel')).toHaveAttribute(
      'data-draft-value',
      'latest draft'
    )
  })

  it('ignores a previous frame creation callback after selecting another conversation', async () => {
    const user = userEvent.setup()
    let complete!: () => void
    mocks.createProjectRuntimeTask.mockImplementation(
      (_message, options) =>
        new Promise(resolve => {
          complete = () => {
            const address = {
              deviceId: 'device-1',
              taskId: 'late-task',
              workspacePath: '/chat/late',
            }
            options.onRuntimeTaskOptimisticOpen(address)
            resolve(address)
          }
        })
    )
    render(<ProjectSpaceChatSidebar project={project} localProjects={[]} onClose={vi.fn()} />)
    act(() => mocks.draftChange!('latest draft'))
    await user.click(screen.getByTestId('project-space-chat-new'))
    act(() => mocks.draftChange!('new draft'))
    await user.click(screen.getByTestId('mock-chat-send'))
    await waitFor(() => expect(mocks.createProjectRuntimeTask).toHaveBeenCalledOnce())
    await user.click(screen.getByTestId('project-space-chat-menu'))
    await user.click(
      screen
        .getAllByTestId('project-space-chat-menu-item')
        .find(item => item.textContent?.includes('最近会话'))!
    )
    await act(async () => complete())
    expect(screen.getByTestId('mock-chat-panel')).toHaveAttribute('data-task-id', 'latest-task')
    expect(screen.getByTestId('mock-chat-panel')).toHaveAttribute(
      'data-draft-value',
      'latest draft'
    )
    act(() => mocks.draftChange!('still latest draft'))
    expect(mocks.writeDraft).toHaveBeenLastCalledWith(
      'pane:project-space:backend:11:device-1:latest-task',
      'still latest draft'
    )
  })
})
