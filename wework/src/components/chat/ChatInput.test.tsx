import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { StrictMode, useState } from 'react'
import { describe, expect, test, vi } from 'vitest'
import type {
  Attachment,
  DeviceInfo,
  LocalDeviceSkill,
  RuntimeGoal,
  RuntimeWorkListResponse,
  UnifiedModel,
} from '@/types/api'
import type { GuidanceWorkbenchMessage, QueuedWorkbenchMessage } from '@/types/workbench'

vi.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => ({
    t: (key: string, options?: string | { action?: string; count?: number; device?: string }) => {
      if (typeof options === 'string') return options
      if (key === 'workbench.code_comment_count') {
        return `${options?.count ?? 0} 个评论`
      }
      if (key === 'workbench.project_work_trigger_device_aria') {
        return `${options?.action ?? ''}，当前设备 ${options?.device ?? ''}`
      }
      if (key === 'workbench.remove_code_comments') {
        return '移除代码评论'
      }
      return key
    },
  }),
}))

import { ChatInput } from './ChatInput'
import type { ProjectChatControls, ProjectWorkControls } from './ChatInput'

function ControlledChatInput({
  onSubmit = vi.fn(),
  projectChat,
  variant,
}: {
  onSubmit?: () => void
  projectChat?: ProjectChatControls
  variant?: 'compact' | 'desktop'
}) {
  const [value, setValue] = useState('')

  return (
    <ChatInput
      value={value}
      onChange={setValue}
      onSubmit={onSubmit}
      disabled={false}
      variant={variant}
      projectChat={projectChat}
    />
  )
}

function projectChatControls(overrides: Partial<ProjectChatControls> = {}): ProjectChatControls {
  return {
    models: [],
    skills: [],
    selectedModel: null,
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
    listLocalSkills: vi.fn().mockResolvedValue([]),
    ...overrides,
  }
}

function projectWorkControls(overrides: Partial<ProjectWorkControls> = {}): ProjectWorkControls {
  const devices =
    overrides.devices?.map(device => ({
      ...device,
      bind_shell: device.bind_shell ?? 'claudecode',
      executor_version:
        device.bind_shell === 'openclaw'
          ? device.executor_version
          : (device.executor_version ?? '1.8.5'),
    })) ?? []
  const currentProject =
    overrides.currentProject ??
    overrides.projects?.find(project => project.id === overrides.currentProjectId) ??
    null

  return {
    projects: [],
    devices,
    currentProject,
    currentProjectId: undefined,
    currentStandaloneDeviceId: null,
    onSelectProject: vi.fn(),
    onSelectStandaloneDevice: vi.fn(),
    ...overrides,
    devices,
  }
}

function runtimeWork(
  items: Array<{
    id: number
    name: string
    workspaceId?: number | null
    deviceId?: string
    deviceName?: string
    deviceStatus?: DeviceInfo['status']
    available?: boolean
    workspacePath?: string
  }>
): RuntimeWorkListResponse {
  return {
    projects: items.map(item => ({
      project: { id: item.id, name: item.name },
      deviceWorkspaces: [
        {
          id: item.workspaceId ?? item.id * 10,
          projectId: item.id,
          deviceId: item.deviceId ?? 'device-online',
          deviceName: item.deviceName ?? 'Online Device',
          deviceStatus: item.deviceStatus ?? 'online',
          available: item.available ?? true,
          workspacePath: item.workspacePath ?? `/workspace/${item.name}`,
          mapped: true,
          tasks: [],
        },
      ],
    })),
    chats: [],
    totalTasks: 0,
  }
}

