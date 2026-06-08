import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { StrictMode, useState } from 'react'
import { describe, expect, test, vi } from 'vitest'
import type {
  Attachment,
  DeviceInfo,
  LocalDeviceSkill,
  ProjectWithTasks,
  UnifiedModel,
} from '@/types/api'
import type { GuidanceWorkbenchMessage, QueuedWorkbenchMessage } from '@/types/workbench'
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
  return {
    projects: [],
    devices: [],
    currentProjectId: undefined,
    currentStandaloneDeviceId: null,
    executionMode: 'current_workspace',
    executionModeLocked: false,
    onSelectProject: vi.fn(),
    onSelectStandaloneDevice: vi.fn(),
    onExecutionModeChange: vi.fn(),
    ...overrides,
  }
}

describe('ChatInput', () => {
  const originalCreateObjectUrl = URL.createObjectURL

  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    localStorage.clear()
    URL.createObjectURL = originalCreateObjectUrl
  })

  test('renders the desktop composer sections', () => {
    render(
      <ChatInput value="" onChange={vi.fn()} onSubmit={vi.fn()} disabled={false} variant="desktop" />,
    )

    expect(screen.getByTestId('chat-message-input')).toHaveAttribute('rows', '2')
    expect(screen.queryByTestId('custom-mode-button')).not.toBeInTheDocument()
    expect(screen.getByTestId('model-selector-button')).toBeInTheDocument()
    expect(screen.queryByTestId('skill-selector-button')).not.toBeInTheDocument()
    expect(screen.getByTestId('project-work-button')).toBeInTheDocument()
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
      />,
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
      />,
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

  test('keeps the compact mobile composer close to one-line input height', () => {
    render(
      <ChatInput
        value=""
        onChange={vi.fn()}
        onSubmit={vi.fn()}
        disabled={false}
      />,
    )

    const form = screen.getByTestId('chat-message-input').closest('form')

    expect(form).toHaveClass('items-center')
    expect(screen.getByTestId('add-context-button')).toHaveClass(
      'h-[52px]',
      'w-[52px]',
      'rounded-[26px]',
    )
    expect(screen.getByTestId('compact-input-pill')).toHaveClass('min-h-[52px]')
    expect(screen.getByTestId('chat-message-input')).toHaveClass(
      'm-0',
      'block',
      'h-[52px]',
      'box-border',
      'py-[14px]',
      'pl-5',
      'pr-16',
      'scrollbar-none',
    )
    expect(screen.getByTestId('send-message-button')).toHaveClass(
      'absolute',
      'bottom-[4px]',
      'right-[4px]',
      'z-popover',
      'h-11',
      'w-11',
      'rounded-[22px]',
    )
    expect(screen.getByTestId('send-message-button')).not.toHaveClass(
      'top-1/2',
      '-translate-y-1/2',
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
      />,
    )

    expect(screen.getByTestId('pause-response-button')).toHaveClass(
      'absolute',
      'bottom-[4px]',
      'right-[4px]',
      'z-popover',
      'h-11',
      'w-11',
    )
    expect(screen.queryByTestId('send-message-button')).not.toBeInTheDocument()

    await userEvent.click(screen.getByTestId('pause-response-button'))

    expect(onPause).toHaveBeenCalledTimes(1)
  })

  test('does not render voice input in the compact composer', async () => {
    render(<ControlledChatInput />)

    expect(screen.queryByTestId('voice-input-button')).not.toBeInTheDocument()
    expect(screen.getByTestId('chat-message-input')).toHaveClass('pr-16')

    await userEvent.type(screen.getByTestId('chat-message-input'), 'hello')

    expect(screen.queryByTestId('voice-input-button')).not.toBeInTheDocument()
    expect(screen.getByTestId('chat-message-input')).toHaveClass('pr-16')
    expect(screen.getByTestId('send-message-button')).toHaveClass(
      'bottom-[4px]',
      'right-[4px]',
      'z-popover',
    )
    expect(screen.getByTestId('send-message-button')).not.toHaveClass(
      'top-1/2',
      '-translate-y-1/2',
    )
  })

  test('keeps the compact send button anchored to the bottom for multiline input', async () => {
    render(<ControlledChatInput />)

    await userEvent.type(
      screen.getByTestId('chat-message-input'),
      'first line{shift>}{enter}{/shift}second line',
    )

    expect(screen.getByTestId('chat-message-input')).toHaveValue(
      'first line\nsecond line',
    )
    expect(screen.getByTestId('send-message-button')).toHaveClass(
      'bottom-[4px]',
      'right-[4px]',
      'z-popover',
    )
    expect(screen.getByTestId('send-message-button')).not.toHaveClass(
      'top-1/2',
      '-translate-y-1/2',
    )
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

    render(
      <ControlledChatInput
        projectChat={projectChatControls({ listLocalSkills })}
      />,
    )

    await userEvent.type(screen.getByTestId('chat-message-input'), '$')

    await waitFor(() => {
      expect(listLocalSkills).toHaveBeenCalledTimes(1)
    })
    expect(screen.getByTestId('local-skill-autocomplete')).toHaveClass(
      'bottom-[calc(100%+1rem)]',
      'z-popover',
      'bg-background',
      'left-[-1rem]',
      'right-[-3.5rem]',
    )
    await userEvent.click(await screen.findByTestId('local-skill-option-env-context'))

    expect(screen.getByTestId('chat-message-input')).toHaveValue(
      '[$env-context](skill:///Users/crystal/.codex/skills/env-context/SKILL.md) ',
    )
    expect(screen.getByTestId('local-skill-chip-env-context')).toHaveTextContent('Env Context')
    expect(await screen.findByTestId('local-skill-caret')).toHaveClass('local-skill-caret')
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

    render(
      <ControlledChatInput
        projectChat={projectChatControls({ listLocalSkills })}
      />,
    )

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

  test('shows plugin skill names with plugin prefix and origin labels', async () => {
    const wegentPluginSkill: LocalDeviceSkill = {
      name: 'brainstorming',
      description: 'Use before creative work',
      short_description: 'Use before creative work',
      path: '/Users/crystal/.claude/plugins/cache/claude-plugins-official/superpowers/5.0.7/skills/brainstorming/SKILL.md',
      source: 'claude-plugin',
      origin: 'wegent',
      plugin_name: 'superpowers',
    }
    const localPluginSkill: LocalDeviceSkill = {
      name: 'github',
      description: 'Inspect repositories and pull requests',
      short_description: 'GitHub workflow support',
      path: '/Users/crystal/.codex/plugins/cache/openai-curated/github/83d1f0d2/skills/github/SKILL.md',
      source: 'codex-plugin',
      origin: 'local',
      plugin_name: 'github',
    }
    const listLocalSkills = vi
      .fn()
      .mockResolvedValue([wegentPluginSkill, localPluginSkill])

    render(
      <ControlledChatInput
        projectChat={projectChatControls({ listLocalSkills })}
      />,
    )

    await userEvent.type(screen.getByTestId('chat-message-input'), '$')

    const wegentOption = await screen.findByTestId('local-skill-option-brainstorming')
    const localOption = screen.getByTestId('local-skill-option-github')

    expect(screen.getByText('Superpowers: Brainstorming')).toBeInTheDocument()
    expect(screen.getByText('Github: Github')).toBeInTheDocument()
    expect(wegentOption).toHaveClass('min-h-8', 'py-1.5')
    expect(wegentOption.querySelector('.lucide-package')).toBeInTheDocument()
    expect(wegentOption).toHaveTextContent(
      'workbench.local_skill_origin_wegent',
    )
    expect(localOption).toHaveTextContent(
      'workbench.local_skill_origin_local',
    )

    await userEvent.click(wegentOption)

    const selectedChip = screen.getByTestId('local-skill-chip-brainstorming')
    expect(selectedChip).toHaveTextContent('Superpowers: Brainstorming')
    expect(selectedChip).toHaveClass('text-blue-600')
    expect(selectedChip).not.toHaveClass('bg-[#FFF8EA]', 'border-[#E6D5AF]')
    expect(selectedChip.querySelector('.lucide-package')).toBeInTheDocument()
  })

  test('sorts local skill suggestions by display name', async () => {
    const listLocalSkills = vi.fn().mockResolvedValue([
      {
        name: 'zeta-helper',
        description: 'Last plugin skill',
        short_description: 'Last plugin skill',
        path: '/Users/crystal/.codex/plugins/cache/openai-curated/zeta/83d1f0d2/skills/zeta-helper/SKILL.md',
        source: 'codex-plugin',
        origin: 'local',
        plugin_name: 'zeta',
      },
      {
        name: 'alpha-helper',
        description: 'First local skill',
        short_description: 'First local skill',
        path: '/Users/crystal/.codex/skills/alpha-helper/SKILL.md',
        source: 'codex',
        origin: 'local',
      },
      {
        name: 'beta-helper',
        description: 'Middle plugin skill',
        short_description: 'Middle plugin skill',
        path: '/Users/crystal/.claude/plugins/cache/claude-plugins-official/beta/5.0.7/skills/beta-helper/SKILL.md',
        source: 'claude-plugin',
        origin: 'wegent',
        plugin_name: 'beta',
      },
    ])

    render(
      <ControlledChatInput
        projectChat={projectChatControls({ listLocalSkills })}
      />,
    )

    await userEvent.type(screen.getByTestId('chat-message-input'), '$')

    const listbox = await screen.findByTestId('local-skill-autocomplete')
    const options = within(listbox).getAllByRole('option')

    expect(options.map(option => option.dataset.testid)).toEqual([
      'local-skill-option-alpha-helper',
      'local-skill-option-beta-helper',
      'local-skill-option-zeta-helper',
    ])
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

    render(
      <ControlledChatInput
        projectChat={projectChatControls({ listLocalSkills })}
      />,
    )

    const input = screen.getByTestId('chat-message-input')
    await userEvent.type(input, '$')
    await userEvent.click(await screen.findByTestId('local-skill-option-env-context'))
    await waitFor(() => {
      expect(input).toHaveFocus()
    })
    await userEvent.type(input, 'hello')

    expect(input).toHaveValue(
      '[$env-context](skill:///Users/crystal/.codex/skills/env-context/SKILL.md) hello',
    )
    expect(screen.getByTestId('local-skill-chip-env-context')).toHaveTextContent('Env Context')
  })

  test('deletes local skill mention space before deleting the mention with Backspace', async () => {
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
        projectChat={projectChatControls({ listLocalSkills })}
      />,
    )

    await userEvent.type(screen.getByTestId('chat-message-input'), '$')
    await userEvent.click(await screen.findByTestId('local-skill-option-env-context'))
    await waitFor(() => {
      expect(screen.getByTestId('chat-message-input')).toHaveFocus()
    })
    await userEvent.keyboard('{Backspace}')

    expect(screen.getByTestId('chat-message-input')).toHaveValue(
      '[$env-context](skill:///Users/crystal/.codex/skills/env-context/SKILL.md)',
    )
    expect(screen.getByTestId('local-skill-chip-env-context')).toBeInTheDocument()

    await userEvent.keyboard('{Backspace}')

    expect(screen.getByTestId('chat-message-input')).toHaveValue('')
    expect(screen.queryByTestId('local-skill-chip-env-context')).not.toBeInTheDocument()
  })

  test('deletes a selected local skill mention as one unit with Delete', async () => {
    const skill: LocalDeviceSkill = {
      name: 'brainstorming',
      description: 'Use before creative work',
      short_description: 'Use before creative work',
      path: '/home/ubuntu/.claude/plugins/cache/superpowers-marketplace/superpowers/5.1.0/skills/brainstorming/SKILL.md',
      source: 'claude-plugin',
      origin: 'local',
      plugin_name: 'superpowers',
    }
    const listLocalSkills = vi.fn().mockResolvedValue([skill])

    render(
      <ControlledChatInput
        projectChat={projectChatControls({ listLocalSkills })}
      />,
    )

    const input = screen.getByTestId('chat-message-input')
    await userEvent.type(input, '$')
    await userEvent.click(await screen.findByTestId('local-skill-option-brainstorming'))
    await waitFor(() => {
      expect(input).toHaveFocus()
    })

    input.setSelectionRange(0, 0)
    fireEvent.keyDown(input, { key: 'Delete' })

    expect(input).toHaveValue('')
    expect(screen.queryByText(/\[\$brainstorming]/)).not.toBeInTheDocument()
    expect(screen.queryByTestId('local-skill-chip-brainstorming')).not.toBeInTheDocument()
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
      />,
    )

    await userEvent.type(screen.getByTestId('chat-message-input'), '$')

    expect(await screen.findByTestId('local-skill-autocomplete')).toHaveClass(
      'left-[-1rem]',
      'right-[-0.5rem]',
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
        <ControlledChatInput
          projectChat={projectChatControls({ listLocalSkills })}
        />
      </StrictMode>,
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
    let rejectInitialLoad: (error: Error) => void = () => {}
    const listLocalSkills = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<LocalDeviceSkill[]>((_, reject) => {
            rejectInitialLoad = reject
          }),
      )
      .mockResolvedValueOnce([skill])

    render(
      <ControlledChatInput
        projectChat={projectChatControls({ listLocalSkills })}
      />,
    )

    await userEvent.type(screen.getByTestId('chat-message-input'), '$')
    rejectInitialLoad(new Error('Device is offline'))

    await userEvent.click(
      await screen.findByRole('button', {
        name: /workbench.local_skills_error.*workbench.retry_local_skills/,
      }),
    )

    expect(await screen.findByTestId('local-skill-option-env-context')).toBeInTheDocument()
    expect(listLocalSkills).toHaveBeenCalledTimes(2)
  })

  test('does not open local skill autocomplete for a dollar inside a word', async () => {
    const listLocalSkills = vi.fn().mockResolvedValue([])

    render(
      <ControlledChatInput
        projectChat={projectChatControls({ listLocalSkills })}
      />,
    )

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
      />,
    )

    await userEvent.click(screen.getByTestId('add-context-button'))

    expect(screen.getByTestId('mobile-context-sheet-backdrop')).toHaveClass('z-critical')
    expect(screen.getByTestId('compact-input-pill').className).not.toMatch(
      /\bz-(?:chrome|modal|critical)\b/,
    )
    expect(screen.getByTestId('mobile-context-sheet')).toBeInTheDocument()
    expect(screen.getByTestId('mobile-take-photo-button')).toHaveTextContent('拍照')
    expect(screen.getByTestId('mobile-upload-image-button')).toHaveTextContent('上传文件')
    expect(screen.queryByText('添加照片和文件')).not.toBeInTheDocument()
    expect(screen.getByTestId('mobile-camera-file-input')).toHaveAttribute(
      'accept',
      'image/*',
    )
    expect(screen.getByTestId('mobile-camera-file-input')).toHaveAttribute(
      'capture',
      'environment',
    )
    expect(screen.getByTestId('mobile-image-file-input')).not.toHaveAttribute('accept')

    await userEvent.upload(screen.getByTestId('mobile-image-file-input'), script)

    expect(handleFileSelect).toHaveBeenCalledWith([script])
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
      />,
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
      />,
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
      />,
    )

    fireEvent.paste(screen.getByTestId('chat-message-input'), {
      clipboardData: {
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
      />,
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
      />,
    )

    await userEvent.click(screen.getByTestId('expand-input-button'))
    fireEvent.paste(screen.getByTestId('fullscreen-message-input'), {
      clipboardData: {
        files: [documentFile],
      },
    })

    expect(handleFileSelect).toHaveBeenCalledWith([documentFile])
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
      />,
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
      ['one', 'two', 'three', 'four', 'five'].join('{shift>}{enter}{/shift}'),
    )

    await userEvent.click(screen.getByTestId('expand-input-button'))

    expect(screen.getByTestId('fullscreen-input-sheet')).toBeInTheDocument()
    expect(screen.getByTestId('fullscreen-input-sheet')).toHaveClass('z-critical')
    expect(screen.queryByText('编辑消息')).not.toBeInTheDocument()
    expect(screen.getByTestId('collapse-input-button')).toHaveClass(
      'absolute',
      'right-3',
      'top-3',
    )
    expect(screen.getByTestId('fullscreen-message-input')).toHaveClass(
      'h-full',
      'pt-14',
    )
    expect(screen.getByTestId('fullscreen-message-input')).toHaveValue(
      ['one', 'two', 'three', 'four', 'five'].join('\n'),
    )

    await userEvent.type(screen.getByTestId('fullscreen-message-input'), '!')
    expect(screen.getByTestId('fullscreen-message-input')).toHaveValue(
      `${['one', 'two', 'three', 'four', 'five'].join('\n')}!`,
    )

    await userEvent.click(screen.getByTestId('collapse-input-button'))
    expect(screen.queryByTestId('fullscreen-input-sheet')).not.toBeInTheDocument()
    expect(screen.getByTestId('chat-message-input')).toHaveValue(
      `${['one', 'two', 'three', 'four', 'five'].join('\n')}!`,
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
      />,
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
          controls: {
            speed: true,
          },
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
          selectedModelOptions: { reasoning: 'high', speed: 'fast' },
          setSelectedModel,
        })}
      />,
    )

    await userEvent.click(screen.getByTestId('model-selector-button'))

    expect(screen.getByTestId('model-selector-menu')).toBeInTheDocument()
    expect(screen.getByTestId('model-selector-submenu')).toBeInTheDocument()
    expect(screen.getByTestId('model-family-gpt')).toBeInTheDocument()
    expect(screen.getByTestId('model-control-reasoning-high')).toBeInTheDocument()
    expect(screen.getByTestId('model-control-trigger-speed')).toBeInTheDocument()
    expect(screen.queryByTestId('model-control-speed-fast')).not.toBeInTheDocument()
    expect(screen.queryByTestId('model-option-default')).not.toBeInTheDocument()
    expect(screen.getByTestId('model-selector-button')).toHaveTextContent(
      '海外:gpt-5.5 High ⚡',
    )
    const modelOption = screen.getByTestId('model-option-overseas-gpt-5.5')
    expect(modelOption).toHaveTextContent('海外:gpt-5.5 ⚡')
    expect(modelOption).not.toHaveTextContent('快速')
    expect(modelOption).not.toHaveTextContent('High')
    expect(modelOption.querySelectorAll('span')).toHaveLength(1)
    expect(
      screen
        .getByTestId('model-control-reasoning-high')
        .compareDocumentPosition(screen.getByTestId('model-family-gpt')) &
      Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy()

    await userEvent.hover(screen.getByTestId('model-control-trigger-speed'))

    expect(screen.getByTestId('model-control-submenu-speed')).toBeInTheDocument()
    expect(screen.getByTestId('model-family-gpt')).not.toHaveClass('bg-muted')
    expect(screen.getByTestId('model-control-trigger-speed')).toHaveClass('bg-muted')
    expect(screen.getByTestId('model-control-speed-standard')).toHaveTextContent(
      '标准',
    )
    expect(screen.getByTestId('model-control-speed-standard')).toHaveTextContent(
      '默认速度',
    )
    expect(screen.getByTestId('model-control-speed-fast')).toHaveTextContent('⚡ 快速')
    expect(screen.getByTestId('model-control-speed-fast')).toHaveTextContent(
      '1.5 倍速度，消耗增加',
    )

    await userEvent.hover(screen.getByTestId('model-family-gpt'))
    expect(screen.getByTestId('model-family-gpt')).toHaveClass('bg-muted')
    expect(screen.getByTestId('model-control-trigger-speed')).not.toHaveClass('bg-muted')

    await userEvent.hover(screen.getByTestId('model-control-reasoning-high'))
    expect(screen.getByTestId('model-family-gpt')).not.toHaveClass('bg-muted')
    expect(screen.getByTestId('model-control-trigger-speed')).not.toHaveClass('bg-muted')

    await userEvent.click(screen.getByTestId('model-option-overseas-gpt-5.5'))

    expect(setSelectedModel).toHaveBeenCalledWith(model)
  })

  test('keeps the desktop model menu inside the viewport when it opens upward', async () => {
    const originalInnerHeight = window.innerHeight
    Object.defineProperty(window, 'innerHeight', {
      configurable: true,
      value: 900,
    })
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(
      function getMockRect(this: HTMLElement) {
        const testId = this.getAttribute('data-testid')
        if (testId === 'model-selector-button') {
          return {
            top: 300,
            bottom: 332,
            left: 640,
            right: 780,
            width: 140,
            height: 32,
          } as DOMRect
        }
        if (testId === 'model-selector-menu') {
          return { top: 0, left: 640, width: 256, height: 720 } as DOMRect
        }
        if (testId === 'model-family-gpt') {
          return { top: 340, left: 660, width: 220, height: 36 } as DOMRect
        }
        if (testId === 'model-selector-submenu') {
          return { top: 0, left: 0, width: 288, height: 192 } as DOMRect
        }
        return { top: 0, bottom: 0, left: 0, width: 0, height: 0 } as DOMRect
      },
    )

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

    try {
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
            selectedModelOptions: {},
          })}
        />,
      )

      await userEvent.click(screen.getByTestId('model-selector-button'))

      await waitFor(() => {
        expect(screen.getByTestId('model-selector-menu').parentElement).toHaveStyle({
          top: '64px',
        })
      })
      expect(screen.getByTestId('model-selector-menu')).toHaveStyle({
        maxHeight: '608px',
      })
    } finally {
      Object.defineProperty(window, 'innerHeight', {
        configurable: true,
        value: originalInnerHeight,
      })
    }
  })

  test('keeps the desktop model submenu below the top chrome area', async () => {
    const originalInnerHeight = window.innerHeight
    Object.defineProperty(window, 'innerHeight', {
      configurable: true,
      value: 900,
    })
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(
      function getMockRect(this: HTMLElement) {
        const testId = this.getAttribute('data-testid')
        if (testId === 'model-selector-button') {
          return {
            top: 300,
            bottom: 332,
            left: 640,
            right: 780,
            width: 140,
            height: 32,
          } as DOMRect
        }
        if (testId === 'model-selector-menu') {
          return { top: 64, left: 640, width: 256, height: 608 } as DOMRect
        }
        if (testId === 'model-family-gpt') {
          return { top: 32, left: 660, width: 220, height: 36 } as DOMRect
        }
        if (testId === 'model-selector-submenu') {
          return { top: 0, left: 0, width: 288, height: 192 } as DOMRect
        }
        return { top: 0, bottom: 0, left: 0, width: 0, height: 0 } as DOMRect
      },
    )

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

    try {
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
            selectedModelOptions: {},
          })}
        />,
      )

      await userEvent.click(screen.getByTestId('model-selector-button'))

      await waitFor(() => {
        expect(screen.getByTestId('model-selector-submenu')).toHaveStyle({
          top: '0px',
        })
      })
    } finally {
      Object.defineProperty(window, 'innerHeight', {
        configurable: true,
        value: originalInnerHeight,
      })
    }
  })

  test('hides unsupported Gemini models from the desktop model menu', async () => {
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
    const geminiModel: UnifiedModel = {
      name: 'overseas-gemini-3-pro',
      type: 'public',
      displayName: '海外:gemini-3-pro',
      config: {
        ui: {
          family: 'gemini',
          region: 'overseas',
          modelLabel: 'gemini-3-pro',
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
          models: [gptModel, geminiModel],
          selectedModel: gptModel,
          selectedModelOptions: {},
        })}
      />,
    )

    await userEvent.click(screen.getByTestId('model-selector-button'))

    expect(screen.getByTestId('model-family-gpt')).toBeInTheDocument()
    expect(screen.queryByTestId('model-family-gemini')).not.toBeInTheDocument()
    expect(screen.queryByTestId('model-option-overseas-gemini-3-pro')).not.toBeInTheDocument()
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
      },
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
        />,
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

  test('uses measured desktop submenu width to avoid overlapping the main menu', async () => {
    const originalInnerWidth = window.innerWidth
    Object.defineProperty(window, 'innerWidth', {
      configurable: true,
      value: 1240,
    })
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(
      function getMockRect(this: HTMLElement) {
        const testId = this.getAttribute('data-testid')
        if (testId === 'model-selector-menu') {
          return { top: 64, left: 604, width: 576, height: 620 } as DOMRect
        }
        if (testId === 'model-family-gpt') {
          return { top: 500, left: 620, width: 520, height: 72 } as DOMRect
        }
        if (testId === 'model-selector-submenu') {
          return { top: 0, left: 0, width: 648, height: 432 } as DOMRect
        }
        return { top: 0, bottom: 0, left: 0, width: 0, height: 0 } as DOMRect
      },
    )

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

    try {
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
            selectedModelOptions: {},
          })}
        />,
      )

      await userEvent.click(screen.getByTestId('model-selector-button'))

      await waitFor(() => {
        expect(screen.getByTestId('model-selector-submenu')).toHaveStyle({
          left: '-588px',
          width: '580px',
        })
      })
    } finally {
      Object.defineProperty(window, 'innerWidth', {
        configurable: true,
        value: originalInnerWidth,
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
        })}
      />,
    )

    await userEvent.click(screen.getByTestId('model-selector-button'))

    const disabledOption = screen.getByTestId('model-option-overseas-gpt-5.4')
    expect(disabledOption).toBeDisabled()
    expect(disabledOption).toHaveAttribute('aria-disabled', 'true')
    expect(disabledOption).toHaveAttribute(
      'title',
      'Incompatible with the current model protocol',
    )
    expect(disabledOption).toHaveTextContent(
      'Incompatible with the current model protocol',
    )

    await userEvent.click(disabledOption)

    expect(setSelectedModel).not.toHaveBeenCalled()
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
      />,
    )

    await userEvent.click(screen.getByTestId('model-selector-button'))
    await userEvent.click(screen.getByTestId('model-control-reasoning-medium'))

    expect(setSelectedModelOption).toHaveBeenCalledWith('reasoning', 'medium')
    await waitFor(() => {
      expect(screen.queryByTestId('model-selector-menu')).not.toBeInTheDocument()
    })
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
      />,
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
          controls: {
            speed: true,
          },
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
      />,
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
      />,
    )

    expect(screen.queryByTestId('skill-selector-button')).not.toBeInTheDocument()
    expect(screen.queryByTestId('skill-selector-menu')).not.toBeInTheDocument()
  })

  test('opens the desktop add context menu with only file upload', async () => {
    render(
      <ChatInput value="" onChange={vi.fn()} onSubmit={vi.fn()} disabled={false} variant="desktop" />,
    )

    await userEvent.click(screen.getByTestId('add-context-button'))

    expect(screen.getByTestId('add-context-menu')).toBeInTheDocument()
    expect(screen.getByText('添加照片和文件')).toBeInTheDocument()
    expect(screen.queryByText('Attach Google Chrome')).not.toBeInTheDocument()
    expect(screen.queryByText('计划模式')).not.toBeInTheDocument()
    expect(screen.queryByText('追求目标')).not.toBeInTheDocument()
    expect(screen.queryByText('插件')).not.toBeInTheDocument()
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
      />,
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
      />,
    )

    expect(screen.getByTestId('attachment-badge')).toHaveClass('h-14', 'w-[220px]', 'rounded-xl')
    expect(screen.getByTestId('attachment-document-icon')).toHaveTextContent('PDF')
    expect(screen.getByText('brief.pdf')).toHaveClass('truncate')
    expect(screen.getAllByText('PDF')).toHaveLength(2)
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
      />,
    )

    await waitFor(() => {
      expect(screen.getByTestId('attachment-image-preview')).toHaveAttribute(
        'src',
        'blob:attachment-preview'
      )
    })
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
      />,
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
      />,
    )

    expect(screen.getByTestId('send-message-button')).toBeEnabled()
    await userEvent.click(screen.getByTestId('send-message-button'))
    expect(onSubmit).toHaveBeenCalledTimes(1)
  })

  test('opens project work menu and selects a project', async () => {
    const onSelectProject = vi.fn()
    const projects: ProjectWithTasks[] = [
      { id: 7, name: 'Wegent', tasks: [] },
      { id: 8, name: 'Docs', tasks: [] },
    ]

    render(
      <ChatInput
        value=""
        onChange={vi.fn()}
        onSubmit={vi.fn()}
        disabled={false}
        variant="desktop"
        projectWork={projectWorkControls({
          projects,
          currentProjectId: 7,
          onSelectProject,
        })}
      />,
    )

    await userEvent.click(screen.getByTestId('project-work-button'))

    expect(screen.getByTestId('project-work-menu')).toHaveClass('top-11')
    expect(screen.getByTestId('project-options-list')).toHaveClass(
      'min-h-0',
      'flex-1',
      'overflow-y-auto',
    )
    expect(screen.getByTestId('project-options-list')).toHaveStyle({
      maxHeight: '150px',
    })
    expect(screen.getByTestId('project-option-7')).toHaveClass('h-9')
    expect(screen.getAllByText('Wegent').length).toBeGreaterThan(0)
    expect(screen.getByText('Docs')).toBeInTheDocument()
    expect(screen.getByTestId('no-project-option')).toHaveTextContent('不使用项目')
    expect(screen.getByTestId('no-project-option')).toHaveClass('h-8')

    await userEvent.click(screen.getByTestId('project-option-8'))

    expect(onSelectProject).toHaveBeenCalledWith(8)
  })

  test('shows launch modes beside existing local workspace projects', async () => {
    const onExecutionModeChange = vi.fn()
    const projects: ProjectWithTasks[] = [
      {
        id: 7,
        name: 'Wegent',
        config: {
          mode: 'workspace',
          device_id: 'device-1',
          workspace: {
            source: 'local_path',
            localPath: '/workspace/projects/Wegent',
          },
        },
        tasks: [],
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
          projects,
          currentProjectId: 7,
          executionMode: 'current_workspace',
          onExecutionModeChange,
        })}
      />,
    )

    expect(screen.getByTestId('project-work-button')).toHaveTextContent('Wegent')
    expect(screen.getByTestId('project-work-button')).toHaveClass(
      'hover:shadow-[0_10px_28px_rgba(0,0,0,0.14)]',
    )
    expect(screen.getByTestId('execution-mode-button')).toHaveTextContent('本地模式')
    expect(screen.getByTestId('execution-mode-button')).toHaveClass(
      'hover:shadow-[0_10px_28px_rgba(0,0,0,0.14)]',
    )

    await userEvent.click(screen.getByTestId('project-work-button'))

    expect(screen.getByTestId('project-work-menu')).toBeInTheDocument()
    expect(screen.getByTestId('project-work-button')).toHaveClass(
      'shadow-[0_10px_28px_rgba(0,0,0,0.14)]',
    )
    expect(screen.queryByTestId('project-execution-mode-menu-section')).not.toBeInTheDocument()

    await userEvent.click(screen.getByTestId('execution-mode-button'))

    expect(screen.queryByTestId('project-work-menu')).not.toBeInTheDocument()
    expect(screen.getByTestId('project-execution-mode-menu')).toBeInTheDocument()
    expect(screen.getByTestId('execution-mode-button')).toHaveClass(
      'shadow-[0_10px_28px_rgba(0,0,0,0.14)]',
    )
    expect(screen.getByTestId('project-execution-mode-menu-section')).toHaveTextContent(
      '启动模式',
    )
    expect(screen.getByTestId('execution-mode-current-workspace-button')).toHaveTextContent(
      '在本地处理',
    )
    expect(screen.getByTestId('execution-mode-git-worktree-button')).toHaveTextContent(
      '新工作树',
    )

    await userEvent.click(screen.getByTestId('execution-mode-git-worktree-button'))

    expect(onExecutionModeChange).toHaveBeenCalledWith('git_worktree')
    expect(screen.queryByTestId('project-execution-mode-menu')).not.toBeInTheDocument()
  })

  test('switches branches immediately from the new project chat work bar', async () => {
    const onListBranches = vi.fn().mockResolvedValue(['feature/chat', 'main'])
    const onCheckoutBranch = vi.fn().mockResolvedValue(undefined)
    const onRefreshBranch = vi.fn().mockResolvedValue(undefined)
    const projects: ProjectWithTasks[] = [
      {
        id: 7,
        name: 'Wegent',
        config: {
          mode: 'workspace',
          device_id: 'device-1',
          workspace: {
            source: 'local_path',
            localPath: '/workspace/projects/Wegent',
          },
        },
        tasks: [],
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
          projects,
          currentProjectId: 7,
          branchName: 'main',
          onRefreshBranch,
          onListBranches,
          onCheckoutBranch,
        })}
      />,
    )

    expect(screen.getByTestId('project-branch-button')).toHaveTextContent('main')
    await userEvent.click(screen.getByTestId('project-branch-button'))

    await waitFor(() => {
      expect(onRefreshBranch).toHaveBeenCalledTimes(1)
      expect(onListBranches).toHaveBeenCalledTimes(1)
    })

    const options = await screen.findAllByTestId('project-branch-option')
    await userEvent.click(options[0])

    expect(onCheckoutBranch).toHaveBeenCalledWith('feature/chat')
    await waitFor(() => {
      expect(screen.queryByTestId('project-branch-menu')).not.toBeInTheDocument()
    })
  })

  test('creates and checks out a branch from the new project chat work bar', async () => {
    const onCreateBranch = vi.fn().mockResolvedValue(undefined)

    render(
      <ChatInput
        value=""
        onChange={vi.fn()}
        onSubmit={vi.fn()}
        disabled={false}
        variant="desktop"
        projectWork={projectWorkControls({
          projects: [{ id: 7, name: 'Wegent', tasks: [] }],
          currentProjectId: 7,
          branchName: 'main',
          onListBranches: vi.fn().mockResolvedValue(['main']),
          onCheckoutBranch: vi.fn().mockResolvedValue(undefined),
          onCreateBranch,
        })}
      />,
    )

    await userEvent.click(screen.getByTestId('project-branch-button'))
    await screen.findAllByTestId('project-branch-option')
    await userEvent.click(screen.getByTestId('project-open-new-branch-button'))
    await userEvent.type(screen.getByTestId('project-new-branch-input'), 'feature/new-chat')
    await userEvent.click(screen.getByTestId('project-confirm-new-branch-button'))

    expect(onCreateBranch).toHaveBeenCalledWith('feature/new-chat')
  })

  test('hides branch switching when the project conversation is locked', () => {
    render(
      <ChatInput
        value=""
        onChange={vi.fn()}
        onSubmit={vi.fn()}
        disabled={false}
        variant="desktop"
        projectWork={projectWorkControls({
          projects: [{ id: 7, name: 'Wegent', tasks: [] }],
          currentProjectId: 7,
          executionModeLocked: true,
          branchName: 'main',
          onListBranches: vi.fn().mockResolvedValue(['main']),
          onCheckoutBranch: vi.fn().mockResolvedValue(undefined),
        })}
      />,
    )

    expect(screen.queryByTestId('project-branch-button')).not.toBeInTheDocument()
  })

  test('hides branch switching when the current workspace is not a git repository', () => {
    render(
      <ChatInput
        value=""
        onChange={vi.fn()}
        onSubmit={vi.fn()}
        disabled={false}
        variant="desktop"
        projectWork={projectWorkControls({
          projects: [{ id: 7, name: 'Plain folder', tasks: [] }],
          currentProjectId: 7,
          branchName: '',
          onListBranches: vi.fn().mockResolvedValue([]),
          onCheckoutBranch: vi.fn().mockResolvedValue(undefined),
        })}
      />,
    )

    expect(screen.queryByTestId('project-branch-button')).not.toBeInTheDocument()
  })

  test('opens project work menu upward when below cannot fit the four-row menu', async () => {
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function () {
      if ((this as HTMLElement).dataset.testid === 'project-work-button') {
        return {
          x: 0,
          y: 720,
          width: 160,
          height: 36,
          top: 720,
          right: 160,
          bottom: 756,
          left: 0,
          toJSON: () => ({}),
        } as DOMRect
      }

      return {
        x: 0,
        y: 0,
        width: 0,
        height: 0,
        top: 0,
        right: 0,
        bottom: 0,
        left: 0,
        toJSON: () => ({}),
      } as DOMRect
    })

    render(
      <ChatInput
        value=""
        onChange={vi.fn()}
        onSubmit={vi.fn()}
        disabled={false}
        variant="desktop"
        projectWork={projectWorkControls({
          projects: [
            { id: 7, name: 'Wegent', tasks: [] },
            { id: 8, name: 'Docs', tasks: [] },
            { id: 9, name: 'MCPs', tasks: [] },
            { id: 10, name: 'hello-gpt', tasks: [] },
            { id: 11, name: 'ai-exam', tasks: [] },
            { id: 12, name: 'weekly-report', tasks: [] },
          ],
          onCreateProjectMode: vi.fn(),
        })}
      />,
    )

    await userEvent.click(screen.getByTestId('project-work-button'))

    await waitFor(() => {
      expect(screen.getByTestId('project-work-menu')).toHaveClass('bottom-11')
    })
    expect(screen.getByTestId('project-options-list')).toHaveClass('overflow-y-auto')
    expect(screen.getByTestId('add-project-option')).toBeInTheDocument()
    expect(screen.getByTestId('no-project-option')).toBeInTheDocument()
  })

  test('keeps project work menu below when clipped space can fit four rows and actions', async () => {
    const originalInnerHeight = window.innerHeight
    Object.defineProperty(window, 'innerHeight', {
      configurable: true,
      value: 1000,
    })
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function () {
      const testId = (this as HTMLElement).dataset.testid
      if (testId === 'project-work-button') {
        return {
          x: 0,
          y: 500,
          width: 160,
          height: 40,
          top: 500,
          right: 160,
          bottom: 540,
          left: 0,
          toJSON: () => ({}),
        } as DOMRect
      }

      if (testId === 'project-work-clipping-shell') {
        return {
          x: 0,
          y: 0,
          width: 900,
          height: 896,
          top: 0,
          right: 900,
          bottom: 896,
          left: 0,
          toJSON: () => ({}),
        } as DOMRect
      }

      return {
        x: 0,
        y: 0,
        width: 0,
        height: 0,
        top: 0,
        right: 0,
        bottom: 0,
        left: 0,
        toJSON: () => ({}),
      } as DOMRect
    })

    try {
      render(
        <div data-testid="project-work-clipping-shell" style={{ overflow: 'hidden' }}>
          <ChatInput
            value=""
            onChange={vi.fn()}
            onSubmit={vi.fn()}
            disabled={false}
            variant="desktop"
            projectWork={projectWorkControls({
              projects: [
                { id: 7, name: 'Wegent', tasks: [] },
                { id: 8, name: 'Docs', tasks: [] },
                { id: 9, name: 'MCPs', tasks: [] },
                { id: 10, name: 'hello-gpt', tasks: [] },
                { id: 11, name: 'ai-exam', tasks: [] },
                { id: 12, name: 'weekly-report', tasks: [] },
              ],
              onCreateProjectMode: vi.fn(),
            })}
          />
        </div>,
      )

      await userEvent.click(screen.getByTestId('project-work-button'))

      const menu = screen.getByTestId('project-work-menu')
      expect(menu).toHaveClass('top-11')
      expect(menu).toHaveStyle({ maxHeight: '340px' })
      expect(screen.getByTestId('project-options-list')).toHaveStyle({
        maxHeight: '150px',
      })
      expect(screen.getByTestId('add-project-option')).toBeInTheDocument()
      expect(screen.getByTestId('no-project-option')).toBeInTheDocument()
    } finally {
      Object.defineProperty(window, 'innerHeight', {
        configurable: true,
        value: originalInnerHeight,
      })
    }
  })

  test('opens project creation submenu upward when it would be clipped below', async () => {
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function () {
      const testId = (this as HTMLElement).dataset.testid
      if (testId === 'add-project-option') {
        return {
          x: 0,
          y: 720,
          width: 240,
          height: 32,
          top: 720,
          right: 240,
          bottom: 752,
          left: 0,
          toJSON: () => ({}),
        } as DOMRect
      }

      return {
        x: 0,
        y: 0,
        width: 0,
        height: 0,
        top: 0,
        right: 0,
        bottom: 0,
        left: 0,
        toJSON: () => ({}),
      } as DOMRect
    })

    render(
      <ChatInput
        value=""
        onChange={vi.fn()}
        onSubmit={vi.fn()}
        disabled={false}
        variant="desktop"
        projectWork={projectWorkControls({
          projects: [{ id: 7, name: 'Wegent', tasks: [] }],
          onCreateProjectMode: vi.fn(),
        })}
      />,
    )

    await userEvent.click(screen.getByTestId('project-work-button'))
    await userEvent.click(screen.getByTestId('add-project-option'))

    const createSubmenu = screen.getByTestId('create-project-submenu')
    expect(createSubmenu.parentElement).toHaveClass('bottom-0')
    expect(createSubmenu).toHaveTextContent('新建空白项目')
  })

  test('filters project work menu by project and device text', async () => {
    const projects: ProjectWithTasks[] = [
      {
        id: 7,
        name: 'Wegent',
        config: { execution: { targetType: 'local', deviceId: 'macbook-local' } },
        tasks: [],
      },
      {
        id: 8,
        name: 'Docs',
        config: { execution: { targetType: 'cloud', deviceId: 'cloud-docs' } },
        tasks: [],
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
          projects,
          onCreateProjectMode: vi.fn(),
          devices: [
            {
              id: 1,
              device_id: 'macbook-local',
              name: 'MacBook Pro',
              status: 'online',
              is_default: false,
            },
            {
              id: 2,
              device_id: 'cloud-docs',
              name: 'Docs Runner',
              status: 'online',
              is_default: false,
            },
          ],
        })}
      />,
    )

    await userEvent.click(screen.getByTestId('project-work-button'))

    const searchInput = screen.getByTestId('project-search-input')
    await waitFor(() => expect(searchInput).toHaveFocus())
    expect(searchInput).toHaveAttribute('placeholder', '搜索项目')

    await userEvent.type(searchInput, 'docs')
    expect(screen.queryByTestId('project-option-7')).not.toBeInTheDocument()
    expect(screen.getByTestId('project-option-8')).toBeInTheDocument()
    expect(screen.getByTestId('add-project-option')).toBeInTheDocument()
    expect(screen.getByTestId('no-project-option')).toBeInTheDocument()

    await userEvent.clear(searchInput)
    await userEvent.type(searchInput, 'macbook')
    expect(screen.getByTestId('project-option-7')).toBeInTheDocument()
    expect(screen.queryByTestId('project-option-8')).not.toBeInTheDocument()

    await userEvent.clear(searchInput)
    await userEvent.type(searchInput, 'missing')
    expect(screen.getByTestId('project-search-empty')).toHaveTextContent('没有匹配的项目')
    expect(screen.getByTestId('add-project-option')).toBeInTheDocument()
    expect(screen.getByTestId('no-project-option')).toBeInTheDocument()
  })

  test('shows no-project transition from the standalone entry', async () => {
    const onSelectStandaloneDevice = vi.fn()
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
          projects: [{ id: 7, name: 'Wegent', tasks: [] }],
          devices,
          currentProjectId: 7,
          onSelectStandaloneDevice,
        })}
      />,
    )

    await userEvent.click(screen.getByTestId('project-work-button'))
    await userEvent.click(screen.getByTestId('no-project-option'))
    await userEvent.click(screen.getByTestId('standalone-device-option-cloud-online'))

    expect(onSelectStandaloneDevice).toHaveBeenCalledWith('cloud-online')
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
      />,
    )

    await userEvent.click(screen.getByTestId('project-work-button'))

    expect(screen.getByTestId('no-project-option')).toHaveTextContent('不使用项目')

    await userEvent.click(screen.getByTestId('no-project-option'))

    expect(screen.getByTestId('standalone-device-submenu')).toBeInTheDocument()
    expect(onSelectStandaloneDevice).not.toHaveBeenCalled()
  })

  test('shows add project option above no-project and opens the creation submenu', async () => {
    const onCreateProjectMode = vi.fn()

    render(
      <ChatInput
        value=""
        onChange={vi.fn()}
        onSubmit={vi.fn()}
        disabled={false}
        variant="desktop"
        projectWork={projectWorkControls({
          projects: [{ id: 7, name: 'Wegent', tasks: [] }],
          onCreateProjectMode,
        })}
      />,
    )

    await userEvent.click(screen.getByTestId('project-work-button'))

    const menu = screen.getByTestId('project-work-menu')
    expect(screen.getByTestId('add-project-option')).toHaveTextContent('添加新项目')
    expect(
      [...menu.querySelectorAll('button')].map(button => button.dataset.testid),
    ).toEqual([
      'project-option-7',
      'add-project-option',
      'no-project-option',
    ])

    await userEvent.click(screen.getByTestId('add-project-option'))

    expect(screen.getByTestId('create-project-submenu')).toBeInTheDocument()
    expect(screen.getByTestId('project-start-from-scratch-option')).toHaveTextContent(
      '新建空白项目',
    )
    expect(screen.getByTestId('project-existing-folder-option')).toHaveTextContent('使用现有目录')
    expect(screen.getByTestId('project-clone-from-git-option')).toHaveTextContent('从 Git 克隆')

    await userEvent.click(screen.getByTestId('project-start-from-scratch-option'))

    expect(onCreateProjectMode).toHaveBeenCalledWith('scratch')
    expect(screen.queryByTestId('project-work-menu')).not.toBeInTheDocument()
  })

  test('lists standalone devices under no-project and defaults to online cloud devices', async () => {
    const onSelectStandaloneDevice = vi.fn()
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
      {
        id: 3,
        device_id: 'local-offline',
        name: 'Local Offline',
        status: 'offline',
        is_default: false,
        device_type: 'local',
      },
      {
        id: 4,
        device_id: 'openclaw-online',
        name: 'OpenClaw Online',
        status: 'online',
        is_default: false,
        device_type: 'cloud',
        bind_shell: 'openclaw',
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
      />,
    )

    await userEvent.click(screen.getByTestId('project-work-button'))

    expect(screen.queryByTestId('standalone-device-submenu')).not.toBeInTheDocument()
    await userEvent.click(screen.getByTestId('no-project-option'))

    expect(screen.getByTestId('standalone-device-submenu')).toBeInTheDocument()
    expect(screen.getByText('Cloud Online')).toBeInTheDocument()
    expect(screen.getByText('Local Online')).toBeInTheDocument()
    expect(screen.queryByText('OpenClaw Online')).not.toBeInTheDocument()
    expect(screen.getByTestId('standalone-device-option-local-offline')).toBeDisabled()

    await userEvent.click(screen.getByTestId('standalone-device-option-cloud-online'))
    expect(onSelectStandaloneDevice).toHaveBeenCalledWith('cloud-online')

    await userEvent.click(screen.getByTestId('project-work-button'))
    await userEvent.click(screen.getByTestId('no-project-option'))
    await userEvent.click(screen.getByTestId('standalone-device-option-local-online'))
    expect(onSelectStandaloneDevice).toHaveBeenLastCalledWith('local-online')
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
          projects: [{ id: 7, name: 'hello', tasks: [] }],
          devices,
          currentProjectId: 7,
          currentStandaloneDeviceId: 'cloud-online',
        })}
      />,
    )

    await userEvent.click(screen.getByTestId('project-work-button'))

    expect(screen.getByTestId('project-selected-icon-7')).toBeInTheDocument()
    expect(
      screen.queryByTestId('standalone-device-selected-icon-cloud-online')
    ).not.toBeInTheDocument()
  })

  test('marks the current standalone device when no project is selected', async () => {
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
      />,
    )

    await userEvent.click(screen.getByTestId('project-work-button'))
    await userEvent.click(screen.getByTestId('no-project-option'))

    expect(
      screen.getByTestId('standalone-device-selected-icon-local-online')
    ).toBeInTheDocument()
    expect(
      screen.queryByTestId('standalone-device-selected-icon-cloud-online')
    ).not.toBeInTheDocument()
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
      />,
    )

    expect(screen.getByTestId('project-work-button')).toHaveTextContent('进入项目工作')

    await userEvent.click(screen.getByTestId('project-work-button'))

    expect(screen.getByTestId('no-project-option')).toHaveTextContent('不使用项目')
    expect(screen.getByTestId('project-work-menu')).not.toHaveTextContent('进入项目工作')
  })

  test('renders online project and standalone devices with neutral secondary text', async () => {
    const projects: ProjectWithTasks[] = [
      {
        id: 7,
        name: 'Wegent',
        config: { execution: { targetType: 'cloud', deviceId: 'device-online' } },
        tasks: [],
      },
      {
        id: 8,
        name: 'Docs',
        config: { execution: { targetType: 'local', deviceId: 'device-offline' } },
        tasks: [],
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
          projects,
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
      />,
    )

    await userEvent.click(screen.getByTestId('project-work-button'))
    await userEvent.click(screen.getByTestId('no-project-option'))

    const projectDeviceLabel = screen.getAllByText('online-executor')[0]
    const offlineProjectDeviceLabel = screen.getAllByText('offline-executor')[0]
    const standaloneDeviceStatus = screen
      .getByTestId('standalone-device-option-device-online')
      .querySelector('span:last-of-type')
    expect(projectDeviceLabel).toHaveClass('text-text-secondary')
    expect(projectDeviceLabel).not.toHaveClass('text-primary')
    expect(standaloneDeviceStatus).toHaveClass('text-text-secondary')
    expect(standaloneDeviceStatus).not.toHaveClass('text-primary')
    expect(offlineProjectDeviceLabel).toHaveClass('text-text-muted')
  })

  test('marks projects with offline devices as unavailable and prevents selection', async () => {
    const onSelectProject = vi.fn()
    const projects: ProjectWithTasks[] = [
      {
        id: 7,
        name: 'Online Project',
        config: { execution: { targetType: 'cloud', deviceId: 'device-online' } },
        tasks: [],
      },
      {
        id: 8,
        name: 'Offline Project',
        config: { execution: { targetType: 'local', deviceId: 'device-offline' } },
        tasks: [],
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
          projects,
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
      />,
    )

    await userEvent.click(screen.getByTestId('project-work-button'))

    const offlineProject = screen.getByTestId('project-option-8')
    expect(offlineProject).toBeDisabled()
    expect(offlineProject).toHaveAttribute('aria-disabled', 'true')
    expect(screen.getByTestId('project-unavailable-icon-8')).toBeInTheDocument()

    await userEvent.click(offlineProject)

    expect(onSelectProject).not.toHaveBeenCalledWith(8)
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
      />,
    )

    expect(screen.getByTestId('model-selector-button')).not.toBeDisabled()
    expect(screen.queryByTestId('skill-selector-button')).not.toBeInTheDocument()
  })

  test.each([
    ['model selector', 'model-selector-button', 'model-selector-menu'],
    ['add context menu', 'add-context-button', 'add-context-menu'],
    ['project work menu', 'project-work-button', 'project-work-menu'],
  ])('closes the desktop %s when clicking outside the dropdown', async (_, buttonTestId, menuTestId) => {
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
      />,
    )

    await userEvent.click(screen.getByTestId(buttonTestId))
    expect(screen.getByTestId(menuTestId)).toBeInTheDocument()

    await userEvent.click(screen.getByTestId('chat-message-input'))

    expect(screen.queryByTestId(menuTestId)).not.toBeInTheDocument()
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

  test('keeps Shift Enter as a newline', async () => {
    const onSubmit = vi.fn()
    render(<ControlledChatInput onSubmit={onSubmit} />)

    const input = screen.getByTestId('chat-message-input')
    await userEvent.type(input, 'hello{shift>}{enter}{/shift}world')

    expect(input).toHaveValue('hello\nworld')
    expect(onSubmit).not.toHaveBeenCalled()
  })
})
