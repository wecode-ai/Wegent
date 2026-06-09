import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState, type ReactNode } from 'react'
import { afterEach, describe, expect, test, vi } from 'vitest'
import type { UnifiedModel } from '@/types/api'
import { MobileWorkbenchLayout } from './MobileWorkbenchLayout'

const originalInnerWidth = window.innerWidth

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
  selectedModelOptions: {},
  selectedSkills: [],
  attachments: [],
  uploadingFiles: new Map(),
  errors: new Map(),
  isOptionsLocked: false,
  setSelectedModel: vi.fn(),
  setSelectedModelOption: vi.fn(),
  toggleSkill: vi.fn(),
  handleFileSelect: vi.fn().mockResolvedValue(undefined),
  removeAttachment: vi.fn().mockResolvedValue(undefined),
}

describe('MobileWorkbenchLayout', () => {
  afterEach(() => {
    Object.defineProperty(window, 'innerWidth', {
      configurable: true,
      writable: true,
      value: originalInnerWidth,
    })
    window.dispatchEvent(new Event('resize'))
  })

  function renderAtMobileWidth(ui: ReactNode) {
    Object.defineProperty(window, 'innerWidth', {
      configurable: true,
      writable: true,
      value: 400,
    })
    return render(ui)
  }

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
    renderAtMobileWidth(
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
    expect(screen.getByTestId('mobile-empty-header')).toHaveClass('bg-background/95')
    expect(screen.getByTestId('open-mobile-drawer-button')).toHaveClass(
      'h-11',
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
    expect(screen.getByTestId('mobile-empty-chat-input-dock').className).not.toMatch(
      /\bz-(?:modal|critical)\b/,
    )
    expect(screen.getByTestId('mobile-empty-state-content')).toHaveClass(
      'items-center',
      'gap-6',
    )
    expect(screen.getByTestId('project-work-button').parentElement?.parentElement).toHaveClass(
      'flex-col',
      'gap-1',
    )
    expect(screen.getByTestId('mobile-empty-state-content').parentElement).toHaveClass(
      'items-center',
      'justify-center',
    )
    expect(screen.getByTestId('compact-input-pill')).toHaveClass('min-h-[52px]')
    expect(screen.getByTestId('add-context-button')).toHaveClass('h-[52px]')
  })

  test('uses a bottom sheet for the mobile model picker', async () => {
    const gptModel: UnifiedModel = {
      name: 'overseas-gpt-5.5',
      type: 'user',
      displayName: '海外:gpt-5.5',
      config: {
        ui: {
          family: 'gpt',
          region: 'overseas',
          modelLabel: 'gpt-5.5',
          sortOrder: 10,
          controls: {
            speed: true,
          },
        },
      },
    }
    const claudeModel: UnifiedModel = {
      name: 'claude-sonnet',
      type: 'user',
      displayName: 'Claude Sonnet',
      config: {
        ui: {
          family: 'claude',
          modelLabel: 'Claude Sonnet',
          sortOrder: 10,
        },
      },
    }
    const setSelectedModel = vi.fn()

    renderAtMobileWidth(
      <MobileWorkbenchLayout
        state={baseState}
        messages={[]}
        projectChat={{
          ...baseProjectChat,
          models: [claudeModel, gptModel],
          selectedModel: gptModel,
          selectedModelOptions: { reasoning: 'high', speed: 'standard' },
          setSelectedModel,
        }}
        onSelectProject={vi.fn()}
        onOpenTask={vi.fn()}
        onInputChange={vi.fn()}
        onSend={vi.fn()}
      />
    )

    await userEvent.click(screen.getByTestId('model-selector-button'))

    expect(screen.getByTestId('model-selector-menu')).toHaveAttribute(
      'data-mobile',
      'true',
    )
    expect(screen.getByTestId('model-selector-menu')).toHaveAttribute(
      'aria-modal',
      'true',
    )
    expect(screen.getByTestId('model-selector-menu')).toHaveAttribute(
      'aria-labelledby',
      'model-selector-mobile-title',
    )
    expect(screen.getByTestId('model-selector-menu')).toHaveClass('h-[82dvh]')
    expect(screen.getByTestId('model-selector-menu').closest('.fixed')).toHaveClass(
      'z-modal',
    )
    expect(screen.getByTestId('model-selector-confirm-button').parentElement).toHaveClass(
      'shrink-0',
    )
    expect(screen.getByTestId('model-selector-confirm-button').parentElement).not.toHaveClass(
      'absolute',
    )
    expect(screen.getByTestId('model-selector-search-input')).toHaveClass(
      'text-base',
      'leading-5',
    )
    expect(screen.getByTestId('model-selector-model-list')).toHaveClass(
      'overflow-y-auto',
      'scrollbar-none',
    )
    expect(screen.getByTestId('model-control-reasoning-high')).toBeInTheDocument()
    expect(screen.getByTestId('model-control-reasoning-high')).toHaveClass(
      'h-11',
      'min-w-[44px]',
    )
    expect(screen.getByTestId('model-control-speed-fast')).toBeInTheDocument()
    expect(screen.getByTestId('model-family-claude')).toHaveClass(
      'h-11',
      'min-w-[44px]',
    )

    await userEvent.click(screen.getByTestId('model-family-claude'))
    await userEvent.click(screen.getByTestId('model-option-claude-sonnet'))

    expect(setSelectedModel).toHaveBeenCalledWith(claudeModel)
    expect(screen.getByTestId('model-selector-menu')).toBeInTheDocument()

    await userEvent.click(screen.getByTestId('model-selector-confirm-button'))

    expect(screen.queryByTestId('model-selector-menu')).not.toBeInTheDocument()
  })

  test('updates mobile reasoning controls without closing the model picker', async () => {
    const gptModel: UnifiedModel = {
      name: 'overseas-gpt-5.5',
      type: 'user',
      displayName: '海外:gpt-5.5',
      config: {
        ui: {
          family: 'gpt',
          region: 'overseas',
          modelLabel: 'gpt-5.5',
          sortOrder: 10,
        },
      },
    }

    function Harness() {
      const [selectedModelOptions, setSelectedModelOptions] = useState({
        reasoning: 'high',
      })

      return (
        <MobileWorkbenchLayout
          state={baseState}
          messages={[]}
          projectChat={{
            ...baseProjectChat,
            models: [gptModel],
            selectedModel: gptModel,
            selectedModelOptions,
            setSelectedModelOption: (optionId, value) =>
              setSelectedModelOptions(current => ({
                ...current,
                [optionId]: value,
              })),
          }}
          onSelectProject={vi.fn()}
          onOpenTask={vi.fn()}
          onInputChange={vi.fn()}
          onSend={vi.fn()}
        />
      )
    }

    renderAtMobileWidth(<Harness />)

    await userEvent.click(screen.getByTestId('model-selector-button'))
    await userEvent.click(screen.getByTestId('model-control-reasoning-medium'))

    expect(screen.getByTestId('model-selector-menu')).toBeInTheDocument()
    expect(screen.getByTestId('model-control-reasoning-medium')).toHaveClass(
      'bg-[#1f2933]',
    )
    expect(screen.getByTestId('model-control-reasoning-high')).toHaveClass(
      'bg-surface',
    )
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

  test('shows and switches branches in the mobile empty project controls', async () => {
    const currentProject = {
      ...baseState.projects[0],
      config: {
        mode: 'workspace',
        device_id: 'device-1',
        workspace: {
          source: 'local_path' as const,
          localPath: '/workspace/github_wegent',
        },
      },
    }
    const onLoadEnvironmentInfo = vi.fn().mockResolvedValue({
      additions: '+0',
      deletions: '-0',
      executionTarget: 'local' as const,
      branchName: 'main',
    })
    const onCheckoutEnvironmentBranch = vi.fn().mockResolvedValue(undefined)

    renderAtMobileWidth(
      <MobileWorkbenchLayout
        state={{
          ...baseState,
          currentProject,
        }}
        messages={[]}
        projectChat={baseProjectChat}
        projectWork={{
          projects: [currentProject],
          devices: [],
          currentProjectId: currentProject.id,
          executionMode: 'current_workspace',
          executionModeLocked: false,
          onSelectProject: vi.fn(),
          onSelectStandaloneDevice: vi.fn(),
          onExecutionModeChange: vi.fn(),
        }}
        onSelectProject={vi.fn()}
        onOpenTask={vi.fn()}
        onLoadEnvironmentInfo={onLoadEnvironmentInfo}
        onListEnvironmentBranches={vi.fn().mockResolvedValue(['feature/mobile', 'main'])}
        onCheckoutEnvironmentBranch={onCheckoutEnvironmentBranch}
        onCreateEnvironmentBranch={vi.fn().mockResolvedValue(undefined)}
        onInputChange={vi.fn()}
        onSend={vi.fn()}
      />,
    )

    await waitFor(() =>
      expect(screen.getByTestId('project-branch-button')).toHaveTextContent('main'),
    )
    const controls = screen.getByTestId('project-work-button').parentElement?.parentElement
    expect(controls).toHaveClass('flex-col')
    expect(screen.getByTestId('execution-mode-button')).toBeInTheDocument()

    await userEvent.click(screen.getByTestId('project-work-button'))
    expect(screen.getByTestId('project-work-menu')).toHaveAttribute(
      'data-mobile',
      'true',
    )
    expect(screen.getByTestId('project-work-menu')).toHaveClass(
      'fixed',
      'max-h-[45dvh]',
    )
    expect(screen.getByTestId('project-search-input')).not.toHaveFocus()
    await userEvent.click(screen.getByTestId('project-work-mobile-close-button'))

    await userEvent.click(screen.getByTestId('execution-mode-button'))
    expect(screen.getByTestId('project-execution-mode-menu')).toHaveAttribute(
      'data-mobile',
      'true',
    )
    expect(screen.getByTestId('project-execution-mode-menu')).toHaveClass(
      'fixed',
      'max-h-[45dvh]',
    )
    await userEvent.click(screen.getByTestId('project-work-mobile-close-button'))

    await userEvent.click(screen.getByTestId('project-branch-button'))
    expect(await screen.findByTestId('project-branch-menu')).toHaveAttribute(
      'data-mobile',
      'true',
    )
    expect(screen.getByTestId('project-branch-menu')).toHaveClass(
      'fixed',
      'max-h-[56dvh]',
    )
    expect(screen.getByTestId('project-branch-search-input')).not.toHaveFocus()
    const options = await screen.findAllByTestId('project-branch-option')
    await userEvent.click(options[0])

    expect(onCheckoutEnvironmentBranch).toHaveBeenCalledWith(
      currentProject,
      'feature/mobile',
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
      'z-chrome',
    )
    expect(screen.getByTestId('mobile-conversation-header')).toHaveClass(
      'absolute',
      'bg-background/95',
      'backdrop-blur',
      'z-chrome',
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

    const mobileDrawer = screen.getByText('Wework').closest('.fixed')
    expect(mobileDrawer).toHaveStyle({
      backgroundColor: 'rgb(var(--color-mobile-drawer))',
    })
    expect(mobileDrawer).toHaveClass(
      'z-critical',
      'backdrop-blur-3xl',
      'backdrop-saturate-150',
    )
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
    expect(screen.getByTestId('mobile-search-input')).toHaveClass(
      'text-base',
      'leading-5',
    )
    expect(screen.getByText('github_wegent')).toBeInTheDocument()
    expect(screen.queryByText('项目任务')).not.toBeInTheDocument()
    expect(screen.getByTestId('mobile-project-item-button')).toHaveAttribute(
      'aria-expanded',
      'false',
    )
    expect(screen.getByTestId('mobile-project-item-button')).toHaveClass(
      'text-[rgb(var(--color-sidebar-text-primary))]',
    )
    expect(screen.getByText('远程连接 Claude Code')).toBeInTheDocument()
    expect(screen.getByTestId('mobile-recent-task-button')).toHaveClass(
      'text-[rgb(var(--color-sidebar-text-primary))]',
    )
    expect(screen.getByTestId('mobile-settings-button')).toHaveClass(
      'text-[rgb(var(--color-sidebar-text-primary))]',
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

  test('shows more project tasks from the mobile drawer', async () => {
    const stateWithManyProjectTasks = {
      ...baseState,
      projects: [
        {
          ...baseState.projects[0],
          tasks: Array.from({ length: 5 }, (_, index) => ({
            id: index + 1,
            task_id: index + 1,
            task_title: `项目任务 ${index + 1}`,
            task_status: 'COMPLETED',
            created_at: `2026-05-2${index}T00:00:00.000Z`,
          })),
        },
      ],
    }

    render(
      <MobileWorkbenchLayout
        state={stateWithManyProjectTasks}
        messages={[]}
        onSelectProject={vi.fn()}
        onOpenTask={vi.fn()}
        onInputChange={vi.fn()}
        onSend={vi.fn()}
      />
    )

    await userEvent.click(screen.getByTestId('open-mobile-drawer-button'))
    await userEvent.click(screen.getByText('github_wegent'))

    expect(screen.getAllByTestId('mobile-project-task-button')).toHaveLength(4)
    expect(screen.queryByText('项目任务 1')).not.toBeInTheDocument()

    await userEvent.click(screen.getByTestId('mobile-project-task-limit-toggle-1'))

    expect(screen.getAllByTestId('mobile-project-task-button')).toHaveLength(5)
    expect(screen.getByText('项目任务 1')).toBeInTheDocument()

    await userEvent.click(screen.getByTestId('mobile-project-task-limit-toggle-1'))

    expect(screen.getAllByTestId('mobile-project-task-button')).toHaveLength(4)
    expect(screen.queryByText('项目任务 1')).not.toBeInTheDocument()
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
