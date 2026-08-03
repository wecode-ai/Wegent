import '@/i18n'

import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useRef } from 'react'

import type { Attachment, RuntimeTaskAddress } from '@/types/api'
import { ProjectSpaceChatSidebar } from './ProjectSpaceChatSidebar'

const mocks = vi.hoisted(() => ({
  createProjectRuntimeTask: vi.fn(),
  bindTask: vi.fn(),
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
    services: { deliveryApi: { bindTask: mocks.bindTask } },
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
              onError: vi.fn(),
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

  it('renders localized project chat copy instead of translation keys', async () => {
    mocks.state.runtimeWork.chats = []

    render(
      <ProjectSpaceChatSidebar
        project={project}
        localProjects={[{ id: 91, name: '运营工作区', tasks: [] }]}
        onClose={vi.fn()}
      />
    )

    expect(screen.getByText('新会话')).toBeInTheDocument()
    expect(screen.getByTestId('project-space-chat-header')).toHaveClass('h-[52px]')
    expect(screen.getByTestId('project-space-chat-runtime-project')).toHaveValue('91')
    expect(screen.getByTestId('project-space-chat-resize-handle')).toHaveAccessibleName(
      '调整项目对话宽度'
    )
    expect(screen.getByTestId('mock-chat-panel')).toHaveAttribute(
      'data-empty-state-text',
      '开始一个关于“Wegent V4”的新会话。'
    )
    expect(screen.getByTestId('mock-chat-panel')).toHaveAttribute(
      'data-placeholder',
      '告诉 AI 你想在这个项目空间中完成什么'
    )
    expect(document.body).not.toHaveTextContent('project_space_chat.')
  })

  it('restores the latest conversation belonging to the current project', async () => {
    render(
      <ProjectSpaceChatSidebar
        project={project}
        localProjects={[{ id: 91, name: '运营工作区', tasks: [] }]}
        onClose={vi.fn()}
      />
    )

    await waitFor(() =>
      expect(screen.getByTestId('mock-chat-panel')).toHaveAttribute('data-task-id', 'latest-task')
    )
    expect(screen.getByTestId('project-space-chat-conversation')).toHaveTextContent('最近会话')

    await userEvent.click(screen.getByTestId('project-space-chat-menu'))
    const menuItems = screen.getAllByTestId('project-space-chat-menu-item')
    expect(menuItems).toHaveLength(2)
    expect(menuItems[0]).toHaveTextContent('最近会话')
    expect(menuItems[1]).toHaveTextContent('旧会话')
    expect(screen.queryByText('其他项目')).not.toBeInTheDocument()
  })

  it('switches conversations through the header menu', async () => {
    render(
      <ProjectSpaceChatSidebar
        project={project}
        localProjects={[{ id: 91, name: '运营工作区', tasks: [] }]}
        onClose={vi.fn()}
      />
    )

    await waitFor(() =>
      expect(screen.getByTestId('mock-chat-panel')).toHaveAttribute('data-task-id', 'latest-task')
    )

    await userEvent.click(screen.getByTestId('project-space-chat-menu'))
    await userEvent.click(screen.getAllByTestId('project-space-chat-menu-item')[1]!)

    expect(screen.getByTestId('mock-chat-panel')).toHaveAttribute('data-task-id', 'older-task')
    expect(window.localStorage.getItem('wework-project-space-chat:11')).toBe('device-1:older-task')
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
    expect(window.localStorage.getItem('wework-project-space-chat:11')).toBe('device-1:new-task')

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

  it('opens a task draft with its mention and binds the created conversation', async () => {
    const address = { deviceId: 'device-1', taskId: 'task-conversation' }
    mocks.createProjectRuntimeTask.mockResolvedValue(address)

    render(
      <ProjectSpaceChatSidebar
        project={project}
        localProjects={[{ id: 91, name: '运营工作区', tasks: [] }]}
        launchRequest={{
          id: 1,
          item: {
            id: 'WEG-18',
            title: '修复登录流程',
            description: '结合现有代码定位问题',
            status: 'in_progress',
          },
          localProjectId: null,
        }}
        onClose={vi.fn()}
      />
    )

    await waitFor(() =>
      expect(screen.getByTestId('mock-chat-panel')).toHaveAttribute(
        'data-initial-input',
        '[$任务:WEG-18](cloud://projects/11/todos/WEG-18)\n\n任务描述：\n结合现有代码定位问题\n\n补充说明：\n'
      )
    )
    expect(screen.getByTestId('project-space-chat-runtime-project')).toHaveValue('')

    await userEvent.click(screen.getByTestId('mock-chat-send'))

    await waitFor(() =>
      expect(mocks.createProjectRuntimeTask).toHaveBeenCalledWith(
        '管理当前项目',
        expect.objectContaining({
          project: null,
          cloudProjectId: '11',
          additionalContext: expect.objectContaining({
            projectSpaceTask: expect.objectContaining({
              value: expect.stringContaining('cloud://projects/11/todos/WEG-18'),
            }),
          }),
        })
      )
    )
    expect(mocks.bindTask).toHaveBeenCalledWith('WEG-18', address, '修复登录流程')
  })

  it('resizes the project conversation sidebar and remembers the width', async () => {
    render(
      <ProjectSpaceChatSidebar
        project={project}
        localProjects={[{ id: 91, name: '运营工作区', tasks: [] }]}
        onClose={vi.fn()}
      />
    )

    const sidebar = screen.getByTestId('project-space-chat-sidebar')
    vi.spyOn(sidebar.parentElement!, 'getBoundingClientRect').mockReturnValue({
      x: 0,
      y: 0,
      top: 0,
      right: 1200,
      bottom: 800,
      left: 0,
      width: 1200,
      height: 800,
      toJSON: () => ({}),
    })
    const handle = screen.getByTestId('project-space-chat-resize-handle')

    await userEvent.pointer([
      { keys: '[MouseLeft>]', target: handle, coords: { clientX: 800, clientY: 200 } },
      { target: handle, coords: { clientX: 650, clientY: 200 } },
      { keys: '[/MouseLeft]', target: handle, coords: { clientX: 650, clientY: 200 } },
    ])

    expect(sidebar).toHaveStyle({ width: '570px' })
    expect(window.localStorage.getItem('wework.project-space-chat-width')).toBe('570')
  })
})
