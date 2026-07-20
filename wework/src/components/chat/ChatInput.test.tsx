import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { describe, expect, test, vi } from 'vitest'
import type {
  Attachment,
  DeviceInfo,
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
import type { ChatSubmitOptions } from './ChatInput'
import type { ProjectChatControls, ProjectWorkControls } from './ChatInput'

function ControlledChatInput({
  onSubmit = vi.fn(),
  projectChat,
  variant,
}: {
  onSubmit?: (valueOverride?: string, options?: ChatSubmitOptions) => void
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
    listLocalApps: vi.fn().mockResolvedValue([]),
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
    expect(screen.getByTestId('project-chat-composer')).toHaveClass(
      'shadow-[0_0_0_0.5px_rgba(13,13,13,0.12),0_3px_7.5px_rgba(0,0,0,0.04),0_0_20px_rgba(0,0,0,0.05)]'
    )
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

  test('does not move selection when an unfocused composer syncs its value', async () => {
    const renderComposers = (backgroundValue?: string) => (
      <>
        <ChatInput
          value="foreground draft"
          onChange={vi.fn()}
          onSubmit={vi.fn()}
          disabled={false}
          variant="desktop"
        />
        {backgroundValue !== undefined ? (
          <ChatInput
            value={backgroundValue}
            onChange={vi.fn()}
            onSubmit={vi.fn()}
            disabled={false}
            variant="desktop"
          />
        ) : null}
      </>
    )
    const { rerender } = render(renderComposers())
    const foregroundComposer = screen.getByTestId('chat-message-input')
    foregroundComposer.focus()
    await waitFor(() => {
      expect(foregroundComposer).toHaveFocus()
      expect(foregroundComposer.contains(window.getSelection()?.anchorNode ?? null)).toBe(true)
    })

    const textNode = document.createTreeWalker(foregroundComposer, NodeFilter.SHOW_TEXT).nextNode()
    expect(textNode).not.toBeNull()
    const range = document.createRange()
    range.setStart(textNode!, 5)
    range.collapse(true)
    const selection = window.getSelection()!
    act(() => {
      selection.removeAllRanges()
      selection.addRange(range)
      document.dispatchEvent(new Event('selectionchange'))
    })

    expect(foregroundComposer).toHaveFocus()
    expect(foregroundComposer.contains(window.getSelection()?.anchorNode ?? null)).toBe(true)
    expect(window.getSelection()?.anchorOffset).toBe(5)

    rerender(renderComposers('background initial value'))

    await waitFor(() => {
      expect(foregroundComposer).toHaveFocus()
      expect(foregroundComposer.contains(window.getSelection()?.anchorNode ?? null)).toBe(true)
      expect(window.getSelection()?.anchorOffset).toBe(5)
    })

    rerender(renderComposers('background update'))

    await waitFor(() => {
      expect(foregroundComposer).toHaveFocus()
      expect(foregroundComposer.contains(window.getSelection()?.anchorNode ?? null)).toBe(true)
      expect(window.getSelection()?.anchorOffset).toBe(5)
    })
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
    expect(screen.getByTestId('plan-mode-pill-icon')).toHaveClass('h-4')
    expect(screen.getByTestId('cancel-plan-mode-button')).toHaveClass('absolute')
    expect(screen.getByTestId('cancel-plan-mode-button')).toHaveClass('left-2')
    expect(screen.getByTestId('plan-mode-pill-icon')).toHaveClass('group-hover:opacity-0')

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

  test('shows desktop send button for a draft while the assistant is streaming', async () => {
    const onSubmit = vi.fn()

    render(
      <ChatInput
        value="继续修复"
        onChange={vi.fn()}
        onSubmit={onSubmit}
        disabled={false}
        variant="desktop"
        isStreaming
      />
    )

    expect(screen.getByTestId('send-message-button')).toBeEnabled()
    expect(screen.queryByTestId('pause-response-button')).not.toBeInTheDocument()

    await userEvent.click(screen.getByTestId('send-message-button'))

    expect(onSubmit).toHaveBeenCalledWith('继续修复')
  })

  test('offers interrupt-and-send while the assistant is streaming', async () => {
    const onSubmit = vi.fn()

    render(
      <ChatInput
        value="立即改方向"
        onChange={vi.fn()}
        onSubmit={onSubmit}
        disabled={false}
        variant="desktop"
        isStreaming
      />
    )

    const menuButton = screen.getByTestId('send-mode-menu-button')
    expect(menuButton).toHaveAttribute('title', '选择发送方式')
    expect(menuButton.querySelector('.lucide-chevron-down')).toBeInTheDocument()

    await userEvent.click(menuButton)
    expect(
      screen.getByTestId('send-after-turn-option').querySelector('.lucide-clock-3')
    ).toBeInTheDocument()
    await userEvent.click(screen.getByTestId('interrupt-and-send-option'))

    expect(onSubmit).toHaveBeenCalledWith('立即改方向', { interruptWhenBusy: true })
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
    const onInterruptAndSendQueuedMessage = vi.fn()
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
        onInterruptAndSendQueuedMessage={onInterruptAndSendQueuedMessage}
        onCancelQueuedMessage={onCancelQueuedMessage}
        onEditQueuedMessage={onEditQueuedMessage}
      />
    )

    expect(screen.getByTestId('conversation-queue-panel')).toBeInTheDocument()
    expect(screen.getByText('继续检查 capability sync')).toBeInTheDocument()
    expect(screen.getByText('先跳过 device:sync_capabilities')).toBeInTheDocument()
    expect(
      screen.getAllByTestId(/^conversation-queue-row-/).map(row => row.getAttribute('data-testid'))
    ).toEqual(['conversation-queue-row-guidance-1', 'conversation-queue-row-queued-1'])

    await userEvent.click(screen.getByTestId('queue-guidance-button-queued-1'))
    await userEvent.click(screen.getByTestId('queue-interrupt-button-guidance-1'))
    await userEvent.click(screen.getByTestId('queue-interrupt-button-queued-1'))
    await userEvent.click(screen.getByTestId('queue-more-button-queued-1'))
    await userEvent.click(screen.getByTestId('queue-edit-button-queued-1'))
    await userEvent.click(screen.getByTestId('queue-cancel-button-queued-1'))

    expect(onSendQueuedAsGuidance).toHaveBeenCalledWith('queued-1')
    expect(onInterruptAndSendQueuedMessage).toHaveBeenNthCalledWith(1, 'guidance-1')
    expect(onInterruptAndSendQueuedMessage).toHaveBeenNthCalledWith(2, 'queued-1')
    expect(onEditQueuedMessage).toHaveBeenCalledWith('queued-1')
    expect(onCancelQueuedMessage).toHaveBeenCalledWith('queued-1')
  })

  test('shows lightweight interrupt action while guidance is sending', async () => {
    const onInterruptAndSendQueuedMessage = vi.fn()

    render(
      <ChatInput
        value=""
        onChange={vi.fn()}
        onSubmit={vi.fn()}
        disabled={false}
        variant="desktop"
        queuedMessages={[
          {
            id: 'sending-guidance',
            content: '请停止等待并检查目录',
            status: 'sending',
            notice: '正在引导当前对话',
            createdAt: '2026-05-25T15:08:00.000+08:00',
          },
        ]}
        onInterruptAndSendQueuedMessage={onInterruptAndSendQueuedMessage}
      />
    )

    const interruptButton = screen.getByTestId('queue-interrupt-button-sending-guidance')
    expect(screen.getByText('引导中')).toBeInTheDocument()
    expect(interruptButton).toHaveTextContent('workbench.interrupt_and_send_short')
    expect(interruptButton).toHaveClass('text-text-secondary', 'hover:bg-muted')
    expect(interruptButton).not.toHaveClass('border', 'bg-base', 'shadow-sm')
    expect(screen.queryByTestId('queue-guidance-button-sending-guidance')).not.toBeInTheDocument()
    expect(screen.queryByTestId('queue-cancel-button-sending-guidance')).not.toBeInTheDocument()
    expect(screen.queryByTestId('queue-more-button-sending-guidance')).not.toBeInTheDocument()

    await userEvent.click(interruptButton)

    expect(onInterruptAndSendQueuedMessage).toHaveBeenCalledWith('sending-guidance')
  })

  test('provides left-side drag handles to reorder multiple queued messages', () => {
    const queuedMessages: QueuedWorkbenchMessage[] = [
      {
        id: 'queued-first',
        content: '先执行检查',
        status: 'queued',
        createdAt: '2026-05-25T15:08:00.000+08:00',
      },
      {
        id: 'queued-second',
        content: '再执行修复',
        status: 'queued',
        createdAt: '2026-05-25T15:09:00.000+08:00',
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

    expect(screen.getByTestId('queue-drag-handle-queued-first')).toHaveAttribute(
      'aria-label',
      '拖拽调整消息顺序'
    )
    expect(screen.getByTestId('queue-drag-handle-queued-second')).toHaveAttribute(
      'aria-label',
      '拖拽调整消息顺序'
    )
  })

  test('shows active queued guidance before messages waiting to send', () => {
    render(
      <ChatInput
        value=""
        onChange={vi.fn()}
        onSubmit={vi.fn()}
        disabled={false}
        variant="desktop"
        queuedMessages={[
          {
            id: 'queued-waiting',
            content: '看磁盘',
            status: 'queued',
            createdAt: '2026-05-25T15:08:00.000+08:00',
          },
          {
            id: 'queued-guidance',
            content: '看 cpu',
            status: 'sending',
            notice: '正在引导当前对话',
            createdAt: '2026-05-25T15:09:00.000+08:00',
          },
        ]}
        guidanceMessages={[]}
      />
    )

    expect(
      screen.getAllByTestId(/^conversation-queue-row-/).map(row => row.getAttribute('data-testid'))
    ).toEqual(['conversation-queue-row-queued-guidance', 'conversation-queue-row-queued-waiting'])
  })

  test('shows a control to resume a paused queue', async () => {
    const onResumeQueue = vi.fn()

    render(
      <ChatInput
        value=""
        onChange={vi.fn()}
        onSubmit={vi.fn()}
        disabled={false}
        variant="desktop"
        queuedMessages={[
          {
            id: 'queued-paused',
            content: '等待发送',
            status: 'queued',
            createdAt: '2026-05-25T15:08:00.000+08:00',
          },
        ]}
        guidanceMessages={[]}
        queuePaused
        onResumeQueue={onResumeQueue}
      />
    )

    await userEvent.click(screen.getByTestId('resume-queue-button'))

    expect(onResumeQueue).toHaveBeenCalledTimes(1)
  })

  test('asks whether to preserve a paused queue before sending a new message', async () => {
    const onSubmit = vi.fn()
    const onResumeQueue = vi.fn()
    const onChange = vi.fn()
    const onResumeQueueWithInput = vi.fn()

    render(
      <ChatInput
        value="发送新消息"
        onChange={onChange}
        onSubmit={onSubmit}
        disabled={false}
        queuedMessages={[
          {
            id: 'queued-paused-send',
            content: '等待发送',
            status: 'queued',
            createdAt: '2026-05-25T15:08:00.000+08:00',
          },
        ]}
        guidanceMessages={[]}
        queuePaused
        onResumeQueue={onResumeQueue}
        onResumeQueueWithInput={onResumeQueueWithInput}
      />
    )

    await userEvent.click(screen.getByTestId('send-message-button'))

    expect(screen.getByTestId('paused-queue-send-dialog')).toBeInTheDocument()
    expect(onSubmit).not.toHaveBeenCalled()

    await userEvent.click(screen.getByTestId('paused-queue-send-preserve-button'))

    expect(onSubmit).not.toHaveBeenCalled()
    expect(onResumeQueueWithInput).toHaveBeenCalled()
    expect(onChange).toHaveBeenCalledWith('')
  })

  test('hides drag handles when fewer than two messages are queued', () => {
    render(
      <ChatInput
        value=""
        onChange={vi.fn()}
        onSubmit={vi.fn()}
        disabled={false}
        variant="desktop"
        queuedMessages={[
          {
            id: 'queued-only',
            content: '执行检查',
            status: 'queued',
            createdAt: '2026-05-25T15:08:00.000+08:00',
          },
        ]}
        guidanceMessages={[]}
      />
    )

    expect(screen.queryByTestId('queue-drag-handle-queued-only')).not.toBeInTheDocument()
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
      'text-chat',
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

  test('shows compact send button for a draft while the assistant is streaming', async () => {
    const onSubmit = vi.fn()

    render(
      <ChatInput
        value="继续修复"
        onChange={vi.fn()}
        onSubmit={onSubmit}
        disabled={false}
        isStreaming
      />
    )

    expect(screen.getByTestId('send-message-button')).toBeEnabled()
    expect(screen.queryByTestId('pause-response-button')).not.toBeInTheDocument()
    expect(screen.getByTestId('compact-input-pill')).toHaveClass('pr-[92px]')

    await userEvent.click(screen.getByTestId('send-message-button'))

    expect(onSubmit).toHaveBeenCalledWith('继续修复')
  })

  test('does not render voice input in the compact composer', async () => {
    render(<ControlledChatInput />)

    expect(screen.queryByTestId('voice-input-button')).not.toBeInTheDocument()
    await userEvent.type(screen.getByTestId('chat-message-input'), 'hello')

    expect(screen.queryByTestId('voice-input-button')).not.toBeInTheDocument()
    expect(screen.getByTestId('compact-input-pill')).toHaveClass('pr-14')
    expect(screen.getByTestId('send-message-button')).toHaveClass('bottom-1', 'right-1')
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

  test('renders desktop context usage indicator with compact action when usage is available', async () => {
    const onSubmit = vi.fn()
    const onCompactContext = vi.fn()

    render(
      <ChatInput
        value=""
        onChange={vi.fn()}
        onSubmit={onSubmit}
        onCompactContext={onCompactContext}
        disabled={false}
        variant="desktop"
        projectChat={projectChatControls({
          contextUsage: {
            total: {
              totalTokens: 15_000,
              inputTokens: 12_000,
              cachedInputTokens: 2_000,
              outputTokens: 3_000,
              reasoningOutputTokens: 0,
            },
            last: {
              totalTokens: 8_000,
              inputTokens: 7_000,
              cachedInputTokens: 1_000,
              outputTokens: 1_000,
              reasoningOutputTokens: 0,
            },
            modelContextWindow: 258_000,
          },
        })}
      />
    )

    expect(screen.getByTestId('context-usage-indicator')).toBeInTheDocument()
    expect(screen.getByTestId('context-usage-indicator')).toHaveAttribute(
      'aria-label',
      'workbench.context_usage_aria'
    )

    await userEvent.click(screen.getByTestId('context-usage-button'))

    expect(screen.getByTestId('confirm-compact-context-button')).toHaveTextContent('压缩')

    await userEvent.click(screen.getByTestId('confirm-compact-context-button'))

    expect(onCompactContext).toHaveBeenCalledTimes(1)
    expect(onSubmit).not.toHaveBeenCalled()
    expect(screen.queryByTestId('confirm-compact-context-button')).not.toBeInTheDocument()
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
    const cloudModel: UnifiedModel = {
      ...model,
      name: 'cloud:user:cloud-gpt-5.5',
      displayName: '云端:gpt-5.5',
      config: {
        ...model.config,
        weworkExecution: {
          source: 'cloud',
          modelName: 'cloud-gpt-5.5',
          modelType: 'user',
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
          models: [model, cloudModel],
          selectedModel: model,
          selectedModelOptions: { reasoning: 'high', speed: 'standard' },
          setSelectedModel,
        })}
      />
    )

    const selectorButton = screen.getByTestId('model-selector-button')
    expect(selectorButton).toHaveClass(
      'transition-[width,background-color,color,opacity]',
      'duration-200'
    )
    expect(screen.getByTestId('model-selector-tooltip')).toHaveTextContent('选择模型')
    expect(screen.getByTestId('model-selector-tooltip')).toHaveTextContent('⌃⇧M')
    expect(screen.getByTestId('model-selector-tooltip')).toHaveClass('h-9')
    expect(screen.getByTestId('model-selector-tooltip')).toHaveClass(
      'group-hover/model-selector:opacity-100',
      'group-hover/model-selector:delay-[1500ms]'
    )
    expect(screen.getByTestId('model-selector-tooltip')).not.toHaveClass(
      'group-focus-within/model-selector:delay-0'
    )

    await userEvent.click(selectorButton)

    expect(screen.getByTestId('model-selector-menu')).toBeInTheDocument()
    expect(screen.getByTestId('model-selector-menu')).toHaveAttribute(
      'data-enter-animation',
      'main'
    )
    expect(selectorButton).toHaveStyle({ width: '240px' })
    expect(screen.queryByTestId('model-selector-tooltip')).not.toBeInTheDocument()
    expect(screen.getByTestId('model-selector-menu').parentElement).toHaveClass(
      'fixed',
      'z-system-popover',
      'w-64'
    )
    expect(screen.getByTestId('model-selector-menu').parentElement?.parentElement).toBe(
      document.body
    )
    expect(screen.queryByTestId('model-selector-submenu')).not.toBeInTheDocument()
    expect(screen.getByTestId('model-control-menu-model')).toBeInTheDocument()
    expect(screen.getByTestId('model-control-menu-reasoning')).toBeInTheDocument()
    expect(screen.getByTestId('model-control-menu-speed')).toBeInTheDocument()
    expect(screen.getByTestId('model-reset-default-button')).toBeDisabled()
    expect(screen.queryByTestId('model-advanced-intelligence-icon')).not.toBeInTheDocument()
    expect(screen.queryByTestId('model-control-reasoning-slider')).not.toBeInTheDocument()
    expect(screen.queryByTestId('model-control-reasoning-high')).not.toBeInTheDocument()
    expect(screen.queryByTestId('model-control-collaborationMode-default')).not.toBeInTheDocument()
    expect(screen.queryByTestId('model-control-collaborationMode-plan')).not.toBeInTheDocument()
    expect(screen.queryByTestId('model-control-speed-fast')).not.toBeInTheDocument()
    expect(screen.queryByTestId('model-option-default')).not.toBeInTheDocument()
    expect(screen.getByTestId('model-selector-button')).toHaveTextContent('海外:gpt-5.5 High')
    await userEvent.hover(screen.getByTestId('model-control-menu-model'))

    expect(screen.getByTestId('model-selector-submenu')).toHaveAttribute(
      'data-enter-animation',
      'submenu'
    )
    expect(screen.getByTestId('model-selector-submenu')).toHaveStyle({ left: '256px' })
    const modelOption = screen.getByTestId('model-option-overseas-gpt-5.5')
    expect(modelOption).toHaveTextContent('海外:gpt-5.5')
    expect(modelOption).not.toHaveTextContent('High')
    expect(modelOption.querySelectorAll('span')).toHaveLength(1)
    expect(screen.getByTestId('model-option-cloud:user:cloud-gpt-5.5')).toHaveAccessibleName(/云端/)
    expect(
      screen
        .getByTestId('model-control-menu-model')
        .compareDocumentPosition(screen.getByTestId('model-control-menu-reasoning')) &
        Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy()
    expect(
      screen
        .getByTestId('model-control-menu-speed')
        .compareDocumentPosition(screen.getByTestId('model-reset-default-button')) &
        Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy()

    await userEvent.click(screen.getByTestId('model-option-overseas-gpt-5.5'))

    expect(setSelectedModel).toHaveBeenCalledWith(model)
    expect(screen.getByTestId('model-selector-menu')).toBeInTheDocument()

    await userEvent.hover(screen.getByTestId('model-control-menu-reasoning'))

    expect(screen.getByTestId('model-control-reasoning-high')).toBeInTheDocument()
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

    const speedMenuItem = screen.getByTestId('model-control-menu-speed')
    const resetRow = screen.getByTestId('model-reset-default-row')
    const resetButton = screen.getByTestId('model-reset-default-button')
    expect(speedMenuItem).toHaveClass('bg-muted')
    expect(resetButton).toHaveClass('text-text-muted', 'hover:bg-muted', 'hover:text-text-primary')
    expect(resetRow).not.toHaveClass('bg-muted', 'hover:bg-muted')
    expect(resetButton.querySelector('.lucide-rotate-ccw')).toBeInTheDocument()
    expect(screen.queryByTestId('model-advanced-intelligence-icon')).not.toBeInTheDocument()

    await userEvent.hover(resetRow)

    expect(screen.queryByTestId('model-selector-submenu')).not.toBeInTheDocument()
    expect(speedMenuItem).not.toHaveClass('bg-muted')

    await userEvent.hover(speedMenuItem)

    await userEvent.click(screen.getByTestId('model-control-speed-fast'))

    expect(setSelectedModelOption).toHaveBeenCalledWith('speed', 'fast')
    expect(screen.getByTestId('model-selector-menu')).toBeInTheDocument()
  })

  test('shows an empty state when no desktop models are available', async () => {
    render(
      <ChatInput
        value=""
        onChange={vi.fn()}
        onSubmit={vi.fn()}
        disabled={false}
        variant="desktop"
        projectChat={projectChatControls({ models: [], selectedModel: null })}
      />
    )

    expect(screen.getByTestId('model-selector-button')).toHaveTextContent('Default')
    await userEvent.click(screen.getByTestId('model-selector-button'))
    expect(screen.queryByTestId('model-selector-submenu')).not.toBeInTheDocument()
    await userEvent.hover(screen.getByTestId('model-control-menu-model'))

    expect(screen.getByTestId('model-selector-submenu')).toHaveTextContent('No models available')
  })

  test('closes the desktop model menu only from its trigger, outside click, or Escape', async () => {
    const model: UnifiedModel = {
      name: 'codex-gpt-5.5',
      type: 'user',
      displayName: 'Codex:gpt-5.5',
      config: { ui: { family: 'gpt', modelLabel: 'gpt-5.5', sortOrder: 10 } },
    }
    render(
      <ChatInput
        value=""
        onChange={vi.fn()}
        onSubmit={vi.fn()}
        disabled={false}
        variant="desktop"
        projectChat={projectChatControls({ models: [model], selectedModel: model })}
      />
    )

    const trigger = screen.getByTestId('model-selector-button')
    await userEvent.click(trigger)
    expect(screen.getByTestId('model-selector-menu')).toBeInTheDocument()

    fireEvent.pointerDown(document.body)
    expect(screen.queryByTestId('model-selector-menu')).not.toBeInTheDocument()

    await userEvent.click(trigger)
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByTestId('model-selector-menu')).not.toBeInTheDocument()

    await userEvent.click(trigger)
    await userEvent.click(trigger)
    expect(screen.queryByTestId('model-selector-menu')).not.toBeInTheDocument()
  })

  test('drags the desktop reasoning slider to select the nearest option', async () => {
    const model: UnifiedModel = {
      name: 'gpt-5.6-sol',
      type: 'runtime',
      displayName: 'GPT 5.6 Sol',
      config: {
        ui: {
          family: 'codex-official',
          modelLabel: 'GPT 5.6 Sol',
          sortOrder: 10,
          reasoningEfforts: ['low', 'medium', 'high', 'xhigh'],
          defaultReasoningEffort: 'medium',
          controls: ['speed'],
        },
      },
    }
    const setSelectedModelOption = vi.fn()
    const originalGetBoundingClientRect = HTMLElement.prototype.getBoundingClientRect
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(
      function getMockRect(this: HTMLElement) {
        if (this.getAttribute('data-testid') === 'model-control-reasoning-track') {
          return { left: 100, right: 400, top: 0, bottom: 32, width: 300, height: 32 } as DOMRect
        }

        return originalGetBoundingClientRect.call(this)
      }
    )

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
            selectedModelOptions: { reasoning: 'high' },
            setSelectedModelOption,
          })}
        />
      )

      await userEvent.click(screen.getByTestId('model-selector-button'))
      await userEvent.click(screen.getByTestId('model-advanced-toggle'))

      const track = screen.getByTestId('model-control-reasoning-track')
      fireEvent.pointerDown(track, { button: 0, clientX: 388, pointerId: 1 })
      fireEvent.pointerMove(track, { buttons: 1, clientX: 112, pointerId: 1 })

      expect(screen.getByTestId('model-selector-menu')).toBeInTheDocument()

      fireEvent.pointerUp(track, { button: 0, clientX: 112, pointerId: 1 })

      expect(setSelectedModelOption).toHaveBeenLastCalledWith('reasoning', 'low')
      expect(screen.getByTestId('model-selector-menu')).toBeInTheDocument()

      fireEvent.keyDown(track, { key: 'ArrowLeft' })
      expect(setSelectedModelOption).toHaveBeenLastCalledWith('reasoning', 'medium')
      fireEvent.keyDown(track, { key: 'End' })
      expect(setSelectedModelOption).toHaveBeenLastCalledWith('reasoning', 'xhigh')
    } finally {
      vi.restoreAllMocks()
    }
  })

  test('renders the advertised ultra effort with purple summary and slider treatment', async () => {
    const model: UnifiedModel = {
      name: 'gpt-5.6-sol',
      type: 'runtime',
      displayName: 'GPT 5.6 Sol',
      config: {
        ui: {
          family: 'codex-official',
          modelLabel: 'GPT 5.6 Sol',
          reasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
          defaultReasoningEffort: 'low',
          controls: ['speed'],
        },
      },
    }
    const terraModel: UnifiedModel = {
      name: 'gpt-5.6-terra',
      type: 'runtime',
      displayName: 'GPT 5.6 Terra',
      config: {
        ui: {
          family: 'codex-official',
          modelLabel: 'GPT 5.6 Terra',
          reasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
          defaultReasoningEffort: 'low',
          controls: ['speed'],
        },
      },
    }
    const setSelectedModelAndOptions = vi.fn()
    const setSelectedModelOption = vi.fn()

    render(
      <ChatInput
        value=""
        onChange={vi.fn()}
        onSubmit={vi.fn()}
        disabled={false}
        variant="desktop"
        projectChat={projectChatControls({
          models: [model, terraModel],
          selectedModel: model,
          selectedModelOptions: { reasoning: 'ultra', speed: 'standard' },
          setSelectedModelAndOptions,
          setSelectedModelOption,
        })}
      />
    )

    const trigger = screen.getByTestId('model-selector-button')
    expect(trigger).toHaveTextContent('GPT 5.6 Sol Extra High')
    expect(trigger.querySelector('.text-reasoning-ultra-text')).toHaveTextContent('Extra High')

    await userEvent.click(trigger)
    await userEvent.hover(screen.getByTestId('model-control-menu-reasoning'))

    expect(screen.queryByTestId('model-control-reasoning-max')).not.toBeInTheDocument()
    expect(screen.getByTestId('model-control-reasoning-ultra')).toHaveTextContent(
      'Faster, uses more quota'
    )
    expect(
      within(screen.getByTestId('model-selector-submenu')).getAllByText('Extra High')
    ).toHaveLength(2)

    await userEvent.click(screen.getByTestId('model-advanced-toggle'))

    expect(screen.getByTestId('model-advanced-panel')).toHaveAttribute(
      'data-enter-animation',
      'advanced'
    )
    expect(screen.queryByTestId('model-control-menu-model')).not.toBeInTheDocument()
    expect(screen.queryByTestId('model-control-menu-reasoning')).not.toBeInTheDocument()
    expect(screen.queryByTestId('model-control-menu-speed')).not.toBeInTheDocument()
    expect(screen.queryByTestId('reasoning-slider-faster-label')).not.toBeInTheDocument()
    expect(screen.queryByTestId('reasoning-slider-smarter-label')).not.toBeInTheDocument()
    expect(screen.getByTestId('model-control-reasoning-slider')).toHaveClass('h-14')
    expect(
      screen.getByTestId('model-advanced-toggle').querySelector('.lucide-chevron-right')
    ).toBeInTheDocument()
    const fastModeToggle = screen.getByTestId('model-advanced-fast-mode-toggle')
    expect(fastModeToggle).toHaveAttribute('aria-pressed', 'false')
    await userEvent.click(fastModeToggle)
    expect(setSelectedModelOption).toHaveBeenCalledWith('speed', 'fast')
    expect(screen.getByTestId('model-advanced-panel')).toBeInTheDocument()
    expect(screen.getByTestId('model-control-reasoning-progress')).toHaveAttribute(
      'data-ultra',
      'true'
    )
    expect(screen.getByTestId('model-control-reasoning-progress')).toHaveClass(
      'from-reasoning-ultra-start',
      'to-reasoning-ultra-end'
    )
    expect(screen.getByTestId('reasoning-ultra-burst')).toBeInTheDocument()
    const sparkles = screen
      .getByTestId('model-control-reasoning-progress')
      .querySelectorAll('[data-sparkle-index]')
    expect(sparkles).toHaveLength(10)
    expect(sparkles[1]).toHaveStyle({ animationDelay: '-260ms' })
    const powerSettings = [
      'gpt-5-6-terra-low',
      'gpt-5-6-sol-low',
      'gpt-5-6-sol-medium',
      'gpt-5-6-sol-high',
      'gpt-5-6-sol-xhigh',
      'gpt-5-6-sol-ultra',
    ]
    powerSettings.forEach(setting => {
      expect(screen.getByTestId(`model-power-setting-${setting}`)).toBeInTheDocument()
    })
    expect(screen.queryByTestId('model-power-setting-gpt-5-6-sol-max')).not.toBeInTheDocument()
    const solLowSetting = screen.getByTestId('model-power-setting-gpt-5-6-sol-low')
    expect(solLowSetting).not.toHaveAttribute('title')
    expect(screen.queryByText('GPT 5.6 Sol Low')).not.toBeInTheDocument()

    fireEvent.pointerDown(solLowSetting, { button: 0, clientX: 160, pointerId: 9 })
    expect(screen.getByTestId('model-control-reasoning-slider')).toHaveAttribute(
      'data-interacting',
      'true'
    )
    expect(screen.queryByTestId('model-advanced-toggle')).not.toBeInTheDocument()
    expect(screen.queryByTestId('model-advanced-intelligence-icon')).not.toBeInTheDocument()
    expect(screen.getByTestId('reasoning-slider-faster-label')).toHaveTextContent('Faster')
    expect(screen.getByTestId('reasoning-slider-smarter-label')).toHaveTextContent('Smarter')
    fireEvent.pointerUp(solLowSetting, { button: 0, clientX: 160, pointerId: 9 })
    expect(screen.getByTestId('model-control-reasoning-slider')).toHaveAttribute(
      'data-interacting',
      'false'
    )
    expect(screen.getByTestId('model-advanced-toggle')).toBeInTheDocument()
    expect(screen.getByTestId('model-advanced-intelligence-icon')).toBeInTheDocument()
    expect(screen.queryByTestId('reasoning-slider-faster-label')).not.toBeInTheDocument()

    await userEvent.click(screen.getByTestId('model-power-setting-gpt-5-6-terra-low'))
    expect(setSelectedModelAndOptions).toHaveBeenCalledWith(terraModel, {
      reasoning: 'low',
      speed: 'standard',
    })
    expect(screen.getByTestId('model-selector-menu')).toBeInTheDocument()

    await userEvent.click(screen.getByTestId('model-advanced-toggle'))
    expect(screen.queryByTestId('model-advanced-panel')).not.toBeInTheDocument()
    expect(screen.getByTestId('model-control-menu-model')).toBeInTheDocument()
    expect(screen.getByTestId('model-control-menu-reasoning')).toBeInTheDocument()
    expect(screen.getByTestId('model-control-menu-speed')).toBeInTheDocument()
    expect(
      screen.getByTestId('model-advanced-toggle').querySelector('.lucide-chevron-up')
    ).toBeInTheDocument()
    expect(screen.queryByTestId('model-advanced-fast-mode-toggle')).not.toBeInTheDocument()
  })

  test('persists the desktop power view across close, reopen, and a new composer mount', async () => {
    const model: UnifiedModel = {
      name: 'gpt-5.6-sol',
      type: 'runtime',
      displayName: 'GPT 5.6 Sol',
      config: {
        ui: {
          family: 'codex-official',
          modelLabel: 'GPT 5.6 Sol',
          reasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'ultra'],
          defaultReasoningEffort: 'medium',
          controls: ['speed'],
        },
      },
    }
    const props = {
      value: '',
      onChange: vi.fn(),
      onSubmit: vi.fn(),
      disabled: false,
      variant: 'desktop' as const,
      projectChat: projectChatControls({
        models: [model],
        selectedModel: model,
        selectedModelOptions: { reasoning: 'medium', speed: 'standard' },
      }),
    }
    const firstRender = render(<ChatInput {...props} />)

    await userEvent.click(screen.getByTestId('model-selector-button'))
    await userEvent.click(screen.getByTestId('model-advanced-toggle'))
    expect(screen.getByTestId('model-advanced-panel')).toBeInTheDocument()
    expect(localStorage.getItem('wework:model-selector-view')).toBe('power')

    await userEvent.click(screen.getByTestId('model-selector-button'))
    expect(screen.queryByTestId('model-selector-menu')).not.toBeInTheDocument()
    await userEvent.click(screen.getByTestId('model-selector-button'))
    expect(screen.getByTestId('model-advanced-panel')).toBeInTheDocument()

    firstRender.unmount()
    render(<ChatInput {...props} />)
    await userEvent.click(screen.getByTestId('model-selector-button'))

    expect(screen.getByTestId('model-advanced-panel')).toBeInTheDocument()
  })

  test('offers a Sol medium reset when another model is selected without losing view preference', async () => {
    localStorage.setItem('wework:model-selector-view', 'power')
    const solModel: UnifiedModel = {
      name: 'gpt-5.6-sol',
      type: 'runtime',
      displayName: 'GPT 5.6 Sol',
      config: {
        ui: {
          family: 'codex-official',
          modelLabel: 'GPT 5.6 Sol',
          reasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'ultra'],
          defaultReasoningEffort: 'medium',
          controls: ['speed'],
        },
      },
    }
    const terraModel: UnifiedModel = {
      name: 'gpt-5.6-terra',
      type: 'runtime',
      displayName: 'GPT 5.6 Terra',
      config: {
        ui: {
          family: 'codex-official',
          modelLabel: 'GPT 5.6 Terra',
          reasoningEfforts: ['low', 'medium', 'high', 'xhigh'],
          defaultReasoningEffort: 'low',
          controls: ['speed'],
        },
      },
    }
    const setSelectedModelAndOptions = vi.fn()
    render(
      <ChatInput
        value=""
        onChange={vi.fn()}
        onSubmit={vi.fn()}
        disabled={false}
        variant="desktop"
        projectChat={projectChatControls({
          models: [solModel, terraModel],
          selectedModel: terraModel,
          selectedModelOptions: { reasoning: 'xhigh', speed: 'fast' },
          setSelectedModelAndOptions,
        })}
      />
    )

    await userEvent.click(screen.getByTestId('model-selector-button'))

    expect(screen.getByTestId('model-control-menu-model')).toBeInTheDocument()
    expect(screen.queryByTestId('model-advanced-toggle')).not.toBeInTheDocument()
    expect(screen.queryByTestId('model-advanced-panel')).not.toBeInTheDocument()
    expect(screen.getByTestId('model-reset-default-button')).toHaveTextContent('重置为默认设置')

    await userEvent.click(screen.getByTestId('model-reset-default-button'))

    expect(setSelectedModelAndOptions).toHaveBeenCalledWith(solModel, {
      reasoning: 'medium',
      speed: 'standard',
    })
    expect(screen.getByTestId('model-selector-menu')).toBeInTheDocument()
    expect(localStorage.getItem('wework:model-selector-view')).toBe('power')
  })

  test('keeps Advanced available for the Terra light setting shown on the power slider', async () => {
    const solModel: UnifiedModel = {
      name: 'gpt-5.6-sol',
      type: 'runtime',
      displayName: 'GPT 5.6 Sol',
      config: {
        ui: {
          family: 'codex-official',
          modelLabel: 'GPT 5.6 Sol',
          reasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'ultra'],
          defaultReasoningEffort: 'medium',
          controls: ['speed'],
        },
      },
    }
    const terraModel: UnifiedModel = {
      name: 'gpt-5.6-terra',
      type: 'runtime',
      displayName: 'GPT 5.6 Terra',
      config: {
        ui: {
          family: 'codex-official',
          modelLabel: 'GPT 5.6 Terra',
          reasoningEfforts: ['low', 'medium', 'high', 'xhigh'],
          defaultReasoningEffort: 'low',
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
          models: [solModel, terraModel],
          selectedModel: terraModel,
          selectedModelOptions: { reasoning: 'low', speed: 'standard' },
        })}
      />
    )

    await userEvent.click(screen.getByTestId('model-selector-button'))

    expect(screen.getByTestId('model-advanced-toggle')).toBeInTheDocument()
    expect(screen.queryByTestId('model-reset-default-button')).not.toBeInTheDocument()
  })

  test('suppresses the model tooltip after closing until the pointer re-enters', async () => {
    render(
      <ChatInput
        value=""
        onChange={vi.fn()}
        onSubmit={vi.fn()}
        disabled={false}
        variant="desktop"
        projectChat={projectChatControls()}
      />
    )
    const trigger = screen.getByTestId('model-selector-button')

    await userEvent.click(trigger)
    await userEvent.click(trigger)

    expect(screen.queryByTestId('model-selector-tooltip')).not.toBeInTheDocument()

    await userEvent.unhover(trigger)
    await userEvent.hover(trigger)

    expect(screen.getByTestId('model-selector-tooltip')).toBeInTheDocument()
  })

  test('keeps the desktop model submenu open after the pointer leaves the menu', async () => {
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
    await userEvent.hover(screen.getByTestId('model-control-menu-model'))

    expect(screen.getByTestId('model-selector-submenu')).toBeInTheDocument()

    fireEvent.mouseLeave(screen.getByTestId('model-selector-menu').parentElement as HTMLElement)

    expect(screen.getByTestId('model-selector-submenu')).toBeInTheDocument()
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
    expect(screen.queryByTestId('model-selector-submenu')).not.toBeInTheDocument()
    await userEvent.hover(screen.getByTestId('model-control-menu-model'))
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

  test('keeps the desktop model menu open after selecting a model opened by external signal', async () => {
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
    await userEvent.hover(screen.getByTestId('model-control-menu-model'))

    await userEvent.click(screen.getByTestId('model-option-ali-qwen3-coder-plus'))

    expect(setSelectedModel).toHaveBeenCalledWith(model)
    expect(screen.getByTestId('model-selector-menu')).toBeInTheDocument()
  })

  test('keeps the desktop model submenu inside the viewport near the bottom edge', async () => {
    const originalInnerHeight = window.innerHeight
    Object.defineProperty(window, 'innerHeight', {
      configurable: true,
      value: 1000,
    })
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(
      function getMockRect(this: HTMLElement) {
        const testId = this.getAttribute('data-testid')
        if (testId === 'model-selector-menu') {
          return {
            top: 760,
            bottom: 900,
            left: 480,
            right: 736,
            width: 256,
            height: 140,
          } as DOMRect
        }
        if (testId === 'model-control-menu-model') {
          return {
            top: 780,
            bottom: 812,
            left: 492,
            right: 724,
            width: 232,
            height: 32,
          } as DOMRect
        }
        if (testId === 'model-selector-submenu') {
          return {
            top: 0,
            bottom: 192,
            left: 0,
            right: 288,
            width: 288,
            height: 192,
          } as DOMRect
        }
        return {
          top: 0,
          bottom: 0,
          left: 0,
          right: 0,
          width: 0,
          height: 0,
        } as DOMRect
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
      await userEvent.hover(screen.getByTestId('model-control-menu-model'))

      await waitFor(() => {
        expect(screen.getByTestId('model-selector-submenu')).toHaveStyle({
          top: '20px',
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
    await userEvent.hover(screen.getByTestId('model-control-menu-model'))

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

  test('keeps the model menu open after selecting a reasoning option', async () => {
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
    await userEvent.hover(screen.getByTestId('model-control-menu-reasoning'))
    await userEvent.click(screen.getByTestId('model-control-reasoning-medium'))

    expect(setSelectedModelOption).toHaveBeenCalledWith('reasoning', 'medium')
    expect(screen.getByTestId('model-selector-menu')).toBeInTheDocument()
    expect(screen.getByTestId('model-control-reasoning-medium')).toBeInTheDocument()
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

  test('flattens model families while keeping controls from the selected GPT model', async () => {
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
    await userEvent.hover(screen.getByTestId('model-control-menu-model'))

    expect(screen.getByTestId('model-option-claude-opus')).toBeInTheDocument()
    expect(screen.getByTestId('model-option-overseas-gpt-5.5')).toBeInTheDocument()
    await userEvent.hover(screen.getByTestId('model-control-menu-reasoning'))
    expect(screen.getByTestId('model-control-reasoning-high')).toBeInTheDocument()
    expect(screen.queryByTestId('model-control-reasoning-auto')).not.toBeInTheDocument()
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

    expect(screen.getByTestId('model-control-menu-speed')).toBeDisabled()
    await userEvent.hover(screen.getByTestId('model-control-menu-reasoning'))
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

  test('shows an active goal as continuing only while a new goal turn is running', () => {
    render(
      <ChatInput
        value=""
        onChange={vi.fn()}
        onSubmit={vi.fn()}
        disabled={false}
        variant="desktop"
        goalContinuing
        goal={{
          threadId: 'thread-1',
          objective: '继续完成测试',
          status: 'active',
          tokenBudget: null,
          tokensUsed: 0,
          timeUsedSeconds: 0,
          createdAt: 1780000000000,
          updatedAt: 1780000000000,
        }}
      />
    )

    expect(screen.getByTestId('goal-status-bar')).toHaveTextContent('目标继续执行中')
    expect(screen.getByTestId('pause-goal-button')).toBeInTheDocument()
  })

  test('offers the resume action for a blocked goal', async () => {
    const onResumeGoal = vi.fn()

    render(
      <ChatInput
        value=""
        onChange={vi.fn()}
        onSubmit={vi.fn()}
        disabled={false}
        variant="desktop"
        goal={{
          threadId: 'thread-1',
          objective: 'Resolve the issue',
          status: 'blocked',
          tokenBudget: null,
          tokensUsed: 0,
          timeUsedSeconds: 0,
          createdAt: 1780000000000,
          updatedAt: 1780000000000,
        }}
        onResumeGoal={onResumeGoal}
      />
    )

    await userEvent.click(screen.getByTestId('resume-goal-button'))

    expect(onResumeGoal).toHaveBeenCalledTimes(1)
  })

  test.each(['usageLimited', 'budgetLimited'] as const)(
    'does not offer the pause action for a %s goal',
    status => {
      render(
        <ChatInput
          value=""
          onChange={vi.fn()}
          onSubmit={vi.fn()}
          disabled={false}
          variant="desktop"
          goal={{
            threadId: 'thread-1',
            objective: 'Resolve the issue',
            status,
            tokenBudget: null,
            tokensUsed: 0,
            timeUsedSeconds: 0,
            createdAt: 1780000000000,
            updatedAt: 1780000000000,
          }}
        />
      )

      expect(screen.queryByTestId('pause-goal-button')).not.toBeInTheDocument()
      expect(screen.queryByTestId('resume-goal-button')).not.toBeInTheDocument()
    }
  )

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
    expect(screen.getByTestId('goal-draft-pill-icon')).toHaveClass('h-4')
    expect(cancelButton).toHaveClass('opacity-0')
    expect(cancelButton).toHaveClass('absolute')
    expect(cancelButton).toHaveClass('left-2')
    expect(cancelButton).toHaveClass('group-hover:opacity-100')
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

  test('renders an Appshot image and its text context as one attachment', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        blob: () => Promise.resolve(new Blob(['image'], { type: 'image/png' })),
      })
    )
    URL.createObjectURL = vi.fn(() => 'blob:appshot-preview')
    const appshot: Attachment = {
      id: -10,
      filename: 'appshot.png',
      file_size: 1200,
      mime_type: 'image/png',
      status: 'ready',
      file_extension: '.png',
      created_at: '2026-07-15T00:00:00.000Z',
      ui_group_id: 'appshot-capture-1',
      ui_group_role: 'primary',
      ui_kind: 'appshot',
    }
    const textContext: Attachment = {
      ...appshot,
      id: -11,
      filename: 'appshot-context.txt',
      mime_type: 'text/plain',
      file_extension: '.txt',
      ui_group_role: 'companion',
    }

    render(
      <ChatInput
        value=""
        onChange={vi.fn()}
        onSubmit={vi.fn()}
        disabled={false}
        variant="desktop"
        projectChat={projectChatControls({ attachments: [appshot, textContext] })}
      />
    )

    expect(screen.getAllByTestId('attachment-badge')).toHaveLength(1)
    expect(screen.getByTestId('attachment-appshot-label')).toHaveTextContent('应用快照')
    expect(screen.queryByTestId('attachment-text-icon')).not.toBeInTheDocument()
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

    expect(screen.getByTestId('project-work-button')).toHaveTextContent('请选择项目')
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

    expect(trigger).toHaveTextContent('请选择项目')
    expect(trigger).not.toHaveTextContent('Local Online')
    expect(trigger).toHaveAccessibleName('请选择项目')
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

    expect(screen.getByTestId('project-work-button')).toHaveTextContent('请选择项目')

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
          isGitProject: true,
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
})
