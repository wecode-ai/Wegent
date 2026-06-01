import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, test, vi } from 'vitest'
import { MobileWorkbenchLayout } from './MobileWorkbenchLayout'

const baseState = {
  user: { id: 1, user_name: 'MI', email: 'mi@example.com' },
  defaultTeam: null,
  projects: [
    {
      id: 1,
      name: 'github_wegent',
      tasks: [
        {
          id: 11,
          task_id: 7,
          task_title: '项目任务',
          task_status: 'COMPLETED',
          created_at: '2026-05-25T00:00:00.000Z',
        },
      ],
    },
  ],
  devices: [],
  recentTasks: [
    {
      id: 3,
      title: '远程连接 Claude Code',
      status: 'COMPLETED',
      task_type: 'code' as const,
      created_at: '2026-05-25T00:00:00.000Z',
    },
  ],
  currentProject: null,
  standaloneDeviceId: null,
  currentTask: null,
  input: '',
  isBootstrapping: false,
  isSending: false,
  error: null,
}

const baseProjectChat = {
  models: [{ name: 'kimi-for-coding', type: 'user' as const }],
  skills: [],
  selectedModel: { name: 'kimi-for-coding', type: 'user' as const },
  selectedSkills: [],
  attachments: [],
  uploadingFiles: new Map(),
  errors: new Map(),
  isOptionsLocked: false,
  setSelectedModel: vi.fn(),
  toggleSkill: vi.fn(),
  handleFileSelect: vi.fn().mockResolvedValue(undefined),
  removeAttachment: vi.fn().mockResolvedValue(undefined),
}

