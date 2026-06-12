import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
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
  const devices = overrides.devices?.map(device => ({
    ...device,
    bind_shell: device.bind_shell ?? 'claudecode',
    executor_version:
      device.bind_shell === 'openclaw'
        ? device.executor_version
        : device.executor_version ?? '1.8.5',
  })) ?? []

  return {
    projects: [],
    devices,
    currentProjectId: undefined,
    currentStandaloneDeviceId: null,
    onSelectProject: vi.fn(),
    onSelectStandaloneDevice: vi.fn(),
    ...overrides,
    devices,
  }
}

describe('ChatInput', () => {
  const originalCreateObjectUrl = URL.createObjectURL

  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    vi.useRealTimers()
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

    expect(form).toHaveClass('items-end')
    expect(screen.getByTestId('add-context-button')).toHaveClass(
      'h-[52px]',
      'w-[52px]',
      'rounded-[26px]',
    )
    expect(screen.getByTestId('compact-input-pill')).toHaveClass('min-h-[52px]')
    expect(screen.getByTestId('chat-message-input')).toHaveClass(
      'py-[14px]',
      'scrollbar-none',
    )
    expect(screen.getByTestId('send-message-button')).toHaveClass(
      'absolute',
      'bottom-1',
      'right-1',
      'h-11',
      'w-11',
      'rounded-[22px]',
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
      'bottom-1',
      'right-1',
      'h-11',
      'w-11',
    )
    expect(screen.queryByTestId('send-message-button')).not.toBeInTheDocument()

    await userEvent.click(screen.getByTestId('pause-response-button'))

    expect(onPause).toHaveBeenCalledTimes(1)
  })

  test('hides voice input after typing in the compact composer', async () => {
    render(<ControlledChatInput />)

    expect(screen.getByTestId('voice-input-button')).toBeInTheDocument()
    await userEvent.type(screen.getByTestId('chat-message-input'), 'hello')

    expect(screen.queryByTestId('voice-input-button')).not.toBeInTheDocument()
    expect(screen.getByTestId('compact-input-pill')).toHaveClass('pr-14')
    expect(screen.getByTestId('send-message-button')).toHaveClass(
      'bottom-1',
      'right-1',
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

  test('deletes a selected local skill mention as one unit', async () => {
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
      />,
    )

    await userEvent.click(screen.getByTestId('model-selector-button'))

    expect(screen.getByTestId('model-selector-menu')).toBeInTheDocument()
    expect(screen.getByTestId('model-selector-submenu')).toBeInTheDocument()
    expect(screen.getByTestId('model-family-gpt')).toBeInTheDocument()
    expect(screen.getByTestId('model-control-reasoning-high')).toBeInTheDocument()
    expect(screen.getByTestId('model-control-speed-fast')).toBeInTheDocument()
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
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy()

    await userEvent.click(screen.getByTestId('model-option-overseas-gpt-5.5'))

    expect(setSelectedModel).toHaveBeenCalledWith(model)
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

    expect(screen.getByTestId('project-work-menu')).toBeInTheDocument()
    expect(screen.getAllByText('Wegent').length).toBeGreaterThan(0)
    expect(screen.getByText('Docs')).toBeInTheDocument()
    expect(screen.getByTestId('no-project-option')).toHaveTextContent('不使用项目')

    await userEvent.click(screen.getByTestId('project-option-8'))

    expect(onSelectProject).toHaveBeenCalledWith(8)
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
          projects: [{ id: 7, name: 'Wegent', tasks: [] }],
          currentProjectId: 7,
          onSelectStandaloneDevice,
        })}
      />,
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
      />,
    )

    await userEvent.click(screen.getByTestId('project-work-button'))

    expect(screen.getByTestId('no-project-option')).toHaveTextContent('不使用项目')

    await userEvent.click(screen.getByTestId('no-project-option'))

    expect(onSelectStandaloneDevice).toHaveBeenCalledWith(null)
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

    expect(screen.getByTestId('standalone-device-list')).toBeInTheDocument()
    expect(screen.getByText('Cloud Online')).toBeInTheDocument()
    expect(screen.getByText('Local Online')).toBeInTheDocument()
    expect(screen.getByTestId('standalone-device-option-local-offline')).toBeDisabled()

    await userEvent.click(screen.getByTestId('no-project-option'))
    expect(onSelectStandaloneDevice).toHaveBeenCalledWith('cloud-online')

    await userEvent.click(screen.getByTestId('project-work-button'))
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

  test('renders online project devices with neutral secondary text', async () => {
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

    const projectDeviceLabel = screen.getAllByText('online-executor')[0]
    const offlineProjectDeviceLabel = screen.getAllByText('offline-executor')[0]
    expect(projectDeviceLabel).toHaveClass('text-text-secondary')
    expect(projectDeviceLabel).not.toHaveClass('text-primary')
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
