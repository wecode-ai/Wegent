import '@/i18n'

import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useRef } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { Attachment, ModelOptions, ModelType, RuntimeTaskAddress } from '@/types/api'
import { ProjectSpaceChatSidebar } from './ProjectSpaceChatSidebar'

const mocks = vi.hoisted(() => ({
  createProjectRuntimeTask: vi.fn(),
  bindTask: vi.fn(),
  readLocalIdentity: vi.fn(),
  sendError: vi.fn(),
  chatPanelMounts: 0,
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
    state: mocks.state,
    createProjectRuntimeTask: mocks.createProjectRuntimeTask,
  }),
}))

interface MockChatPanelProps {
  initialInput?: string
  initialAddress?: RuntimeTaskAddress | null
  emptyStateText?: string
  placeholder?: string
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
    initialAddress,
    initialInput,
    emptyStateText,
    placeholder,
    createTask,
    onAddressChange,
  }: MockChatPanelProps) => {
    const mountId = useRef(++mocks.chatPanelMounts).current
    return (
      <div
        data-testid="mock-chat-panel"
        data-task-id={initialAddress?.taskId ?? ''}
        data-initial-input={initialInput ?? ''}
        data-mount-id={mountId}
        data-empty-state-text={emptyStateText ?? ''}
        data-placeholder={placeholder ?? ''}
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

    mocks.state.runtimeWork.chats = [
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
    ]
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
  })
})