describe('MobileWorkbenchLayout', () => {
  test('uses the project selector instead of a static project work shortcut', async () => {
    const onSelectProject = vi.fn()

    render(
      <MobileWorkbenchLayout
        state={baseState}
        messages={[]}
        onSelectProject={onSelectProject}
        onOpenTask={vi.fn()}
        onInputChange={vi.fn()}
        onSend={vi.fn()}
      />
    )

    expect(screen.queryByText('项目工作')).not.toBeInTheDocument()
    expect(screen.getByTestId('project-work-button')).toHaveTextContent('选择项目')

    await userEvent.click(screen.getByTestId('project-work-button'))
    await userEvent.click(screen.getByTestId('project-option-1'))

    expect(onSelectProject).toHaveBeenCalledWith(1)
  })

  test('does not show the user avatar on the mobile empty chat page', () => {
    render(
      <MobileWorkbenchLayout
        state={baseState}
        messages={[]}
        projectChat={baseProjectChat}
        onSelectProject={vi.fn()}
        onOpenTask={vi.fn()}
        onInputChange={vi.fn()}
        onSend={vi.fn()}
      />
    )

    expect(screen.queryByText('MI')).not.toBeInTheDocument()
    expect(screen.getByTestId('mobile-empty-header')).toHaveClass('bg-base/95')
    expect(screen.getByTestId('open-mobile-drawer-button')).toHaveClass(
      'h-10',
      'text-text-primary',
    )
    expect(screen.getByTestId('open-mobile-drawer-button')).not.toHaveClass(
      'bg-surface',
    )
    expect(screen.getByTestId('model-selector-button')).toHaveTextContent(
      'kimi-for-coding',
    )
    expect(screen.getByTestId('mobile-empty-chat-input-dock')).toHaveClass(
      'px-4',
      'pt-3',
    )
    expect(screen.getByTestId('compact-input-pill')).toHaveClass('min-h-[52px]')
    expect(screen.getByTestId('add-context-button')).toHaveClass('h-[52px]')
  })

  test('shows the selected project in the mobile empty project selector', () => {
    render(
      <MobileWorkbenchLayout
        state={{
          ...baseState,
          currentProject: baseState.projects[0],
        }}
        messages={[]}
        onSelectProject={vi.fn()}
        onOpenTask={vi.fn()}
        onInputChange={vi.fn()}
        onSend={vi.fn()}
      />
    )

    expect(screen.getByTestId('project-work-button')).toHaveTextContent(
      'github_wegent',
    )
  })

  test('keeps the conversation chrome fixed while only messages scroll', () => {
    const state = {
      ...baseState,
      currentTask: {
        id: 3,
        title: '开始追问',
        status: 'COMPLETED',
        task_type: 'code' as const,
        created_at: '2026-05-25T00:00:00.000Z',
      },
    }

    render(
      <MobileWorkbenchLayout
        state={state}
        messages={[
          {
            id: 'assistant-1',
            role: 'assistant',
            content: '长消息',
            status: 'done',
          },
        ]}
        projectChat={baseProjectChat}
        onSelectProject={vi.fn()}
        onOpenTask={vi.fn()}
        onInputChange={vi.fn()}
        onSend={vi.fn()}
      />
    )

    expect(screen.getByRole('main')).toHaveClass('h-dvh', 'overflow-hidden')
    expect(screen.getByTestId('chat-message-scroll-area')).toHaveClass(
      'overflow-y-auto',
      'pb-28',
      'pt-16',
    )
    expect(screen.getByTestId('mobile-chat-input-dock')).toHaveClass(
      'absolute',
      'bottom-0',
      'pointer-events-none',
    )
    expect(screen.getByTestId('mobile-conversation-header')).toHaveClass(
      'absolute',
      'bg-base/95',
      'backdrop-blur',
    )
    expect(screen.getByTestId('mobile-conversation-header')).toHaveClass('gap-2')
    expect(screen.getByTestId('open-mobile-drawer-button').closest('header')).toHaveClass(
      'absolute',
      'pointer-events-none',
    )
    expect(screen.getByTestId('open-mobile-drawer-button')).toHaveClass(
      'pointer-events-auto',
    )
    expect(screen.getByTestId('open-mobile-drawer-button')).not.toHaveClass(
      'bg-surface',
    )
    expect(screen.getByTestId('model-selector-button')).toHaveTextContent(
      'kimi-for-coding',
    )
  })

  test('opens drawer with projects and recent tasks', async () => {
    render(
      <MobileWorkbenchLayout
        state={baseState}
        messages={[]}
        onSelectProject={vi.fn()}
        onOpenTask={vi.fn()}
        onInputChange={vi.fn()}
        onSend={vi.fn()}
      />
    )

    await userEvent.click(screen.getByTestId('open-mobile-drawer-button'))

    expect(screen.getByText('项目')).toBeInTheDocument()
    expect(screen.queryByText('图片')).not.toBeInTheDocument()
    expect(screen.queryByText('编码')).not.toBeInTheDocument()
    expect(screen.queryByText('更多')).not.toBeInTheDocument()
    expect(screen.queryByText('自动化')).not.toBeInTheDocument()
    expect(screen.queryByTestId('mobile-plugins-nav-button')).not.toBeInTheDocument()
    expect(screen.getByTestId('mobile-search-input')).toHaveAttribute(
      'placeholder',
      '搜索',
    )
    expect(screen.getByText('github_wegent')).toBeInTheDocument()
    expect(screen.queryByText('项目任务')).not.toBeInTheDocument()
    expect(screen.getByTestId('mobile-project-item-button')).toHaveAttribute(
      'aria-expanded',
      'false',
    )
    expect(screen.getByTestId('mobile-project-item-button')).toHaveClass(
      'text-text-primary',
    )
    expect(screen.getByText('远程连接 Claude Code')).toBeInTheDocument()
    expect(screen.getByTestId('mobile-recent-task-button')).toHaveClass(
      'text-text-primary',
    )
    expect(screen.getByTestId('mobile-settings-button')).toHaveClass(
      'text-text-primary',
    )
    expect(screen.getByTestId('mobile-drawer-scroll')).toHaveClass('overflow-y-auto')
  })

  test('collapses project groups and opens project tasks and standalone chats from the drawer', async () => {
    const onSelectProject = vi.fn()
    const onOpenTask = vi.fn()
    const onOpenPlugins = vi.fn()
    const onNewChat = vi.fn()
    const onStartStandaloneChat = vi.fn()

    render(
      <MobileWorkbenchLayout
        state={baseState}
        messages={[]}
        onNewChat={onNewChat}
        onStartStandaloneChat={onStartStandaloneChat}
        onOpenPlugins={onOpenPlugins}
        onSelectProject={onSelectProject}
        onOpenTask={onOpenTask}
        onInputChange={vi.fn()}
        onSend={vi.fn()}
      />
    )

    await userEvent.click(screen.getByTestId('open-mobile-drawer-button'))
    await userEvent.click(screen.getByText('github_wegent'))
    expect(onSelectProject).toHaveBeenCalledWith(1)
    expect(screen.getByTestId('mobile-project-item-button')).toHaveAttribute(
      'aria-expanded',
      'true',
    )

    await userEvent.click(screen.getByText('项目任务'))
    expect(onOpenTask).toHaveBeenCalledWith(7, 1)

    await userEvent.click(screen.getByTestId('open-mobile-drawer-button'))
    await userEvent.click(screen.getByText('远程连接 Claude Code'))
    expect(onOpenTask).toHaveBeenCalledWith(3, undefined)

    await userEvent.click(screen.getByTestId('open-mobile-drawer-button'))
    await userEvent.click(screen.getByTestId('mobile-new-chat-button'))
    expect(onNewChat).toHaveBeenCalled()
    expect(screen.queryByTestId('mobile-standalone-new-chat-button')).not.toBeInTheDocument()
    expect(onStartStandaloneChat).not.toHaveBeenCalled()
    expect(onOpenPlugins).not.toHaveBeenCalled()
  })

  test('opens a mobile-specific settings page with plugins inside settings', async () => {
    const onOpenPlugins = vi.fn()

    render(
      <MobileWorkbenchLayout
        state={baseState}
        messages={[]}
        onOpenPlugins={onOpenPlugins}
        onSelectProject={vi.fn()}
        onOpenTask={vi.fn()}
        onInputChange={vi.fn()}
        onSend={vi.fn()}
      />
    )

    await userEvent.click(screen.getByTestId('open-mobile-drawer-button'))
    await userEvent.click(screen.getByTestId('mobile-settings-button'))

    expect(screen.getByTestId('mobile-settings-page')).toBeInTheDocument()
    expect(screen.queryByTestId('wework-settings-page')).not.toBeInTheDocument()

    await userEvent.click(screen.getByTestId('mobile-settings-plugins-button'))
    expect(onOpenPlugins).toHaveBeenCalledTimes(1)
  })
})