describe('ChatInput', () => {
  const originalCreateObjectUrl = URL.createObjectURL
  const originalInnerWidth = window.innerWidth

  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    vi.useRealTimers()
    localStorage.clear()
    URL.createObjectURL = originalCreateObjectUrl
    Object.defineProperty(window, 'innerWidth', {
      configurable: true,
      value: originalInnerWidth,
    })
    delete (window as typeof window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__
  })

  test('renders the desktop composer sections', () => {
    render(
      <ChatInput
        value=""
        onChange={vi.fn()}
        onSubmit={vi.fn()}
        disabled={false}
        variant="desktop"
      />
    )

    expect(screen.getByTestId('project-chat-composer-form')).toHaveClass(
      'min-h-[76px]',
      'pb-1.5',
      'pt-2',
      'bg-background'
    )
    expect(screen.getByTestId('project-chat-composer-form')).not.toHaveClass('bg-surface')
    expect(screen.getByTestId('chat-message-input')).toHaveAttribute('rows', '2')
    expect(screen.getByTestId('chat-message-input')).toHaveClass(
      'min-h-[48px]',
      'max-h-[112px]',
      'pt-1',
      'placeholder:text-text-muted/55'
    )
    expect(screen.queryByTestId('custom-mode-button')).not.toBeInTheDocument()
    expect(screen.getByTestId('model-selector-button')).toBeInTheDocument()
    expect(screen.queryByTestId('skill-selector-button')).not.toBeInTheDocument()
    expect(screen.getByTestId('project-work-button')).toBeInTheDocument()
    expect(screen.queryByTestId('voice-input-button')).not.toBeInTheDocument()
  })

  test('selects plan mode from the add context menu', async () => {
    const setSelectedModelOption = vi.fn()
    render(
      <ChatInput
        value=""
        onChange={vi.fn()}
        onSubmit={vi.fn()}
        disabled={false}
        variant="desktop"
        projectChat={projectChatControls({
          selectedModelOptions: {},
          setSelectedModelOption,
        })}
      />
    )

    expect(screen.queryByTestId('plan-mode-pill')).not.toBeInTheDocument()
    expect(screen.queryByTestId('cancel-plan-mode-button')).not.toBeInTheDocument()

    await userEvent.click(screen.getByTestId('add-context-button'))
    await userEvent.click(screen.getByTestId('set-plan-mode-button'))

    expect(setSelectedModelOption).toHaveBeenCalledWith('collaborationMode', 'plan')
  })

  test('shows the plan mode pill when plan mode is selected', async () => {
    const setSelectedModelOption = vi.fn()
    render(
      <ChatInput
        value=""
        onChange={vi.fn()}
        onSubmit={vi.fn()}
        disabled={false}
        variant="desktop"
        projectChat={projectChatControls({
          selectedModelOptions: { collaborationMode: 'plan' },
          setSelectedModelOption,
        })}
      />
    )

    const pill = screen.getByTestId('plan-mode-pill')
    expect(pill).toHaveTextContent('计划模式')
    expect(pill).toHaveClass('h-7')
    expect(pill).toHaveClass('rounded-xl')
    expect(pill).toHaveClass('bg-muted')
    expect(screen.getByTestId('cancel-plan-mode-button')).toHaveClass('w-0')
    expect(screen.getByTestId('cancel-plan-mode-button')).toHaveClass('group-hover:w-5')

    await userEvent.click(screen.getByTestId('cancel-plan-mode-button'))

    expect(setSelectedModelOption).toHaveBeenCalledWith('collaborationMode', 'default')
  })

  test('hides the plan mode pill while goal draft mode is active', () => {
    render(
      <ChatInput
        value=""
        onChange={vi.fn()}
        onSubmit={vi.fn()}
        disabled={false}
        variant="desktop"
        goalDraftActive
      />
    )

    expect(screen.getByTestId('goal-draft-pill')).toHaveTextContent('目标')
    expect(screen.queryByTestId('plan-mode-pill')).not.toBeInTheDocument()
  })

  test('shows desktop pause button while the assistant is streaming', async () => {
    const onPause = vi.fn()

    render(
      <ChatInput
        value=""
        onChange={vi.fn()}
        onSubmit={vi.fn()}
        disabled={false}
        variant="desktop"
        isStreaming
        onPause={onPause}
      />
    )

    expect(screen.getByTestId('pause-response-button')).toBeInTheDocument()
    expect(screen.queryByTestId('send-message-button')).not.toBeInTheDocument()

    await userEvent.click(screen.getByTestId('pause-response-button'))

    expect(onPause).toHaveBeenCalledTimes(1)
  })

  test('renders queued messages and guidance controls above the composer', async () => {
    const queuedMessages: QueuedWorkbenchMessage[] = [
      {
        id: 'queued-1',
        content: '继续检查 capability sync',
        status: 'queued',
        createdAt: '2026-05-25T15:08:00.000+08:00',
      },
    ]
    const guidanceMessages: GuidanceWorkbenchMessage[] = [
      {
        id: 'guidance-1',
        content: '先跳过 device:sync_capabilities',
        status: 'queued',
        createdAt: '2026-05-25T15:09:00.000+08:00',
      },
    ]
    const onSendQueuedAsGuidance = vi.fn()
    const onCancelQueuedMessage = vi.fn()
    const onEditQueuedMessage = vi.fn()

    render(
      <ChatInput
        value=""
        onChange={vi.fn()}
        onSubmit={vi.fn()}
        disabled={false}
        variant="desktop"
        queuedMessages={queuedMessages}
        guidanceMessages={guidanceMessages}
        onSendQueuedAsGuidance={onSendQueuedAsGuidance}
        onCancelQueuedMessage={onCancelQueuedMessage}
        onEditQueuedMessage={onEditQueuedMessage}
      />
    )

    expect(screen.getByTestId('conversation-queue-panel')).toBeInTheDocument()
    expect(screen.getByText('继续检查 capability sync')).toBeInTheDocument()
    expect(screen.getByText('先跳过 device:sync_capabilities')).toBeInTheDocument()

    await userEvent.click(screen.getByTestId('queue-guidance-button-queued-1'))
    await userEvent.click(screen.getByTestId('queue-more-button-queued-1'))
    await userEvent.click(screen.getByTestId('queue-edit-button-queued-1'))
    await userEvent.click(screen.getByTestId('queue-cancel-button-queued-1'))

    expect(onSendQueuedAsGuidance).toHaveBeenCalledWith('queued-1')
    expect(onEditQueuedMessage).toHaveBeenCalledWith('queued-1')
    expect(onCancelQueuedMessage).toHaveBeenCalledWith('queued-1')
  })

  test('keeps queued rows compact without generic queue notices', () => {
    const queuedMessages: QueuedWorkbenchMessage[] = [
      {
        id: 'queued-notice',
        content: '执行pwd',
        status: 'queued',
        createdAt: '2026-05-25T15:08:00.000+08:00',
        notice: '已排队，当前回复结束后发送',
      },
    ]

    render(
      <ChatInput
        value=""
        onChange={vi.fn()}
        onSubmit={vi.fn()}
        disabled={false}
        variant="desktop"
        queuedMessages={queuedMessages}
        guidanceMessages={[]}
      />
    )

    expect(screen.getByText('执行pwd')).toBeInTheDocument()
    expect(screen.queryByText('已排队，当前回复结束后发送')).not.toBeInTheDocument()
  })

  test('shows sending notices for queued rows that are actively being sent', () => {
    const queuedMessages: QueuedWorkbenchMessage[] = [
      {
        id: 'queued-sending',
        content: '执行ls',
        status: 'sending',
        createdAt: '2026-05-25T15:08:00.000+08:00',
        notice: '正在发送',
      },
    ]

    render(
      <ChatInput
        value=""
        onChange={vi.fn()}
        onSubmit={vi.fn()}
        disabled={false}
        variant="desktop"
        queuedMessages={queuedMessages}
        guidanceMessages={[]}
      />
    )

    expect(screen.getByText('执行ls')).toBeInTheDocument()
    expect(screen.getByText('正在发送')).toBeInTheDocument()
  })

  test('keeps the compact mobile composer close to one-line input height', () => {
    render(<ChatInput value="" onChange={vi.fn()} onSubmit={vi.fn()} disabled={false} />)

    const form = screen.getByTestId('chat-message-input').closest('form')

    expect(form).toHaveClass('items-end')
    expect(screen.getByTestId('add-context-button')).toHaveClass(
      'h-[52px]',
      'w-[52px]',
      'rounded-[26px]'
    )
    expect(screen.getByTestId('compact-input-pill')).toHaveClass('min-h-[52px]')
    expect(screen.getByTestId('chat-message-input')).toHaveClass(
      'py-[14px]',
      'scrollbar-none',
      'text-sm',
      'leading-5'
    )
    expect(screen.getByTestId('send-message-button')).toHaveClass(
      'absolute',
      'bottom-1',
      'right-1',
      'h-11',
      'w-11',
      'rounded-[22px]'
    )
  })

  test('shows compact pause button while the assistant is streaming', async () => {
    const onPause = vi.fn()

    render(
      <ChatInput
        value=""
        onChange={vi.fn()}
        onSubmit={vi.fn()}
        disabled={false}
        isStreaming
        onPause={onPause}
      />
    )

    expect(screen.getByTestId('pause-response-button')).toHaveClass(
      'absolute',
      'bottom-1',
      'right-1',
      'h-11',
      'w-11'
    )
    expect(screen.queryByTestId('send-message-button')).not.toBeInTheDocument()

    await userEvent.click(screen.getByTestId('pause-response-button'))

    expect(onPause).toHaveBeenCalledTimes(1)
  })

  test('does not render voice input in the compact composer', async () => {
    render(<ControlledChatInput />)

    expect(screen.queryByTestId('voice-input-button')).not.toBeInTheDocument()
    await userEvent.type(screen.getByTestId('chat-message-input'), 'hello')

    expect(screen.queryByTestId('voice-input-button')).not.toBeInTheDocument()
    expect(screen.getByTestId('compact-input-pill')).toHaveClass('pr-14')
    expect(screen.getByTestId('send-message-button')).toHaveClass('bottom-1', 'right-1')
  })

  test('opens local skill autocomplete after a standalone dollar trigger', async () => {
    const skill: LocalDeviceSkill = {
      name: 'env-context',
      description: 'Use when environment facts are needed',
      short_description: 'Environment facts',
      path: '/Users/crystal/.codex/skills/env-context/SKILL.md',
      source: 'codex',
    }
    const listLocalSkills = vi.fn().mockResolvedValue([skill])

    render(<ControlledChatInput projectChat={projectChatControls({ listLocalSkills })} />)

    await userEvent.type(screen.getByTestId('chat-message-input'), '$')

    await waitFor(() => {
      expect(listLocalSkills).toHaveBeenCalledTimes(1)
    })
    expect(screen.getByTestId('local-skill-autocomplete')).toHaveClass(
      'bottom-[calc(100%+0.5rem)]',
      'z-popover',
      'bg-background',
      'left-[-1rem]',
      'right-[-3.5rem]'
    )
    await userEvent.click(await screen.findByTestId('local-skill-option-env-context'))

    expect(screen.getByTestId('chat-message-input')).toHaveValue(
      '[$env-context](skill:///Users/crystal/.codex/skills/env-context/SKILL.md) '
    )
    expect(screen.getByTestId('local-skill-chip-env-context')).toHaveTextContent('Env Context')
    expect(await screen.findByTestId('local-skill-caret')).toHaveClass(
      'local-skill-caret',
      'bg-text-primary'
    )
  })

  test('selects plan mode from the slash command menu', async () => {
    const setSelectedModelOption = vi.fn()
    const onSubmit = vi.fn()
    render(
      <ControlledChatInput
        onSubmit={onSubmit}
        variant="desktop"
        projectChat={projectChatControls({ setSelectedModelOption })}
      />
    )

    const input = screen.getByTestId('chat-message-input')
    await userEvent.type(input, '/pla')

    expect(screen.getByTestId('slash-command-menu')).toBeInTheDocument()
    expect(screen.getByTestId('slash-command-menu')).not.toHaveTextContent(
      'workbench.slash_command_menu_title'
    )
    expect(screen.getByTestId('slash-command-menu')).not.toHaveTextContent(
      'workbench.slash_command_group_actions'
    )
    expect(screen.getByTestId('slash-command-option-plan')).toHaveTextContent(
      'workbench.slash_command_plan'
    )
    expect(screen.getByTestId('slash-command-option-plan')).toHaveClass('rounded-lg')

    await userEvent.keyboard('{Enter}')

    await waitFor(() => {
      expect(setSelectedModelOption).toHaveBeenCalledWith('collaborationMode', 'plan')
    })
    expect(onSubmit).not.toHaveBeenCalled()
    expect(input).toHaveValue('')
  })

  test('opens goal draft mode from a compact slash command', async () => {
    function GoalDraftSlashInput() {
      const [value, setValue] = useState('')
      const [goalDraftActive, setGoalDraftActive] = useState(false)

      return (
        <ChatInput
          value={value}
          onChange={setValue}
          onSubmit={vi.fn()}
          disabled={false}
          goalDraftActive={goalDraftActive}
          onSetGoal={() => setGoalDraftActive(true)}
          onCancelGoalDraft={() => setGoalDraftActive(false)}
          projectChat={projectChatControls()}
        />
      )
    }

    render(<GoalDraftSlashInput />)

    await userEvent.type(screen.getByTestId('chat-message-input'), '/goal')
    await userEvent.keyboard('{Enter}')

    await waitFor(() => {
      expect(screen.getByTestId('goal-draft-pill')).toHaveTextContent('目标')
    })
    expect(screen.getByTestId('chat-message-input')).toHaveValue('')
  })

  test('opens a model-only list from the slash command menu', async () => {
    const selectedModel: UnifiedModel = {
      name: 'gpt-5.5',
      type: 'public',
      displayName: 'GPT-5.5',
      runtime: { family: 'openai.openai-responses' },
      config: {
        ui: {
          family: 'gpt',
          modelLabel: 'GPT-5.5',
          sortOrder: 10,
          description: 'Frontier model for complex coding, research, and real-world work.',
        },
      },
    }
    const sparkModel: UnifiedModel = {
      name: 'gpt-5.3-codex-spark',
      type: 'public',
      displayName: 'GPT-5.3-Codex-Spark',
      runtime: { family: 'openai.openai-responses' },
      config: {
        ui: {
          family: 'gpt',
          modelLabel: 'GPT-5.3-Codex-Spark',
          sortOrder: 40,
          description: 'Ultra-fast coding model.',
        },
      },
    }
    const setSelectedModel = vi.fn()

    render(
      <ControlledChatInput
        variant="desktop"
        projectChat={projectChatControls({
          models: [sparkModel, selectedModel],
          selectedModel,
          setSelectedModel,
        })}
      />
    )

    await userEvent.type(screen.getByTestId('chat-message-input'), '/model')
    await userEvent.keyboard('{Enter}')

    await waitFor(() => {
      expect(screen.getByTestId('slash-model-menu')).toBeInTheDocument()
    })
    expect(screen.queryByTestId('model-selector-menu')).not.toBeInTheDocument()
    expect(screen.queryByTestId('model-family-gpt')).not.toBeInTheDocument()
    expect(screen.queryByTestId('model-control-reasoning-high')).not.toBeInTheDocument()
    expect(screen.getByTestId('slash-model-search-input')).toBeInTheDocument()
    expect(screen.getByTestId('slash-model-option-gpt-5.5')).toHaveTextContent(
      'Frontier model for complex coding'
    )
    expect(screen.getByTestId('chat-message-input')).toHaveValue('')

    await userEvent.click(screen.getByTestId('slash-model-option-gpt-5.3-codex-spark'))

    expect(setSelectedModel).toHaveBeenCalledWith(sparkModel)
    expect(screen.queryByTestId('slash-model-menu')).not.toBeInTheDocument()
  })

  test('inserts a local skill mention from slash commands', async () => {
    const skill: LocalDeviceSkill = {
      name: 'env-context',
      description: 'Use when environment facts are needed',
      short_description: 'Environment facts',
      path: '/Users/crystal/.codex/skills/env-context/SKILL.md',
      source: 'codex',
      scope: 'user',
    }
    const listLocalSkills = vi.fn().mockResolvedValue([skill])

    render(<ControlledChatInput projectChat={projectChatControls({ listLocalSkills })} />)

    const input = screen.getByTestId('chat-message-input')
    await userEvent.type(input, '/env')
    const slashSkillOption = await screen.findByTestId('slash-command-option-skill-env-context')
    expect(slashSkillOption).toHaveTextContent('Personal')
    await userEvent.click(slashSkillOption)

    expect(input).toHaveValue(
      '[$env-context](skill:///Users/crystal/.codex/skills/env-context/SKILL.md) '
    )
    expect(screen.getByTestId('local-skill-chip-env-context')).toHaveTextContent('Env Context')
  })

  test('filters slash skills by name and aliases without duplicating skill rows', async () => {
    const skills: LocalDeviceSkill[] = [
      {
        name: 'imagegen',
        description: 'Generate or edit raster images',
        path: '/Users/crystal/.codex/skills/imagegen/SKILL.md',
        source: 'codex',
        scope: 'user',
        source_priority: 0,
      },
      {
        name: 'gmail',
        description: 'Search images and attachments in email',
        path: '/Users/crystal/.codex/plugins/cache/openai-curated/gmail/old/skills/gmail/SKILL.md',
        source: 'codex-plugin',
        scope: 'user',
        source_priority: 40,
      },
      {
        name: 'gmail',
        description: 'Manage Gmail inbox',
        path: '/Users/crystal/.codex/plugins/cache/openai-curated-remote/gmail/0.1.3/skills/gmail/SKILL.md',
        source: 'codex-plugin',
        scope: 'user',
        source_priority: 20,
      },
    ]
    const listLocalSkills = vi.fn().mockResolvedValue(skills)

    render(<ControlledChatInput projectChat={projectChatControls({ listLocalSkills })} />)

    await userEvent.type(screen.getByTestId('chat-message-input'), '/image')

    expect(await screen.findByTestId('slash-command-option-skill-imagegen')).toBeInTheDocument()
    expect(screen.queryByTestId('slash-command-option-skill-gmail')).not.toBeInTheDocument()

    await userEvent.clear(screen.getByTestId('chat-message-input'))
    await userEvent.type(screen.getByTestId('chat-message-input'), '/gmail')

    expect(await screen.findAllByTestId('slash-command-option-skill-gmail')).toHaveLength(1)
  })

  test('does not open slash commands for a slash inside a word', async () => {
    render(<ControlledChatInput projectChat={projectChatControls()} />)

    await userEvent.type(screen.getByTestId('chat-message-input'), 'hello/')

    expect(screen.queryByTestId('slash-command-menu')).not.toBeInTheDocument()
  })

  test('closes slash commands with Escape and outside pointer down', async () => {
    render(<ControlledChatInput projectChat={projectChatControls()} />)

    const input = screen.getByTestId('chat-message-input')
    await userEvent.type(input, '/')
    expect(screen.getByTestId('slash-command-menu')).toBeInTheDocument()

    fireEvent.keyDown(input, { key: 'Escape' })
    await waitFor(() => {
      expect(screen.queryByTestId('slash-command-menu')).not.toBeInTheDocument()
    })

    await userEvent.clear(input)
    await userEvent.type(input, '/')
    expect(screen.getByTestId('slash-command-menu')).toBeInTheDocument()

    fireEvent.pointerDown(document.body)
    await waitFor(() => {
      expect(screen.queryByTestId('slash-command-menu')).not.toBeInTheDocument()
    })
  })

  test('keeps only one local skill autocomplete option highlighted', async () => {
    const chronicleSkill: LocalDeviceSkill = {
      name: 'chronicle',
      description: 'Allows you to view the user screen history',
      short_description: 'Screen history',
      path: '/Users/crystal/.codex/skills/chronicle/SKILL.md',
      source: 'codex',
    }
    const dingtalkSkill: LocalDeviceSkill = {
      name: 'dingtalk-ai-table',
      description: 'Use DingTalk AI Table data',
      short_description: 'DingTalk AI Table',
      path: '/Users/crystal/.claude/skills/dingtalk-ai-table/SKILL.md',
      source: 'claude',
    }
    const listLocalSkills = vi.fn().mockResolvedValue([chronicleSkill, dingtalkSkill])

    render(<ControlledChatInput projectChat={projectChatControls({ listLocalSkills })} />)

    await userEvent.type(screen.getByTestId('chat-message-input'), '$')

    const firstOption = await screen.findByTestId('local-skill-option-chronicle')
    const secondOption = await screen.findByTestId('local-skill-option-dingtalk-ai-table')

    expect(firstOption).toHaveClass('bg-muted')
    expect(firstOption).toHaveAttribute('aria-selected', 'true')
    expect(secondOption).not.toHaveClass('bg-muted')
    expect(secondOption).toHaveAttribute('aria-selected', 'false')

    fireEvent.pointerEnter(secondOption)

    await waitFor(() => {
      expect(firstOption).not.toHaveClass('bg-muted')
      expect(firstOption).toHaveAttribute('aria-selected', 'false')
      expect(secondOption).toHaveClass('bg-muted')
      expect(secondOption).toHaveAttribute('aria-selected', 'true')
    })
  })

  test('shows local skill scopes at the end of each autocomplete option', async () => {
    const skills: LocalDeviceSkill[] = [
      {
        name: 'personal-skill',
        description: 'Codex skill',
        path: '/Users/crystal/.codex/skills/personal-skill/SKILL.md',
        source: 'codex',
        scope: 'user',
      },
      {
        name: 'system-skill',
        description: 'Codex plugin skill',
        path: '/Users/crystal/.codex/plugins/cache/openai-bundled/plugin/1.0.0/skills/system-skill/SKILL.md',
        source: 'codex-plugin',
        scope: 'system',
      },
    ]
    const listLocalSkills = vi.fn().mockResolvedValue(skills)

    render(<ControlledChatInput projectChat={projectChatControls({ listLocalSkills })} />)

    await userEvent.type(screen.getByTestId('chat-message-input'), '$')

    expect(await screen.findByTestId('local-skill-source-personal-skill')).toHaveTextContent(
      'Personal'
    )
    expect(screen.getByTestId('local-skill-source-system-skill')).toHaveTextContent('System')
  })

  test('only allows Claude sourced skills for Claude models', async () => {
    const onSubmit = vi.fn()
    const claudeSkill: LocalDeviceSkill = {
      name: 'claude-skill',
      description: 'Claude skill',
      path: '/Users/crystal/.claude/skills/claude-skill/SKILL.md',
      source: 'claude',
    }
    const agentsSkill: LocalDeviceSkill = {
      name: 'agents-skill',
      description: 'Shared agents skill',
      path: '/Users/crystal/.agents/skills/agents-skill/SKILL.md',
      source: 'agents',
    }
    const codexSkill: LocalDeviceSkill = {
      name: 'codex-skill',
      description: 'Codex skill',
      path: '/Users/crystal/.codex/skills/codex-skill/SKILL.md',
      source: 'codex',
    }
    const selectedModel: UnifiedModel = {
      name: 'wecode-claude-sonnet-4-5',
      type: 'public',
      runtime: { family: 'claude.claude' },
    }

    render(
      <ControlledChatInput
        onSubmit={onSubmit}
        projectChat={projectChatControls({
          selectedModel,
          listLocalSkills: vi.fn().mockResolvedValue([claudeSkill, agentsSkill, codexSkill]),
        })}
      />
    )

    await userEvent.type(screen.getByTestId('chat-message-input'), '$')

    expect(await screen.findByTestId('local-skill-option-claude-skill')).not.toBeDisabled()
    expect(screen.getByTestId('local-skill-option-agents-skill')).not.toBeDisabled()
    expect(screen.getByTestId('local-skill-option-codex-skill')).toBeDisabled()

    await userEvent.click(screen.getByTestId('local-skill-option-codex-skill'))
    expect(screen.getByTestId('chat-message-input')).toHaveValue('$')
  })

  test('only allows Codex sourced skills for GPT models', async () => {
    const codexSkill: LocalDeviceSkill = {
      name: 'codex-skill',
      description: 'Codex skill',
      path: '/Users/crystal/.codex/skills/codex-skill/SKILL.md',
      source: 'codex-plugin',
    }
    const agentsSkill: LocalDeviceSkill = {
      name: 'agents-skill',
      description: 'Shared agents skill',
      path: '/Users/crystal/.agents/skills/agents-skill/SKILL.md',
      source: 'agents',
    }
    const claudeSkill: LocalDeviceSkill = {
      name: 'claude-skill',
      description: 'Claude skill',
      path: '/Users/crystal/.claude/skills/claude-skill/SKILL.md',
      source: 'claude',
    }
    const selectedModel: UnifiedModel = {
      name: 'gpt-5.5',
      type: 'public',
      runtime: { family: 'openai.openai-responses' },
    }

    render(
      <ControlledChatInput
        projectChat={projectChatControls({
          selectedModel,
          listLocalSkills: vi.fn().mockResolvedValue([codexSkill, agentsSkill, claudeSkill]),
        })}
      />
    )

    await userEvent.type(screen.getByTestId('chat-message-input'), '$')

    const option = await screen.findByTestId('local-skill-option-codex-skill')
    expect(option).toBeInTheDocument()
    expect(option).not.toBeDisabled()
    expect(screen.getByTestId('local-skill-option-agents-skill')).not.toBeDisabled()
    expect(screen.getByTestId('local-skill-source-codex-skill')).toHaveTextContent('Personal')
    expect(screen.getByTestId('local-skill-option-claude-skill')).toBeDisabled()

    await userEvent.click(option)
    expect(screen.getByTestId('chat-message-input')).toHaveValue(
      '[$codex-skill](skill:///Users/crystal/.codex/skills/codex-skill/SKILL.md) '
    )
  })

  test('allows Codex sourced skills for non-GPT models running through openai responses', async () => {
    const codexSkill: LocalDeviceSkill = {
      name: 'codex-skill',
      description: 'Codex skill',
      path: '/Users/crystal/.codex/skills/codex-skill/SKILL.md',
      source: 'codex-plugin',
    }
    const claudeSkill: LocalDeviceSkill = {
      name: 'claude-skill',
      description: 'Claude skill',
      path: '/Users/crystal/.claude/skills/claude-skill/SKILL.md',
      source: 'claude',
    }
    const selectedModel: UnifiedModel = {
      name: 'sina-glm-4.6',
      type: 'public',
      displayName: '内网:sina-glm-4.6',
      modelId: 'glm-4.6',
      runtime: { family: 'sina.openai-responses' },
    }

    render(
      <ControlledChatInput
        projectChat={projectChatControls({
          selectedModel,
          listLocalSkills: vi.fn().mockResolvedValue([codexSkill, claudeSkill]),
        })}
      />
    )

    await userEvent.type(screen.getByTestId('chat-message-input'), '$')

    const option = await screen.findByTestId('local-skill-option-codex-skill')
    expect(option).not.toBeDisabled()
    expect(screen.getByTestId('local-skill-option-claude-skill')).toBeDisabled()

    await userEvent.click(option)
    expect(screen.getByTestId('chat-message-input')).toHaveValue(
      '[$codex-skill](skill:///Users/crystal/.codex/skills/codex-skill/SKILL.md) '
    )
  })

  test('uses modelConfig env model when matching local skills', async () => {
    const codexSkill: LocalDeviceSkill = {
      name: 'codex-skill',
      description: 'Codex skill',
      path: '/Users/crystal/.codex/skills/codex-skill/SKILL.md',
      source: 'codex-plugin',
    }
    const claudeSkill: LocalDeviceSkill = {
      name: 'claude-skill',
      description: 'Claude skill',
      path: '/Users/crystal/.claude/skills/claude-skill/SKILL.md',
      source: 'claude',
    }
    const selectedModel: UnifiedModel = {
      name: 'sina-glm-4.6',
      type: 'public',
      displayName: '内网:sina-glm-4.6',
      modelId: 'glm-4.6',
      config: {
        env: { model: 'openai' },
        apiFormat: 'responses',
      },
    }

    render(
      <ControlledChatInput
        projectChat={projectChatControls({
          selectedModel,
          listLocalSkills: vi.fn().mockResolvedValue([codexSkill, claudeSkill]),
        })}
      />
    )

    await userEvent.type(screen.getByTestId('chat-message-input'), '$')

    expect(await screen.findByTestId('local-skill-option-codex-skill')).not.toBeDisabled()
    expect(screen.getByTestId('local-skill-option-claude-skill')).toBeDisabled()
  })

  test('uses runtime provider from modelConfig env model when matching local skills', async () => {
    const codexSkill: LocalDeviceSkill = {
      name: 'codex-skill',
      description: 'Codex skill',
      path: '/Users/crystal/.codex/skills/codex-skill/SKILL.md',
      source: 'codex-plugin',
    }
    const claudeSkill: LocalDeviceSkill = {
      name: 'claude-skill',
      description: 'Claude skill',
      path: '/Users/crystal/.claude/skills/claude-skill/SKILL.md',
      source: 'claude',
    }
    const selectedModel: UnifiedModel = {
      name: 'sina-glm-4.6',
      type: 'public',
      displayName: '内网:sina-glm-4.6',
      modelId: 'glm-4.6',
      runtime: { family: 'openai', provider: 'openai' },
    }

    render(
      <ControlledChatInput
        projectChat={projectChatControls({
          selectedModel,
          listLocalSkills: vi.fn().mockResolvedValue([codexSkill, claudeSkill]),
        })}
      />
    )

    await userEvent.type(screen.getByTestId('chat-message-input'), '$')

    expect(await screen.findByTestId('local-skill-option-codex-skill')).not.toBeDisabled()
    expect(screen.getByTestId('local-skill-option-claude-skill')).toBeDisabled()
  })

  test('keeps the composer editable after selecting a local skill', async () => {
    const skill: LocalDeviceSkill = {
      name: 'env-context',
      description: 'Use when environment facts are needed',
      short_description: 'Environment facts',
      path: '/Users/crystal/.codex/skills/env-context/SKILL.md',
      source: 'codex',
    }
    const listLocalSkills = vi.fn().mockResolvedValue([skill])

    render(<ControlledChatInput projectChat={projectChatControls({ listLocalSkills })} />)

    const input = screen.getByTestId('chat-message-input')
    await userEvent.type(input, '$')
    await userEvent.click(await screen.findByTestId('local-skill-option-env-context'))
    await waitFor(() => {
      expect(input).toHaveFocus()
    })
    await userEvent.type(input, 'hello')

    expect(input).toHaveValue(
      '[$env-context](skill:///Users/crystal/.codex/skills/env-context/SKILL.md) hello'
    )
    expect(screen.getByTestId('local-skill-chip-env-context')).toHaveTextContent('Env Context')
  })

  test('deletes a selected local skill mention as one unit', async () => {
    const skill: LocalDeviceSkill = {
      name: 'env-context',
      description: 'Use when environment facts are needed',
      short_description: 'Environment facts',
      path: '/Users/crystal/.codex/skills/env-context/SKILL.md',
      source: 'codex',
    }
    const listLocalSkills = vi.fn().mockResolvedValue([skill])

    render(<ControlledChatInput projectChat={projectChatControls({ listLocalSkills })} />)

    await userEvent.type(screen.getByTestId('chat-message-input'), '$')
    await userEvent.click(await screen.findByTestId('local-skill-option-env-context'))
    await waitFor(() => {
      expect(screen.getByTestId('chat-message-input')).toHaveFocus()
    })
    await userEvent.keyboard('{Backspace}')

    expect(screen.getByTestId('chat-message-input')).toHaveValue('')
    expect(screen.queryByTestId('local-skill-chip-env-context')).not.toBeInTheDocument()
  })

  test('sizes desktop local skill autocomplete to the composer width', async () => {
    const skill: LocalDeviceSkill = {
      name: 'env-context',
      description: 'Use when environment facts are needed',
      short_description: 'Environment facts',
      path: '/Users/crystal/.codex/skills/env-context/SKILL.md',
      source: 'codex',
    }
    const listLocalSkills = vi.fn().mockResolvedValue([skill])

    render(
      <ControlledChatInput
        variant="desktop"
        projectChat={projectChatControls({ listLocalSkills })}
      />
    )

    await userEvent.type(screen.getByTestId('chat-message-input'), '$')

    expect(await screen.findByTestId('local-skill-autocomplete')).toHaveClass(
      'left-[-1rem]',
      'right-[-0.5rem]',
      'rounded-xl',
      'shadow-[0_12px_34px_rgba(0,0,0,0.12)]'
    )
  })

  test('opens local skill autocomplete under React StrictMode', async () => {
    const skill: LocalDeviceSkill = {
      name: 'env-context',
      description: 'Use when environment facts are needed',
      short_description: 'Environment facts',
      path: '/Users/crystal/.codex/skills/env-context/SKILL.md',
      source: 'codex',
    }
    const listLocalSkills = vi.fn().mockResolvedValue([skill])

    render(
      <StrictMode>
        <ControlledChatInput projectChat={projectChatControls({ listLocalSkills })} />
      </StrictMode>
    )

    await userEvent.type(screen.getByTestId('chat-message-input'), '$')

    expect(await screen.findByTestId('local-skill-option-env-context')).toBeInTheDocument()
  })

  test('retries local skill loading from the autocomplete error state', async () => {
    const skill: LocalDeviceSkill = {
      name: 'env-context',
      description: 'Use when environment facts are needed',
      short_description: 'Environment facts',
      path: '/Users/crystal/.codex/skills/env-context/SKILL.md',
      source: 'codex',
    }
    let retryEnabled = false
    const listLocalSkills = vi.fn().mockImplementation(() => {
      if (!retryEnabled) {
        return Promise.reject(new Error('Device is offline'))
      }
      return Promise.resolve([skill])
    })

    render(<ControlledChatInput projectChat={projectChatControls({ listLocalSkills })} />)

    await userEvent.type(screen.getByTestId('chat-message-input'), '$')

    const retryLabel = await screen.findByTestId('local-skill-retry-label')
    expect(retryLabel).toHaveClass('text-text-secondary')
    expect(retryLabel).not.toHaveClass('text-primary')
    expect(screen.getByTestId('local-skill-load-error')).toHaveClass(
      'hover:bg-muted',
      'text-text-muted'
    )

    retryEnabled = true
    await userEvent.click(
      screen.getByRole('button', {
        name: /workbench.local_skills_error.*workbench.retry_local_skills/,
      })
    )

    expect(await screen.findByTestId('local-skill-option-env-context')).toBeInTheDocument()
    expect(listLocalSkills).toHaveBeenCalled()
  })

  test('does not open local skill autocomplete for a dollar inside a word', async () => {
    const listLocalSkills = vi.fn().mockResolvedValue([])

    render(<ControlledChatInput projectChat={projectChatControls({ listLocalSkills })} />)

    await userEvent.type(screen.getByTestId('chat-message-input'), 'hello$')

    expect(listLocalSkills).not.toHaveBeenCalled()
    expect(screen.queryByTestId('local-skill-autocomplete')).not.toBeInTheDocument()
  })

  test('opens a mobile context sheet that uploads files without type restrictions', async () => {
    const handleFileSelect = vi.fn().mockResolvedValue(undefined)
    const script = new File(['#!/bin/sh'], 'init_env.sh', {
      type: 'application/x-sh',
    })

    render(
      <ChatInput
        value=""
        onChange={vi.fn()}
        onSubmit={vi.fn()}
        disabled={false}
        projectChat={projectChatControls({ handleFileSelect })}
      />
    )

    await userEvent.click(screen.getByTestId('add-context-button'))

    expect(screen.getByTestId('mobile-context-sheet')).toBeInTheDocument()
    expect(screen.getByTestId('mobile-take-photo-button')).toHaveTextContent('拍照')
    expect(screen.getByTestId('mobile-upload-image-button')).toHaveTextContent('上传文件')
    expect(screen.queryByText('添加照片和文件')).not.toBeInTheDocument()
    expect(screen.getByTestId('mobile-camera-file-input')).toHaveAttribute('accept', 'image/*')
    expect(screen.getByTestId('mobile-camera-file-input')).toHaveAttribute('capture', 'environment')
    expect(screen.getByTestId('mobile-image-file-input')).not.toHaveAttribute('accept')

    await userEvent.upload(screen.getByTestId('mobile-image-file-input'), script)

    expect(handleFileSelect).toHaveBeenCalledWith([script])
    expect(screen.queryByTestId('mobile-context-sheet')).not.toBeInTheDocument()
  })

  test('opens the compact context sheet with plan and goal actions', async () => {
    const setSelectedModelOption = vi.fn()
    const onSetGoal = vi.fn()

    render(
      <ChatInput
        value=""
        onChange={vi.fn()}
        onSubmit={vi.fn()}
        disabled={false}
        projectChat={projectChatControls({ setSelectedModelOption })}
        onSetGoal={onSetGoal}
      />
    )

    await userEvent.click(screen.getByTestId('add-context-button'))

    expect(screen.getByTestId('mobile-context-sheet')).toBeInTheDocument()
    expect(screen.getByTestId('mobile-set-plan-mode-button')).toHaveTextContent('计划模式')
    expect(screen.getByTestId('mobile-set-goal-button')).toHaveTextContent('追求目标')

    await userEvent.click(screen.getByTestId('mobile-set-plan-mode-button'))

    expect(setSelectedModelOption).toHaveBeenCalledWith('collaborationMode', 'plan')
    expect(screen.queryByTestId('mobile-context-sheet')).not.toBeInTheDocument()

    await userEvent.click(screen.getByTestId('add-context-button'))
    await userEvent.click(screen.getByTestId('mobile-set-goal-button'))

    expect(onSetGoal).toHaveBeenCalledTimes(1)
    expect(screen.queryByTestId('mobile-context-sheet')).not.toBeInTheDocument()
  })

  test('desktop file picker does not restrict attachment file types', async () => {
    render(
      <ChatInput
        value=""
        onChange={vi.fn()}
        onSubmit={vi.fn()}
        disabled={false}
        variant="desktop"
      />
    )

    await userEvent.click(screen.getByTestId('add-context-button'))

    expect(screen.getByTestId('attachment-file-input')).not.toHaveAttribute('accept')
  })

  test('uploads pasted images from the desktop message textbox', () => {
    const handleFileSelect = vi.fn().mockResolvedValue(undefined)
    const image = new File(['image'], 'clipboard.png', { type: 'image/png' })

    render(
      <ChatInput
        value=""
        onChange={vi.fn()}
        onSubmit={vi.fn()}
        disabled={false}
        variant="desktop"
        projectChat={projectChatControls({ handleFileSelect })}
      />
    )

    fireEvent.paste(screen.getByTestId('chat-message-input'), {
      clipboardData: {
        files: [image],
      },
    })

    expect(handleFileSelect).toHaveBeenCalledWith([image])
  })

  test('uploads pasted documents from the desktop message textbox', () => {
    const handleFileSelect = vi.fn().mockResolvedValue(undefined)
    const documentFile = new File(['document'], 'requirements.pdf', {
      type: 'application/pdf',
    })

    render(
      <ChatInput
        value=""
        onChange={vi.fn()}
        onSubmit={vi.fn()}
        disabled={false}
        variant="desktop"
        projectChat={projectChatControls({ handleFileSelect })}
      />
    )

    fireEvent.paste(screen.getByTestId('chat-message-input'), {
      clipboardData: {
        files: [documentFile],
      },
    })

    expect(handleFileSelect).toHaveBeenCalledWith([documentFile])
  })

  test('turns long pasted text from the desktop message textbox into a text attachment', async () => {
    const handleFileSelect = vi.fn().mockResolvedValue(undefined)
    const onChange = vi.fn()
    const longText = 'long pasted text\n'.repeat(400)

    render(
      <ChatInput
        value=""
        onChange={onChange}
        onSubmit={vi.fn()}
        disabled={false}
        variant="desktop"
        projectChat={projectChatControls({ handleFileSelect })}
      />
    )

    fireEvent.paste(screen.getByTestId('chat-message-input'), {
      clipboardData: {
        files: [],
        getData: (type: string) => (type === 'text/plain' ? longText : ''),
      },
    })

    expect(onChange).not.toHaveBeenCalled()
    expect(handleFileSelect).toHaveBeenCalledTimes(1)
    const files = handleFileSelect.mock.calls[0][0] as File[]
    expect(files).toHaveLength(1)
    expect(files[0].name).toMatch(/^clipboard-text-\d+\.txt$/)
    expect(files[0].type).toBe('text/plain')
    expect(await files[0].text()).toBe(longText)
  })

  test('uploads dropped files from the desktop composer', () => {
    const handleFileSelect = vi.fn().mockResolvedValue(undefined)
    const documentFile = new File(['document'], 'drop-requirements.pdf', {
      type: 'application/pdf',
    })

    render(
      <ChatInput
        value=""
        onChange={vi.fn()}
        onSubmit={vi.fn()}
        disabled={false}
        variant="desktop"
        projectChat={projectChatControls({ handleFileSelect })}
      />
    )

    fireEvent.drop(screen.getByTestId('chat-message-input'), {
      dataTransfer: {
        types: ['Files'],
        files: [documentFile],
      },
    })

    expect(handleFileSelect).toHaveBeenCalledWith([documentFile])
  })

  test('uploads pasted images from the fullscreen compact textbox', async () => {
    const handleFileSelect = vi.fn().mockResolvedValue(undefined)
    const image = new File(['image'], 'fullscreen-clipboard.png', { type: 'image/png' })

    render(
      <ChatInput
        value={'line 1\nline 2\nline 3\nline 4\nline 5'}
        onChange={vi.fn()}
        onSubmit={vi.fn()}
        disabled={false}
        projectChat={projectChatControls({ handleFileSelect })}
      />
    )

    await userEvent.click(screen.getByTestId('expand-input-button'))
    fireEvent.paste(screen.getByTestId('fullscreen-message-input'), {
      clipboardData: {
        files: [image],
      },
    })

    expect(handleFileSelect).toHaveBeenCalledWith([image])
  })

  test('uploads pasted documents from the fullscreen compact textbox', async () => {
    const handleFileSelect = vi.fn().mockResolvedValue(undefined)
    const documentFile = new File(['document'], 'fullscreen-requirements.pdf', {
      type: 'application/pdf',
    })

    render(
      <ChatInput
        value={'line 1\nline 2\nline 3\nline 4\nline 5'}
        onChange={vi.fn()}
        onSubmit={vi.fn()}
        disabled={false}
        projectChat={projectChatControls({ handleFileSelect })}
      />
    )

    await userEvent.click(screen.getByTestId('expand-input-button'))
    fireEvent.paste(screen.getByTestId('fullscreen-message-input'), {
      clipboardData: {
        files: [documentFile],
      },
    })

    expect(handleFileSelect).toHaveBeenCalledWith([documentFile])
  })

  test('turns long pasted text from the fullscreen compact textbox into a text attachment', async () => {
    const handleFileSelect = vi.fn().mockResolvedValue(undefined)
    const onChange = vi.fn()
    const longText = 'fullscreen pasted text\n'.repeat(400)

    render(
      <ChatInput
        value={'line 1\nline 2\nline 3\nline 4\nline 5'}
        onChange={onChange}
        onSubmit={vi.fn()}
        disabled={false}
        projectChat={projectChatControls({ handleFileSelect })}
      />
    )

    await userEvent.click(screen.getByTestId('expand-input-button'))
    fireEvent.paste(screen.getByTestId('fullscreen-message-input'), {
      clipboardData: {
        files: [],
        getData: (type: string) => (type === 'text/plain' ? longText : ''),
      },
    })

    expect(onChange).not.toHaveBeenCalled()
    expect(handleFileSelect).toHaveBeenCalledTimes(1)
    const files = handleFileSelect.mock.calls[0][0] as File[]
    expect(files).toHaveLength(1)
    expect(files[0].name).toMatch(/^clipboard-text-\d+\.txt$/)
    expect(files[0].type).toBe('text/plain')
    expect(await files[0].text()).toBe(longText)
  })

  test('enables compact send when only image attachments are present', async () => {
    const onSubmit = vi.fn()
    const attachment: Attachment = {
      id: 45,
      filename: 'photo.png',
      file_size: 1200,
      mime_type: 'image/png',
      status: 'ready',
      file_extension: '.png',
      created_at: '2026-05-27T00:00:00.000Z',
    }

    render(
      <ChatInput
        value=""
        onChange={vi.fn()}
        onSubmit={onSubmit}
        disabled={false}
        projectChat={projectChatControls({ attachments: [attachment] })}
      />
    )

    expect(screen.getByTestId('attachment-badge')).toBeInTheDocument()
    expect(screen.getByTestId('send-message-button')).toBeEnabled()
    await userEvent.click(screen.getByTestId('send-message-button'))
    expect(onSubmit).toHaveBeenCalledTimes(1)
  })

  test('expands compact input to fullscreen after more than four lines', async () => {
    render(<ControlledChatInput />)

    await userEvent.type(
      screen.getByTestId('chat-message-input'),
      ['one', 'two', 'three', 'four', 'five'].join('{shift>}{enter}{/shift}')
    )

    await userEvent.click(screen.getByTestId('expand-input-button'))

    expect(screen.getByTestId('fullscreen-input-sheet')).toBeInTheDocument()
    expect(screen.queryByText('编辑消息')).not.toBeInTheDocument()
    expect(screen.getByTestId('collapse-input-button')).toHaveClass('absolute', 'right-3', 'top-3')
    expect(screen.getByTestId('fullscreen-message-input')).toHaveClass(
      'h-full',
      'pt-14',
      'bg-background'
    )
    expect(screen.getByTestId('fullscreen-message-input')).toHaveValue(
      ['one', 'two', 'three', 'four', 'five'].join('\n')
    )

    await userEvent.type(screen.getByTestId('fullscreen-message-input'), '!')
    expect(screen.getByTestId('fullscreen-message-input')).toHaveValue(
      `${['one', 'two', 'three', 'four', 'five'].join('\n')}!`
    )

    await userEvent.click(screen.getByTestId('collapse-input-button'))
    expect(screen.queryByTestId('fullscreen-input-sheet')).not.toBeInTheDocument()
    expect(screen.getByTestId('chat-message-input')).toHaveValue(
      `${['one', 'two', 'three', 'four', 'five'].join('\n')}!`
    )
  })

  test('hides the project work bar when requested', () => {
    render(
      <ChatInput
        value=""
        onChange={vi.fn()}
        onSubmit={vi.fn()}
        disabled={false}
        variant="desktop"
        showProjectWorkBar={false}
      />
    )

    expect(screen.getByTestId('chat-message-input')).toBeInTheDocument()
    expect(screen.queryByTestId('project-work-button')).not.toBeInTheDocument()
  })

  test('opens the desktop model menu with real model options', async () => {
    const model: UnifiedModel = {
      name: 'overseas-gpt-5.5',
      type: 'user',
      displayName: '海外:gpt-5.5',
      config: {
        ui: {
          family: 'gpt',
          region: 'overseas',
          modelLabel: 'gpt-5.5',
          sortOrder: 10,
          controls: ['speed'],
        },
      },
    }
    const setSelectedModel = vi.fn()
    render(
      <ChatInput
        value=""
        onChange={vi.fn()}
        onSubmit={vi.fn()}
        disabled={false}
        variant="desktop"
        projectChat={projectChatControls({
          models: [model],
          selectedModel: model,
          selectedModelOptions: { reasoning: 'high', speed: 'standard' },
          setSelectedModel,
        })}
      />
    )

    await userEvent.click(screen.getByTestId('model-selector-button'))

    expect(screen.getByTestId('model-selector-menu')).toBeInTheDocument()
    expect(screen.getByTestId('model-selector-menu').parentElement).toHaveClass('right-0', 'w-64')
    expect(screen.getByTestId('model-selector-submenu')).toBeInTheDocument()
    expect(screen.getByTestId('model-family-gpt')).toBeInTheDocument()
    expect(screen.getByTestId('model-family-gpt')).toHaveTextContent('海外:gpt-5.5')
    expect(screen.getByTestId('model-selector-submenu')).toHaveStyle({ left: '256px' })
    expect(screen.getByTestId('model-control-reasoning-high')).toBeInTheDocument()
    expect(screen.queryByTestId('model-control-collaborationMode-default')).not.toBeInTheDocument()
    expect(screen.queryByTestId('model-control-collaborationMode-plan')).not.toBeInTheDocument()
    expect(screen.getByTestId('model-control-menu-speed')).toBeInTheDocument()
    expect(screen.queryByTestId('model-control-speed-fast')).not.toBeInTheDocument()
    expect(screen.queryByTestId('model-option-default')).not.toBeInTheDocument()
    expect(screen.getByTestId('model-selector-button')).toHaveTextContent('海外:gpt-5.5 High')
    const modelOption = screen.getByTestId('model-option-overseas-gpt-5.5')
    expect(modelOption).toHaveTextContent('海外:gpt-5.5')
    expect(modelOption).not.toHaveTextContent('High')
    expect(modelOption.querySelectorAll('span')).toHaveLength(1)
    expect(
      screen
        .getByTestId('model-control-reasoning-high')
        .compareDocumentPosition(screen.getByTestId('model-family-gpt')) &
        Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy()

    await userEvent.click(screen.getByTestId('model-option-overseas-gpt-5.5'))

    expect(setSelectedModel).toHaveBeenCalledWith(model)
  })

  test('opens desktop speed options from a collapsed model control submenu', async () => {
    const model: UnifiedModel = {
      name: 'overseas-gpt-5.5',
      type: 'user',
      displayName: '海外:gpt-5.5',
      config: {
        ui: {
          family: 'gpt',
          region: 'overseas',
          modelLabel: 'gpt-5.5',
          sortOrder: 10,
          controls: ['speed'],
        },
      },
    }
    const setSelectedModelOption = vi.fn()
    render(
      <ChatInput
        value=""
        onChange={vi.fn()}
        onSubmit={vi.fn()}
        disabled={false}
        variant="desktop"
        projectChat={projectChatControls({
          models: [model],
          selectedModel: model,
          selectedModelOptions: { reasoning: 'high', speed: 'standard' },
          setSelectedModelOption,
        })}
      />
    )

    await userEvent.click(screen.getByTestId('model-selector-button'))

    expect(screen.queryByTestId('model-control-speed-fast')).not.toBeInTheDocument()

    await userEvent.hover(screen.getByTestId('model-control-menu-speed'))

    expect(screen.getByTestId('model-control-speed-standard')).toBeInTheDocument()
    expect(screen.getByTestId('model-control-speed-fast')).toBeInTheDocument()
    expect(screen.getByTestId('model-selector-submenu')).toHaveStyle({ left: '256px' })

    await userEvent.click(screen.getByTestId('model-control-speed-fast'))

    expect(setSelectedModelOption).toHaveBeenCalledWith('speed', 'fast')
  })

  test('hides the desktop model submenu after the pointer leaves the menu', async () => {
    const model: UnifiedModel = {
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
    render(
      <ChatInput
        value=""
        onChange={vi.fn()}
        onSubmit={vi.fn()}
        disabled={false}
        variant="desktop"
        projectChat={projectChatControls({
          models: [model],
          selectedModel: model,
          selectedModelOptions: { reasoning: 'high' },
        })}
      />
    )

    await userEvent.click(screen.getByTestId('model-selector-button'))

    expect(screen.getByTestId('model-selector-submenu')).toBeInTheDocument()

    fireEvent.mouseLeave(screen.getByTestId('model-selector-menu').parentElement as HTMLElement)

    expect(screen.queryByTestId('model-selector-submenu')).not.toBeInTheDocument()
  })

  test('keeps the desktop model menu in narrow Tauri windows', async () => {
    Object.defineProperty(window, 'innerWidth', {
      configurable: true,
      value: 500,
    })
    Object.defineProperty(window, '__TAURI_INTERNALS__', {
      configurable: true,
      value: {},
    })
    const model: UnifiedModel = {
      name: 'codex-gpt-5.5',
      type: 'user',
      displayName: '5.5',
      config: {
        ui: {
          family: 'gpt',
          modelLabel: '5.5',
          sortOrder: 10,
        },
      },
    }

    render(
      <ChatInput
        value=""
        onChange={vi.fn()}
        onSubmit={vi.fn()}
        disabled={false}
        variant="desktop"
        projectChat={projectChatControls({
          models: [model],
          selectedModel: model,
        })}
      />
    )

    await userEvent.click(screen.getByTestId('model-selector-button'))

    expect(screen.getByTestId('model-selector-menu')).toBeInTheDocument()
    expect(screen.getByTestId('model-selector-menu')).not.toHaveAttribute('data-mobile')
    expect(screen.getByTestId('model-selector-menu')).not.toHaveAttribute('aria-modal')
    expect(screen.getByTestId('model-selector-submenu')).toBeInTheDocument()
  })

  test('opens the desktop model menu when the external open signal changes', async () => {
    const model: UnifiedModel = {
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
    const { rerender } = render(
      <ChatInput
        value=""
        onChange={vi.fn()}
        onSubmit={vi.fn()}
        disabled={false}
        variant="desktop"
        projectChat={projectChatControls({
          models: [model],
          selectedModel: model,
          modelSelectorOpenSignal: 0,
        })}
      />
    )

    expect(screen.queryByTestId('model-selector-menu')).not.toBeInTheDocument()

    rerender(
      <ChatInput
        value=""
        onChange={vi.fn()}
        onSubmit={vi.fn()}
        disabled={false}
        variant="desktop"
        projectChat={projectChatControls({
          models: [model],
          selectedModel: model,
          modelSelectorOpenSignal: 1,
        })}
      />
    )

    expect(screen.getByTestId('model-selector-menu')).toBeInTheDocument()
  })

  test('closes the desktop model menu after selecting a model opened by external signal', async () => {
    const model: UnifiedModel = {
      name: 'ali-qwen3-coder-plus',
      type: 'user',
      displayName: 'ali-qwen3-coder-plus',
      config: {
        ui: {
          family: 'qwen',
          region: 'domestic',
          modelLabel: 'ali-qwen3-coder-plus',
          sortOrder: 10,
        },
      },
    }
    const setSelectedModel = vi.fn()
    render(
      <ChatInput
        value=""
        onChange={vi.fn()}
        onSubmit={vi.fn()}
        disabled={false}
        variant="desktop"
        projectChat={projectChatControls({
          models: [model],
          selectedModel: null,
          modelSelectorOpenSignal: 1,
          setSelectedModel,
        })}
      />
    )

    expect(screen.getByTestId('model-selector-menu')).toBeInTheDocument()

    await userEvent.click(screen.getByTestId('model-option-ali-qwen3-coder-plus'))

    expect(setSelectedModel).toHaveBeenCalledWith(model)
    await waitFor(() => expect(screen.queryByTestId('model-selector-menu')).not.toBeInTheDocument())
  })

  test('moves the desktop model submenu upward when the active family is near the viewport bottom', async () => {
    const originalInnerHeight = window.innerHeight
    Object.defineProperty(window, 'innerHeight', {
      configurable: true,
      value: 1000,
    })
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(
      function getMockRect(this: HTMLElement) {
        const testId = this.getAttribute('data-testid')
        if (testId === 'model-selector-menu') {
          return { top: 100, left: 480, width: 256, height: 720 } as DOMRect
        }
        if (testId === 'model-family-minimax') {
          return { top: 900, left: 500, width: 220, height: 36 } as DOMRect
        }
        if (testId === 'model-selector-submenu') {
          return { top: 0, left: 0, width: 288, height: 192 } as DOMRect
        }
        return { top: 0, left: 0, width: 0, height: 0 } as DOMRect
      }
    )

    const minimaxModel: UnifiedModel = {
      name: 'public-minimax-m2.7',
      type: 'user',
      displayName: '公网:minimax-m2.7',
      config: {
        ui: {
          family: 'minimax',
          region: 'public',
          modelLabel: 'minimax-m2.7',
          sortOrder: 10,
        },
      },
    }

    try {
      render(
        <ChatInput
          value=""
          onChange={vi.fn()}
          onSubmit={vi.fn()}
          disabled={false}
          variant="desktop"
          projectChat={projectChatControls({
            models: [minimaxModel],
            selectedModel: minimaxModel,
            selectedModelOptions: {},
          })}
        />
      )

      await userEvent.click(screen.getByTestId('model-selector-button'))

      await waitFor(() => {
        expect(screen.getByTestId('model-selector-submenu')).toHaveStyle({
          top: '692px',
        })
      })
    } finally {
      Object.defineProperty(window, 'innerHeight', {
        configurable: true,
        value: originalInnerHeight,
      })
    }
  })

  test('shows incompatible model options as disabled', async () => {
    const selectedModel: UnifiedModel = {
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
    const incompatibleModel: UnifiedModel = {
      name: 'overseas-gpt-5.4',
      type: 'user',
      displayName: '海外:gpt-5.4',
      compatibilityDisabled: true,
      compatibilityDisabledReason: 'runtime_family_mismatch',
      config: {
        ui: {
          family: 'gpt',
          region: 'overseas',
          modelLabel: 'gpt-5.4',
          sortOrder: 20,
        },
      },
    }
    const setSelectedModel = vi.fn()
    const onBlockedModelSelect = vi.fn()
    render(
      <ChatInput
        value=""
        onChange={vi.fn()}
        onSubmit={vi.fn()}
        disabled={false}
        variant="desktop"
        projectChat={projectChatControls({
          models: [selectedModel, incompatibleModel],
          selectedModel,
          selectedModelOptions: {},
          setSelectedModel,
          onBlockedModelSelect,
        })}
      />
    )

    await userEvent.click(screen.getByTestId('model-selector-button'))

    const disabledOption = screen.getByTestId('model-option-overseas-gpt-5.4')
    expect(disabledOption).not.toBeDisabled()
    expect(disabledOption).toHaveAttribute('aria-disabled', 'true')
    expect(disabledOption).toHaveAttribute('title', 'Incompatible with the current model protocol')
    expect(disabledOption).toHaveTextContent('Incompatible with the current model protocol')

    await userEvent.click(disabledOption)

    expect(setSelectedModel).not.toHaveBeenCalled()
    expect(onBlockedModelSelect).toHaveBeenCalledWith(
      incompatibleModel,
      'Incompatible with the current model protocol'
    )
  })

  test('closes the model menu after selecting a reasoning option', async () => {
    const model: UnifiedModel = {
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
    const setSelectedModelOption = vi.fn()
    render(
      <ChatInput
        value=""
        onChange={vi.fn()}
        onSubmit={vi.fn()}
        disabled={false}
        variant="desktop"
        projectChat={projectChatControls({
          models: [model],
          selectedModel: model,
          selectedModelOptions: { reasoning: 'high' },
          setSelectedModelOption,
        })}
      />
    )

    await userEvent.click(screen.getByTestId('model-selector-button'))
    await userEvent.click(screen.getByTestId('model-control-reasoning-medium'))

    expect(setSelectedModelOption).toHaveBeenCalledWith('reasoning', 'medium')
    await waitFor(() => {
      expect(screen.queryByTestId('model-selector-menu')).not.toBeInTheDocument()
    })
  })

  test('omits Codex plan mode from the desktop model menu', async () => {
    const model: UnifiedModel = {
      name: 'codex-gpt-5.5',
      type: 'user',
      displayName: 'Codex:gpt-5.5',
      config: {
        ui: {
          family: 'gpt',
          region: 'overseas',
          modelLabel: 'gpt-5.5',
          sortOrder: 10,
        },
      },
    }
    render(
      <ChatInput
        value=""
        onChange={vi.fn()}
        onSubmit={vi.fn()}
        disabled={false}
        variant="desktop"
        projectChat={projectChatControls({
          models: [model],
          selectedModel: model,
          selectedModelOptions: { reasoning: 'high' },
        })}
      />
    )

    await userEvent.click(screen.getByTestId('model-selector-button'))

    const menu = within(screen.getByTestId('model-selector-menu'))
    expect(screen.queryByTestId('model-control-collaborationMode-default')).not.toBeInTheDocument()
    expect(screen.queryByTestId('model-control-collaborationMode-plan')).not.toBeInTheDocument()
    expect(menu.queryByText('运行模式')).not.toBeInTheDocument()
    expect(menu.queryByText('计划模式')).not.toBeInTheDocument()
  })

  test('keeps reasoning controls for the selected GPT model while hovering another family', async () => {
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
    const claudeModel: UnifiedModel = {
      name: 'claude-opus',
      type: 'user',
      displayName: 'Claude Opus',
      config: {
        ui: {
          family: 'claude',
          modelLabel: 'claude-opus',
          sortOrder: 10,
        },
      },
    }

    render(
      <ChatInput
        value=""
        onChange={vi.fn()}
        onSubmit={vi.fn()}
        disabled={false}
        variant="desktop"
        projectChat={projectChatControls({
          models: [claudeModel, gptModel],
          selectedModel: gptModel,
          selectedModelOptions: { reasoning: 'high' },
        })}
      />
    )

    await userEvent.click(screen.getByTestId('model-selector-button'))
    await userEvent.hover(screen.getByTestId('model-family-claude'))

    expect(screen.getByTestId('model-control-reasoning-high')).toBeInTheDocument()
    expect(screen.queryByTestId('model-control-reasoning-auto')).not.toBeInTheDocument()
    expect(screen.getByTestId('model-option-claude-opus')).toBeInTheDocument()
  })

  test('hides speed controls when the selected model version does not support speed', async () => {
    const selectedModel: UnifiedModel = {
      name: 'overseas-gpt-5.2',
      type: 'user',
      displayName: '海外:gpt-5.2',
      config: {
        ui: {
          family: 'gpt',
          region: 'overseas',
          modelLabel: 'gpt-5.2',
          sortOrder: 10,
        },
      },
    }
    const speedModel: UnifiedModel = {
      name: 'overseas-gpt-5.5',
      type: 'user',
      displayName: '海外:gpt-5.5',
      config: {
        ui: {
          family: 'gpt',
          region: 'overseas',
          modelLabel: 'gpt-5.5',
          sortOrder: 20,
          controls: ['speed'],
        },
      },
    }

    render(
      <ChatInput
        value=""
        onChange={vi.fn()}
        onSubmit={vi.fn()}
        disabled={false}
        variant="desktop"
        projectChat={projectChatControls({
          models: [selectedModel, speedModel],
          selectedModel,
          selectedModelOptions: { reasoning: 'high' },
        })}
      />
    )

    await userEvent.click(screen.getByTestId('model-selector-button'))

    expect(screen.getByTestId('model-control-reasoning-high')).toBeInTheDocument()
    expect(screen.queryByTestId('model-control-speed-fast')).not.toBeInTheDocument()
  })

  test('does not render the desktop skill selector', () => {
    render(
      <ChatInput
        value=""
        onChange={vi.fn()}
        onSubmit={vi.fn()}
        disabled={false}
        variant="desktop"
        projectChat={projectChatControls({
          skills: [
            {
              id: 1,
              name: 'project-summary',
              namespace: 'default',
              description: 'Summarize project context',
              is_active: true,
              is_public: false,
              user_id: 1,
            },
          ],
        })}
      />
    )

    expect(screen.queryByTestId('skill-selector-button')).not.toBeInTheDocument()
    expect(screen.queryByTestId('skill-selector-menu')).not.toBeInTheDocument()
  })

  test('opens the desktop add context menu with file upload, plan, and goal actions', async () => {
    const setSelectedModelOption = vi.fn()
    const onSetGoal = vi.fn()
    render(
      <ChatInput
        value=""
        onChange={vi.fn()}
        onSubmit={vi.fn()}
        disabled={false}
        variant="desktop"
        projectChat={projectChatControls({ setSelectedModelOption })}
        onSetGoal={onSetGoal}
      />
    )

    await userEvent.click(screen.getByTestId('add-context-button'))

    const menu = within(screen.getByTestId('add-context-menu'))
    expect(menu.getByText('添加照片和文件')).toBeInTheDocument()
    expect(menu.getByText('计划模式')).toBeInTheDocument()
    expect(menu.getByText('开启计划模式')).toBeInTheDocument()
    expect(menu.getByText('目标')).toBeInTheDocument()
    expect(menu.getByText('设置 WeWork 将持续努力实现的目标')).toBeInTheDocument()
    expect(menu.queryByText('Attach Google Chrome')).not.toBeInTheDocument()
    expect(menu.queryByText('插件')).not.toBeInTheDocument()

    await userEvent.click(screen.getByTestId('set-plan-mode-button'))

    expect(setSelectedModelOption).toHaveBeenCalledWith('collaborationMode', 'plan')

    await userEvent.click(screen.getByTestId('add-context-button'))
    await userEvent.click(screen.getByTestId('set-goal-button'))

    expect(onSetGoal).toHaveBeenCalledTimes(1)
  })

  test('renders desktop goal status bar actions', async () => {
    const goal: RuntimeGoal = {
      threadId: 'thread-1',
      objective: '实现 plan 里的功能',
      status: 'active',
      tokenBudget: null,
      tokensUsed: 0,
      timeUsedSeconds: 178,
      createdAt: 1780000000000,
      updatedAt: 1780000000000,
    }
    const onEditGoal = vi.fn()
    const onPauseGoal = vi.fn()
    const onClearGoal = vi.fn()

    render(
      <ChatInput
        value=""
        onChange={vi.fn()}
        onSubmit={vi.fn()}
        disabled={false}
        variant="desktop"
        goal={goal}
        onEditGoal={onEditGoal}
        onPauseGoal={onPauseGoal}
        onClearGoal={onClearGoal}
      />
    )

    const bar = screen.getByTestId('goal-status-bar')
    expect(bar).toHaveTextContent('进行中的目标')
    expect(bar).toHaveTextContent('实现 plan 里的功能')
    expect(bar).toHaveTextContent('2m 58s')

    await userEvent.click(screen.getByTestId('edit-goal-button'))
    await userEvent.click(screen.getByTestId('pause-goal-button'))
    await userEvent.click(screen.getByTestId('clear-goal-button'))

    expect(onEditGoal).toHaveBeenCalledTimes(1)
    expect(onPauseGoal).toHaveBeenCalledTimes(1)
    expect(onClearGoal).toHaveBeenCalledTimes(1)
  })

  test('renders a newly created active goal with a zero-second timer', () => {
    const goal: RuntimeGoal = {
      threadId: 'pending',
      objective: '立刻显示目标条',
      status: 'active',
      tokenBudget: null,
      tokensUsed: 0,
      timeUsedSeconds: 0,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }

    render(
      <ChatInput
        value=""
        onChange={vi.fn()}
        onSubmit={vi.fn()}
        disabled={false}
        variant="desktop"
        goal={goal}
      />
    )

    expect(screen.getByTestId('goal-status-bar')).toHaveTextContent('立刻显示目标条')
    expect(screen.getByTestId('goal-status-bar')).toHaveTextContent('0s')
  })

  test('does not render the goal status bar after the goal is complete', () => {
    const goal: RuntimeGoal = {
      threadId: 'thread-1',
      objective: '已经达成的目标',
      status: 'complete',
      tokenBudget: null,
      tokensUsed: 0,
      timeUsedSeconds: 300,
      createdAt: 1780000000000,
      updatedAt: 1780000000000,
    }

    render(
      <ChatInput
        value=""
        onChange={vi.fn()}
        onSubmit={vi.fn()}
        disabled={false}
        variant="desktop"
        goal={goal}
      />
    )

    expect(screen.queryByTestId('goal-status-bar')).not.toBeInTheDocument()
  })

  test('renders goal draft pill with a hover-only cancel affordance', () => {
    const onCancelGoalDraft = vi.fn()

    render(
      <ChatInput
        value=""
        onChange={vi.fn()}
        onSubmit={vi.fn()}
        disabled={false}
        variant="desktop"
        goalDraftActive
        onCancelGoalDraft={onCancelGoalDraft}
      />
    )

    const cancelButton = screen.getByTestId('cancel-goal-draft-button')
    const pill = screen.getByTestId('goal-draft-pill')
    expect(screen.getByPlaceholderText('WeWork 应该往哪个方向努力?')).toBeInTheDocument()
    expect(pill).toHaveTextContent('目标')
    expect(pill).toHaveClass('h-7')
    expect(pill).toHaveClass('rounded-xl')
    expect(pill).toHaveClass('justify-center')
    expect(pill).toHaveClass('border')
    expect(pill).toHaveClass('bg-muted')
    expect(cancelButton).toHaveClass('opacity-0')
    expect(cancelButton).toHaveClass('w-0')
    expect(cancelButton).toHaveClass('group-hover:w-5')
    expect(cancelButton).toHaveClass('group-hover:mr-1.5')
    expect(cancelButton).toHaveClass('group-hover:opacity-100')
    expect(cancelButton).toHaveClass('group-hover:bg-text-muted/15')
    expect(cancelButton).toHaveClass('hover:bg-text-muted/30')

    fireEvent.click(cancelButton)

    expect(onCancelGoalDraft).toHaveBeenCalledTimes(1)
  })

  test('renders compact goal status bar actions', async () => {
    const goal: RuntimeGoal = {
      threadId: 'thread-1',
      objective: '实现新对话 goal',
      status: 'active',
      tokenBudget: null,
      tokensUsed: 0,
      timeUsedSeconds: 0,
      createdAt: 1780000000000,
      updatedAt: 1780000000000,
    }
    const onEditGoal = vi.fn()

    render(
      <ChatInput
        value=""
        onChange={vi.fn()}
        onSubmit={vi.fn()}
        disabled={false}
        goal={goal}
        onEditGoal={onEditGoal}
      />
    )

    expect(screen.getByTestId('goal-status-bar')).toHaveTextContent('实现新对话 goal')
    await userEvent.click(screen.getByTestId('edit-goal-button'))
    expect(onEditGoal).toHaveBeenCalledTimes(1)
  })

  test('renders attachment badges and removes an attachment', async () => {
    const removeAttachment = vi.fn().mockResolvedValue(undefined)
    const attachment: Attachment = {
      id: 42,
      filename: 'brief.pdf',
      file_size: 1200,
      mime_type: 'application/pdf',
      status: 'ready',
      file_extension: '.pdf',
      created_at: '2026-05-27T00:00:00.000Z',
    }

    render(
      <ChatInput
        value=""
        onChange={vi.fn()}
        onSubmit={vi.fn()}
        disabled={false}
        variant="desktop"
        projectChat={projectChatControls({
          attachments: [attachment],
          removeAttachment,
        })}
      />
    )

    expect(screen.getByTestId('attachment-badge')).toHaveTextContent('brief.pdf')

    await userEvent.click(screen.getByTestId('remove-attachment-button'))

    expect(removeAttachment).toHaveBeenCalledWith(42)
  })

  test('renders document attachments as fixed two-line cards', () => {
    const attachment: Attachment = {
      id: 42,
      filename: 'brief.pdf',
      file_size: 1200,
      mime_type: 'application/pdf',
      status: 'ready',
      file_extension: '.pdf',
      created_at: '2026-05-27T00:00:00.000Z',
    }

    render(
      <ChatInput
        value=""
        onChange={vi.fn()}
        onSubmit={vi.fn()}
        disabled={false}
        variant="desktop"
        projectChat={projectChatControls({ attachments: [attachment] })}
      />
    )

    expect(screen.getByTestId('attachment-badge')).toHaveClass('h-14', 'w-[220px]', 'rounded-xl')
    expect(screen.getByTestId('attachment-document-icon')).toHaveTextContent('PDF')
    expect(screen.getByText('brief.pdf')).toHaveClass('truncate')
    expect(screen.getAllByText('PDF')).toHaveLength(2)
  })

  test('renders pasted text attachments as codex-style preview cards', async () => {
    const removeAttachment = vi.fn().mockResolvedValue(undefined)
    const attachment: Attachment = {
      id: 45,
      filename: 'clipboard-text-1783070360990.txt',
      file_size: 1200,
      mime_type: 'text/plain',
      status: 'ready',
      file_extension: '.txt',
      created_at: '2026-05-27T00:00:00.000Z',
      text_preview: '{ "event_type": "http_exchange", "id": "e9972aac" }',
      text_content: '{\n  "event_type": "http_exchange",\n  "id": "e9972aac"\n}',
    }

    render(
      <ControlledChatInput
        variant="desktop"
        projectChat={projectChatControls({
          attachments: [attachment],
          removeAttachment,
        })}
      />
    )

    expect(screen.getByTestId('attachment-badge')).toHaveClass(
      'h-[72px]',
      'rounded-[20px]',
      'bg-muted'
    )
    expect(screen.getByTestId('attachment-text-preview')).toHaveTextContent(
      '{ "event_type": "http_exchange", "id": "e9972aac" }'
    )
    expect(screen.getByTestId('show-text-attachment-button')).toHaveTextContent(
      'workbench.show_text_attachment_in_composer'
    )

    await userEvent.click(screen.getByTestId('show-text-attachment-button'))

    expect(screen.getByTestId('chat-message-input')).toHaveValue(
      '{\n  "event_type": "http_exchange",\n  "id": "e9972aac"\n}'
    )
    expect(removeAttachment).toHaveBeenCalledWith(45)
  })

  test('renders an image preview for image attachments', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        blob: () => Promise.resolve(new Blob(['image'], { type: 'image/png' })),
      })
    )
    URL.createObjectURL = vi.fn(() => 'blob:attachment-preview')
    const attachment: Attachment = {
      id: 43,
      filename: 'screenshot.png',
      file_size: 1200,
      mime_type: 'image/png',
      status: 'ready',
      file_extension: '.png',
      created_at: '2026-05-27T00:00:00.000Z',
    }

    render(
      <ChatInput
        value=""
        onChange={vi.fn()}
        onSubmit={vi.fn()}
        disabled={false}
        variant="desktop"
        projectChat={projectChatControls({ attachments: [attachment] })}
      />
    )

    await waitFor(() => {
      expect(screen.getByTestId('attachment-image-preview')).toHaveAttribute(
        'src',
        'blob:attachment-preview'
      )
    })
  })

  test('opens an enlarged image from the composer attachment preview', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        blob: () => Promise.resolve(new Blob(['image'], { type: 'image/png' })),
      })
    )
    URL.createObjectURL = vi.fn(() => 'blob:attachment-preview')
    const attachment: Attachment = {
      id: 43,
      filename: 'screenshot.png',
      file_size: 1200,
      mime_type: 'image/png',
      status: 'ready',
      file_extension: '.png',
      created_at: '2026-05-27T00:00:00.000Z',
    }

    render(
      <ChatInput
        value=""
        onChange={vi.fn()}
        onSubmit={vi.fn()}
        disabled={false}
        variant="desktop"
        projectChat={projectChatControls({ attachments: [attachment] })}
      />
    )

    await userEvent.click(await screen.findByTestId('attachment-image-preview'))

    const lightbox = screen.getByTestId('attachment-image-lightbox')

    expect(lightbox).toBeInTheDocument()
    expect(lightbox.parentElement).toBe(document.body)
    expect(screen.getByTestId('attachment-image-lightbox-image')).toHaveAttribute(
      'src',
      'blob:attachment-preview'
    )
    expect(screen.getByTestId('attachment-image-lightbox-image')).toHaveAttribute(
      'alt',
      'screenshot.png'
    )
  })

  test('loads image previews with the auth token from local storage', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      blob: () => Promise.resolve(new Blob(['image'], { type: 'image/png' })),
    })
    vi.stubGlobal('fetch', fetchMock)
    URL.createObjectURL = vi.fn(() => 'blob:attachment-preview')
    localStorage.setItem('auth_token', 'token-123')

    const attachment: Attachment = {
      id: 43,
      filename: 'screenshot.png',
      file_size: 1200,
      mime_type: 'image/png',
      status: 'ready',
      file_extension: '.png',
      created_at: '2026-05-27T00:00:00.000Z',
    }

    render(
      <ChatInput
        value=""
        onChange={vi.fn()}
        onSubmit={vi.fn()}
        disabled={false}
        variant="desktop"
        projectChat={projectChatControls({ attachments: [attachment] })}
      />
    )

    await waitFor(() => {
      expect(screen.getByTestId('attachment-image-preview')).toHaveAttribute(
        'src',
        'blob:attachment-preview'
      )
    })

    expect(fetchMock).toHaveBeenCalledWith('/api/attachments/43/download', {
      headers: { Authorization: 'Bearer token-123' },
    })
  })

  test('uses matching overlay remove buttons for image and document attachments', () => {
    const attachments: Attachment[] = [
      {
        id: 43,
        filename: 'screenshot.png',
        file_size: 1200,
        mime_type: 'image/png',
        status: 'ready',
        file_extension: '.png',
        created_at: '2026-05-27T00:00:00.000Z',
      },
      {
        id: 44,
        filename: 'brief.pdf',
        file_size: 1200,
        mime_type: 'application/pdf',
        status: 'ready',
        file_extension: '.pdf',
        created_at: '2026-05-27T00:00:00.000Z',
      },
    ]

    render(
      <ChatInput
        value=""
        onChange={vi.fn()}
        onSubmit={vi.fn()}
        disabled={false}
        variant="desktop"
        projectChat={projectChatControls({ attachments })}
      />
    )

    const removeButtons = screen.getAllByTestId('remove-attachment-button')

    expect(removeButtons).toHaveLength(2)
    removeButtons.forEach(button => {
      expect(button).toHaveClass('absolute', '-right-1.5', '-top-1.5')
      expect(button).toHaveClass('rounded-full', 'bg-text-primary', 'text-white')
    })
  })

  test('enables send when only attachments are present', async () => {
    const onSubmit = vi.fn()
    const attachment: Attachment = {
      id: 44,
      filename: 'brief.pdf',
      file_size: 1200,
      mime_type: 'application/pdf',
      status: 'ready',
      file_extension: '.pdf',
      created_at: '2026-05-27T00:00:00.000Z',
    }

    render(
      <ChatInput
        value=""
        onChange={vi.fn()}
        onSubmit={onSubmit}
        disabled={false}
        variant="desktop"
        projectChat={projectChatControls({ attachments: [attachment] })}
      />
    )

    expect(screen.getByTestId('send-message-button')).toBeEnabled()
    await userEvent.click(screen.getByTestId('send-message-button'))
    expect(onSubmit).toHaveBeenCalledTimes(1)
  })

  test('opens project work menu and selects a project', async () => {
    const onSelectProjectWorkspace = vi.fn()

    render(
      <ChatInput
        value=""
        onChange={vi.fn()}
        onSubmit={vi.fn()}
        disabled={false}
        variant="desktop"
        projectWork={projectWorkControls({
          runtimeWork: runtimeWork([
            { id: 7, name: 'Wegent', workspaceId: 70 },
            { id: 8, name: 'Docs', workspaceId: 80 },
          ]),
          currentProjectId: 7,
          selectedDeviceWorkspaceId: 70,
          onSelectProjectWorkspace,
        })}
      />
    )

    await userEvent.click(screen.getByTestId('project-work-button'))

    expect(screen.getByTestId('project-work-menu')).toBeInTheDocument()
    expect(screen.getAllByText('Wegent').length).toBeGreaterThan(0)
    expect(screen.getByText('Docs')).toBeInTheDocument()
    expect(screen.getByTestId('no-project-option')).toHaveTextContent('不使用项目')

    await userEvent.click(screen.getByTestId('project-option-8'))

    expect(onSelectProjectWorkspace).toHaveBeenCalledWith(8, 80)
  })

  test('shows no-project transition from the standalone entry', async () => {
    const onSelectStandaloneDevice = vi.fn()

    render(
      <ChatInput
        value=""
        onChange={vi.fn()}
        onSubmit={vi.fn()}
        disabled={false}
        variant="desktop"
        projectWork={projectWorkControls({
          projects: [
            {
              id: 7,
              name: 'Wegent',
              tasks: [],
              config: {
                mode: 'workspace',
                execution: {
                  targetType: 'local',
                  deviceId: 'device-1',
                },
                workspace: {
                  source: 'local_path',
                  localPath: '/workspace/wegent',
                },
              },
            },
          ],
          currentProjectId: 7,
          onSelectStandaloneDevice,
        })}
      />
    )

    await userEvent.click(screen.getByTestId('project-work-button'))
    await userEvent.click(screen.getByTestId('no-project-option'))

    expect(onSelectStandaloneDevice).toHaveBeenCalledWith(null)
  })

  test('shows no-project option before selecting a concrete project', async () => {
    const onSelectStandaloneDevice = vi.fn()

    render(
      <ChatInput
        value=""
        onChange={vi.fn()}
        onSubmit={vi.fn()}
        disabled={false}
        variant="desktop"
        projectWork={projectWorkControls({
          projects: [{ id: 7, name: 'Wegent', tasks: [] }],
          currentProjectId: undefined,
          onSelectStandaloneDevice,
        })}
      />
    )

    await userEvent.click(screen.getByTestId('project-work-button'))

    expect(screen.getByTestId('no-project-option')).toHaveTextContent('不使用项目')

    await userEvent.click(screen.getByTestId('no-project-option'))

    expect(onSelectStandaloneDevice).toHaveBeenCalledWith(null)
  })

  test('hides standalone devices and selects the local device for no-project mode', async () => {
    const onSelectStandaloneDevice = vi.fn()
    const devices: DeviceInfo[] = [
      {
        id: 1,
        device_id: 'local-online',
        name: 'Local Online',
        status: 'online',
        is_default: false,
        device_type: 'local',
        executor_version: '1.8.5',
      },
      {
        id: 2,
        device_id: 'cloud-online',
        name: 'Cloud Online',
        status: 'online',
        is_default: false,
        device_type: 'cloud',
        executor_version: '1.8.5',
      },
      {
        id: 3,
        device_id: 'local-offline',
        name: 'Local Offline',
        status: 'offline',
        is_default: false,
        device_type: 'local',
        executor_version: '1.8.5',
      },
    ]

    render(
      <ChatInput
        value=""
        onChange={vi.fn()}
        onSubmit={vi.fn()}
        disabled={false}
        variant="desktop"
        projectWork={projectWorkControls({
          projects: [{ id: 7, name: 'Wegent', tasks: [] }],
          devices,
          currentProjectId: 7,
          onSelectStandaloneDevice,
        })}
      />
    )

    await userEvent.click(screen.getByTestId('project-work-button'))

    expect(screen.queryByTestId('standalone-device-list')).not.toBeInTheDocument()
    expect(screen.queryByTestId('standalone-device-option-cloud-online')).not.toBeInTheDocument()
    expect(screen.queryByTestId('standalone-device-option-local-online')).not.toBeInTheDocument()

    await userEvent.click(screen.getByTestId('no-project-option'))
    expect(onSelectStandaloneDevice).toHaveBeenCalledWith('local-online')
  })

  test('marks the current project instead of a remembered standalone device', async () => {
    const devices: DeviceInfo[] = [
      {
        id: 1,
        device_id: 'cloud-online',
        name: 'Cloud Online',
        status: 'online',
        is_default: false,
        device_type: 'cloud',
      },
    ]

    render(
      <ChatInput
        value=""
        onChange={vi.fn()}
        onSubmit={vi.fn()}
        disabled={false}
        variant="desktop"
        projectWork={projectWorkControls({
          runtimeWork: runtimeWork([{ id: 7, name: 'hello', workspaceId: 70 }]),
          devices,
          currentProjectId: 7,
          selectedDeviceWorkspaceId: 70,
          currentStandaloneDeviceId: 'cloud-online',
        })}
      />
    )

    await userEvent.click(screen.getByTestId('project-work-button'))

    expect(screen.getByTestId('project-selected-icon-7')).toBeInTheDocument()
    expect(
      screen.queryByTestId('standalone-device-selected-icon-cloud-online')
    ).not.toBeInTheDocument()
  })

  test('keeps standalone device details out of the trigger when no project is selected', async () => {
    const devices: DeviceInfo[] = [
      {
        id: 1,
        device_id: 'local-online',
        name: 'Local Online',
        status: 'online',
        is_default: false,
        device_type: 'local',
      },
      {
        id: 2,
        device_id: 'cloud-online',
        name: 'Cloud Online',
        status: 'online',
        is_default: false,
        device_type: 'cloud',
      },
    ]

    render(
      <ChatInput
        value=""
        onChange={vi.fn()}
        onSubmit={vi.fn()}
        disabled={false}
        variant="desktop"
        projectWork={projectWorkControls({
          projects: [{ id: 7, name: 'hello', tasks: [] }],
          devices,
          currentProjectId: undefined,
          currentStandaloneDeviceId: 'local-online',
        })}
      />
    )

    expect(screen.getByTestId('project-work-button')).toHaveTextContent('进入项目工作')
    expect(screen.getByTestId('project-work-button')).not.toHaveTextContent('Local Online')

    await userEvent.click(screen.getByTestId('project-work-button'))

    expect(screen.queryByTestId('standalone-device-list')).not.toBeInTheDocument()
    expect(
      screen.queryByTestId('standalone-device-selected-icon-local-online')
    ).not.toBeInTheDocument()
    expect(
      screen.queryByTestId('standalone-device-selected-icon-cloud-online')
    ).not.toBeInTheDocument()
  })

  test('uses the project work action as the standalone trigger accessible name', () => {
    const devices: DeviceInfo[] = [
      {
        id: 1,
        device_id: 'local-online',
        name: 'Local Online',
        status: 'online',
        is_default: false,
        device_type: 'local',
      },
    ]

    render(
      <ChatInput
        value=""
        onChange={vi.fn()}
        onSubmit={vi.fn()}
        disabled={false}
        variant="desktop"
        projectWork={projectWorkControls({
          projects: [{ id: 7, name: 'hello', tasks: [] }],
          devices,
          currentProjectId: undefined,
          currentStandaloneDeviceId: 'local-online',
        })}
      />
    )

    const trigger = screen.getByTestId('project-work-button')

    expect(trigger).toHaveTextContent('进入项目工作')
    expect(trigger).not.toHaveTextContent('Local Online')
    expect(trigger).toHaveAccessibleName('进入项目工作')
  })

  test('does not include enter-project work as a menu item', async () => {
    render(
      <ChatInput
        value=""
        onChange={vi.fn()}
        onSubmit={vi.fn()}
        disabled={false}
        variant="desktop"
        projectWork={projectWorkControls({
          projects: [{ id: 7, name: 'Wegent', tasks: [] }],
          currentProjectId: undefined,
        })}
      />
    )

    expect(screen.getByTestId('project-work-button')).toHaveTextContent('进入项目工作')

    await userEvent.click(screen.getByTestId('project-work-button'))

    expect(screen.getByTestId('no-project-option')).toHaveTextContent('不使用项目')
    expect(screen.getByTestId('project-work-menu')).not.toHaveTextContent('进入项目工作')
  })

  test('renders remote project IPs and hides local device names in the project menu', async () => {
    render(
      <ChatInput
        value=""
        onChange={vi.fn()}
        onSubmit={vi.fn()}
        disabled={false}
        variant="desktop"
        projectWork={projectWorkControls({
          runtimeWork: runtimeWork([
            {
              id: 7,
              name: 'Wegent',
              workspaceId: 70,
              deviceId: 'device-online',
              deviceName: '10.201.3.200',
            },
            {
              id: 8,
              name: 'Docs',
              workspaceId: 80,
              deviceId: 'device-local',
              deviceName: 'Local Device',
            },
          ]),
          devices: [
            {
              id: 1,
              device_id: 'device-online',
              name: 'online-executor',
              status: 'online',
              is_default: false,
              device_type: 'cloud',
              client_ip: '10.201.3.200',
            },
            {
              id: 2,
              device_id: 'device-local',
              name: 'Local Device',
              status: 'online',
              is_default: false,
              device_type: 'local',
            },
          ],
        })}
      />
    )

    await userEvent.click(screen.getByTestId('project-work-button'))

    const projectDeviceLabel = screen.getAllByText('10.201.3.200')[0]
    expect(projectDeviceLabel).toHaveClass('text-text-secondary')
    expect(projectDeviceLabel).not.toHaveClass('text-primary')
    expect(
      within(screen.getByTestId('project-option-8')).queryByText('Local Device')
    ).not.toBeInTheDocument()
  })

  test('ignores the projects table when runtime work is empty', async () => {
    const onSelectProject = vi.fn()

    render(
      <ChatInput
        value=""
        onChange={vi.fn()}
        onSubmit={vi.fn()}
        disabled={false}
        variant="desktop"
        projectWork={projectWorkControls({
          projects: [
            { id: 7, name: 'Online Project', tasks: [] },
            { id: 8, name: 'Offline Project', tasks: [] },
          ],
          runtimeWork: runtimeWork([]),
          onSelectProject,
          devices: [
            {
              id: 1,
              device_id: 'device-online',
              name: 'online-executor',
              status: 'online',
              is_default: false,
            },
            {
              id: 2,
              device_id: 'device-offline',
              name: 'offline-executor',
              status: 'offline',
              is_default: false,
            },
          ],
        })}
      />
    )

    await userEvent.click(screen.getByTestId('project-work-button'))

    expect(screen.getByText('暂无项目')).toBeInTheDocument()
    expect(screen.queryByTestId('project-option-7')).not.toBeInTheDocument()
    expect(screen.queryByText('Online Project')).not.toBeInTheDocument()
    expect(onSelectProject).not.toHaveBeenCalled()
  })

  test('keeps model selector enabled and omits skill selector when options are locked', () => {
    render(
      <ChatInput
        value=""
        onChange={vi.fn()}
        onSubmit={vi.fn()}
        disabled={false}
        variant="desktop"
        projectChat={projectChatControls({
          selectedSkills: [
            {
              name: 'project-summary',
              namespace: 'default',
              is_public: false,
            },
          ],
          isOptionsLocked: true,
        })}
      />
    )

    expect(screen.getByTestId('model-selector-button')).not.toBeDisabled()
    expect(screen.queryByTestId('skill-selector-button')).not.toBeInTheDocument()
  })

  test.each([
    ['model selector', 'model-selector-button', 'model-selector-menu'],
    ['add context menu', 'add-context-button', 'add-context-menu'],
    ['project work menu', 'project-work-button', 'project-work-menu'],
  ])(
    'closes the desktop %s when clicking outside the dropdown',
    async (_, buttonTestId, menuTestId) => {
      render(
        <ChatInput
          value=""
          onChange={vi.fn()}
          onSubmit={vi.fn()}
          disabled={false}
          variant="desktop"
          projectWork={projectWorkControls({
            projects: [{ id: 7, name: 'Wegent', tasks: [] }],
          })}
        />
      )

      await userEvent.click(screen.getByTestId(buttonTestId))
      expect(screen.getByTestId(menuTestId)).toBeInTheDocument()

      await userEvent.click(screen.getByTestId('chat-message-input'))

      expect(screen.queryByTestId(menuTestId)).not.toBeInTheDocument()
    }
  )

  test('limits the desktop worktree branch menu while branches scroll', async () => {
    const branches = Array.from({ length: 50 }, (_, index) => `feature/branch-${index}`)
    const worktreeProject = {
      id: 7,
      name: 'Wegent',
      tasks: [],
      config: {
        mode: 'workspace' as const,
        execution: {
          targetType: 'local' as const,
          deviceId: 'device-1',
        },
        workspace: {
          source: 'local_path' as const,
          localPath: '/workspace/wegent',
        },
      },
    }
    vi.stubGlobal('innerHeight', 380)

    render(
      <ChatInput
        value=""
        onChange={vi.fn()}
        onSubmit={vi.fn()}
        disabled={false}
        variant="desktop"
        projectWork={projectWorkControls({
          projects: [worktreeProject],
          currentProject: worktreeProject,
          currentProjectId: 7,
          executionMode: 'git_worktree',
          executionModeLocked: false,
          onExecutionModeChange: vi.fn(),
          branchName: 'main',
          branchLoading: false,
          onListBranches: vi.fn().mockResolvedValue(branches),
          worktreeBranch: null,
          onWorktreeBranchChange: vi.fn(),
        })}
      />
    )

    const branchButton = screen.getByTestId('project-worktree-branch-button')
    vi.spyOn(branchButton, 'getBoundingClientRect').mockReturnValue({
      x: 0,
      y: 300,
      left: 0,
      top: 300,
      right: 120,
      bottom: 336,
      width: 120,
      height: 36,
      toJSON: () => ({}),
    })

    await userEvent.click(branchButton)

    const menu = await screen.findByTestId('project-worktree-branch-menu')
    await waitFor(() => expect(menu).toHaveStyle({ maxHeight: '276px' }))
    expect(menu).toHaveClass('bottom-11', 'overflow-hidden')
    expect(screen.getByTestId('project-worktree-branch-list')).toHaveClass(
      'min-h-0',
      'flex-1',
      'overflow-y-auto'
    )
    expect(await screen.findAllByTestId('project-worktree-branch-option')).toHaveLength(50)
  })

  test('submits typed content', async () => {
    const onChange = vi.fn()
    const onSubmit = vi.fn()
    render(<ChatInput value="hello" onChange={onChange} onSubmit={onSubmit} disabled={false} />)

    await userEvent.click(screen.getByTestId('send-message-button'))

    expect(onSubmit).toHaveBeenCalled()
  })

  test('submits with Enter when content is present', async () => {
    const onSubmit = vi.fn()
    render(<ControlledChatInput onSubmit={onSubmit} />)

    await userEvent.type(screen.getByTestId('chat-message-input'), 'hello{enter}')

    expect(onSubmit).toHaveBeenCalledTimes(1)
  })

  test('does not submit when Enter confirms IME composition', () => {
    vi.useFakeTimers()
    const onSubmit = vi.fn()
    render(<ControlledChatInput onSubmit={onSubmit} />)

    const input = screen.getByTestId('chat-message-input')
    fireEvent.change(input, { target: { value: 'hello' } })
    fireEvent.compositionStart(input)
    fireEvent.keyDown(input, { key: 'Enter' })
    fireEvent.compositionEnd(input)
    fireEvent.keyDown(input, { key: 'Enter' })

    expect(onSubmit).not.toHaveBeenCalled()

    act(() => {
      vi.advanceTimersByTime(101)
    })
    fireEvent.keyDown(input, { key: 'Enter' })

    expect(onSubmit).toHaveBeenCalledTimes(1)
  })

  test('keeps Shift Enter as a newline', async () => {
    const onSubmit = vi.fn()
    render(<ControlledChatInput onSubmit={onSubmit} />)

    const input = screen.getByTestId('chat-message-input')
    await userEvent.type(input, 'hello{shift>}{enter}{/shift}world')

    expect(input).toHaveValue('hello\nworld')
    expect(onSubmit).not.toHaveBeenCalled()
  })
})
