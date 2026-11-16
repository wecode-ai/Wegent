import * as desktopHost from '@/api/dsh/desktopHost'
import { createCloudModelCatalog } from '@/api/hybrid/cloudModelCatalog'
import { WEWORK_DSH_SLOTS } from '@/features/dsh-runtime/dshUiSlots'
import { useStandInConversationModel } from '@/features/todo/useStandInConversationModel'
import type { WorkbenchServices } from '@/features/workbench/workbenchServices'
import { selectedModelExecutionFields } from '@/features/workbench/runtimeModelSelection'
import {
  cloudRunnerModelIdentity,
  type RunnerModel,
  type WorkspaceStandInSettings,
} from '@wegent/collaboration'
import type { ConversationModelControls } from '@/components/layout/workspace-panels/conversationModelControls'
import { WorkbenchContext } from '@/features/workbench/workbenchContexts'
import type { WorkbenchContextValue } from '@/features/workbench/workbenchContextTypes'
import * as runtimeEnvironment from '@/lib/runtime-environment'
import { SELECTED_TEXT_DRAG_TYPE } from '@/lib/selected-text-drag'
import { WORKSPACE_PATH_DRAG_TYPE } from '@/lib/workspace-path-transfer'
import { installDshUiTestContributions } from '@/test/setup.dom'
import type { Attachment, RuntimeGoal, UnifiedModel } from '@/types/api'
import type { GuidanceWorkbenchMessage, QueuedWorkbenchMessage } from '@/types/workbench'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useComposerAttachments } from '@wegent/collaboration/composer'
import { createRef, useEffect, useState } from 'react'
import { beforeEach, describe, expect, test, vi } from 'vitest'

vi.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => ({
    i18n: { language: 'zh-CN' },
    t: (
      key: string,
      options?:
        | string
        | {
            action?: string
            count?: number
            device?: string
            location?: string
            defaultValue?: string
          },
      interpolation?: { model?: string }
    ) => {
      if (typeof options === 'string') {
        return interpolation?.model ? options.replace('{{model}}', interpolation.model) : options
      }
      if (key === 'workbench.code_comment_count') {
        return `${options?.count ?? 0} 个评论`
      }
      if (key === 'workbench.project_work_trigger_device_aria') {
        return `${options?.action ?? ''}，当前设备 ${options?.device ?? ''}`
      }
      if (key === 'workbench.environment_cloud_device') return '云设备'
      if (key === 'workbench.environment_local') return '本机'
      if (key === 'workbench.remove_code_comments') {
        return '移除代码评论'
      }
      return options?.defaultValue ?? key
    },
  }),
}))

vi.mock('@/desktop/appPreferences', async importOriginal => {
  const actual = await importOriginal<typeof import('@/desktop/appPreferences')>()
  return {
    ...actual,
    getAppPreferences: vi.fn().mockResolvedValue(actual.defaultAppPreferences),
  }
})

import type {
  ChatInputHandle,
  ChatSubmitOptions,
  ProjectChatControls,
  ProjectWorkControls,
} from './ChatInput'
import { ChatInput } from './ChatInput'

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

function AttachmentChatInput({
  upload,
  variant = 'desktop',
  initialValue = '',
}: {
  upload: (file: File) => Promise<Attachment>
  variant?: 'desktop' | 'compact'
  initialValue?: string
}) {
  const [value, setValue] = useState(initialValue)
  const attachments = useComposerAttachments({
    uploadAttachment: upload,
    deleteAttachment: vi.fn(),
  })
  return (
    <ChatInput
      value={value}
      onChange={setValue}
      onSubmit={vi.fn()}
      disabled={false}
      variant={variant}
      projectChat={projectChatControls(attachments)}
    />
  )
}

const REMOTE_WORKSPACE_TARGET = {
  deviceId: 'remote-device',
  path: '/workspace/project',
  source: 'project',
  workspaceSource: 'remote',
} as const

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

describe('ChatInput', () => {
  beforeEach(async () => {
    await installDshUiTestContributions(
      {
        [WEWORK_DSH_SLOTS.projectWorkSection]: [
          {
            id: 'git-project-work',
            module: 'plugins/wework-ui-git-project-work-section.js',
          },
        ],
      },
      {
        'plugins/wework-ui-git-project-work-section.js': () =>
          import('../../../dsh/ui-git/src/project-work-section'),
      }
    )
  })

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
    delete window.__WEWORK_RUNTIME_CONFIG__
  })

  test('integrates work-item context and goal into the composer without a separate card', () => {
    const goal: RuntimeGoal = {
      threadId: 'thread-1',
      objective: '完成工作项验收',
      status: 'active',
      tokenBudget: null,
      tokensUsed: 0,
      timeUsedSeconds: 12,
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
        contextHeader={<div data-testid="work-item-context-summary">WORK-1 · 下一步：验收</div>}
        goal={goal}
      />
    )

    const rail = screen.getByTestId('composer-context-rail')
    const composer = screen.getByTestId('project-chat-composer-form')
    expect(rail).toContainElement(screen.getByTestId('work-item-context-summary'))
    expect(rail).toContainElement(screen.getByTestId('goal-status-bar'))
    expect(
      screen
        .getByTestId('goal-status-bar')
        .compareDocumentPosition(screen.getByTestId('work-item-context-summary'))
    ).toBe(Node.DOCUMENT_POSITION_FOLLOWING)
    expect(composer).toContainElement(rail)
    expect(rail).not.toHaveClass('border', 'bg-muted/45', 'divide-x')
    expect(composer).not.toHaveAttribute('data-short-collapse', 'true')
    expect(rail.compareDocumentPosition(screen.getByTestId('chat-message-input'))).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING
    )
  })

  test('shows pending supervision as task context above the editor', () => {
    const onConfigureSupervisor = vi.fn()
    render(
      <ChatInput
        value=""
        onChange={vi.fn()}
        onSubmit={vi.fn()}
        disabled={false}
        variant="desktop"
        onConfigureSupervisor={onConfigureSupervisor}
        supervisorEnabled
        supervisorPending
      />
    )

    const indicator = screen.getByTestId('pending-supervisor-indicator')
    fireEvent.click(indicator)

    expect(indicator).toHaveTextContent('workbench.supervisor_pending')
    expect(indicator).toHaveTextContent('workbench.supervisor_pending_edit')
    expect(indicator.compareDocumentPosition(screen.getByTestId('chat-message-input'))).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING
    )
    expect(screen.queryByTestId('pending-supervisor-pill')).not.toBeInTheDocument()
    expect(onConfigureSupervisor).toHaveBeenCalledOnce()
  })

  test.each(['desktop', 'compact'] as const)(
    'keeps the %s send action disabled until model selection is ready',
    async variant => {
      const onSubmit = vi.fn()
      render(
        <ChatInput
          value="new task"
          onChange={vi.fn()}
          onSubmit={onSubmit}
          disabled={false}
          variant={variant}
          projectChat={projectChatControls({ isModelSelectionReady: false })}
        />
      )

      expect(screen.getByTestId('send-message-button')).toBeDisabled()
      await userEvent.click(screen.getByTestId('send-message-button'))
      expect(onSubmit).not.toHaveBeenCalled()
    }
  )

  test('honors hidden attachment and submit actions in the compact composer', () => {
    render(
      <ChatInput
        value="Configuration draft"
        onChange={vi.fn()}
        onSubmit={vi.fn()}
        disabled={false}
        variant="compact"
        showSubmitButton={false}
        showAttachmentActions={false}
      />
    )
    expect(screen.queryByTestId('send-message-button')).not.toBeInTheDocument()
    expect(screen.queryByTestId('add-context-button')).not.toBeInTheDocument()
  })

  test('keeps model recovery visible in the fullscreen compact editor', async () => {
    render(
      <ChatInput
        value={'line 1\nline 2\nline 3\nline 4\nline 5'}
        onChange={vi.fn()}
        onSubmit={vi.fn()}
        disabled={false}
        variant="compact"
        projectChat={projectChatControls({
          models: [],
          selectedModel: null,
          isModelSelectionReady: false,
        })}
      />
    )

    await userEvent.click(screen.getByTestId('expand-input-button'))
    const trigger = screen.getByTestId('model-selector-button')
    expect(screen.getByTestId('fullscreen-input-sheet')).toContainElement(trigger)
    expect(trigger).toBeEnabled()
    await userEvent.click(trigger)
    expect(screen.getByTestId('model-selector-empty-state')).toBeInTheDocument()
  })

  test('moves the caret and editor viewport to the end after selecting a quick phrase', async () => {
    function Harness() {
      const [value, setValue] = useState('existing prompt')
      return (
        <ChatInput
          value={value}
          onChange={setValue}
          onSubmit={vi.fn()}
          disabled={false}
          variant="desktop"
        />
      )
    }

    render(<Harness />)
    const editor = screen.getByTestId('chat-message-input')
    const textNode = document.createTreeWalker(editor, NodeFilter.SHOW_TEXT).nextNode()
    const range = document.createRange()
    range.setStart(textNode!, 0)
    range.collapse(true)
    const selection = window.getSelection()!
    selection.removeAllRanges()
    selection.addRange(range)
    document.dispatchEvent(new Event('selectionchange'))

    await userEvent.click(screen.getByTestId('quick-phrase-button'))
    await userEvent.click(screen.getByTestId('quick-phrase-option-default-summary-progress'))

    await waitFor(() => {
      expect(editor).toHaveFocus()
      expect((editor as HTMLElement & { value: string }).value).toBe(
        'existing prompt\n总结目前完成的工作和下一步建议'
      )
    })
    const paragraphs = editor.querySelectorAll('p')
    const trailingText = paragraphs.item(paragraphs.length - 1).lastChild
    expect(window.getSelection()?.anchorNode).toBe(trailingText)
    expect(window.getSelection()?.anchorOffset).toBe(trailingText?.textContent?.length)
  })

  test('hides the plugin picker after task start and restores it for a new task', async () => {
    const props = {
      value: '',
      onChange: vi.fn(),
      onSubmit: vi.fn(),
      disabled: false,
      variant: 'desktop' as const,
      projectChat: projectChatControls(),
    }
    const { rerender } = render(<ChatInput {...props} />)
    await userEvent.click(screen.getByTestId('composer-plugin-picker-button'))
    expect(await screen.findByTestId('composer-plugin-picker')).toBeInTheDocument()

    rerender(<ChatInput {...props} showPluginPicker={false} />)
    expect(screen.queryByTestId('composer-plugin-picker-button')).not.toBeInTheDocument()
    expect(screen.queryByTestId('composer-plugin-picker')).not.toBeInTheDocument()
    expect(screen.getByTestId('model-selector-button')).toBeVisible()

    rerender(<ChatInput {...props} />)
    expect(screen.getByTestId('composer-plugin-picker-button')).toBeVisible()
    expect(screen.queryByTestId('composer-plugin-picker')).not.toBeInTheDocument()
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
        collapseWhenIdle
        isStreaming
        onPause={onPause}
      />
    )

    const form = screen.getByTestId('project-chat-composer-form')
    expect(form).toHaveAttribute('data-short-expanded', 'false')
    expect(screen.getByTestId('pause-response-button')).toBeInTheDocument()
    expect(screen.queryByTestId('send-message-button')).not.toBeInTheDocument()

    await userEvent.click(screen.getByTestId('pause-response-button'))

    expect(onPause).toHaveBeenCalledTimes(1)
    expect(form).toHaveAttribute('data-short-expanded', 'true')
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

  test('uses the selected follow-up behavior for the primary streaming action', async () => {
    const onSubmit = vi.fn()

    render(
      <WorkbenchContext.Provider
        value={
          {
            services: {},
            state: {
              user: {
                id: 1,
                user_name: 'alice',
                email: 'alice@example.com',
                preferences: {
                  send_key: 'cmd_enter',
                  follow_up_behavior: 'guide',
                },
              },
            },
          } as WorkbenchContextValue
        }
      >
        <ChatInput
          value="调整当前回复"
          onChange={vi.fn()}
          onSubmit={onSubmit}
          disabled={false}
          variant="desktop"
          isStreaming
        />
      </WorkbenchContext.Provider>
    )

    await userEvent.click(screen.getByTestId('send-message-button'))

    expect(onSubmit).toHaveBeenCalledWith('调整当前回复', {
      guideWhenBusy: true,
    })
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
    expect(menuButton).not.toHaveAttribute('title')
    expect(menuButton.querySelector('.lucide-chevron-down')).toBeInTheDocument()

    vi.useFakeTimers()
    fireEvent.pointerEnter(menuButton.parentElement as HTMLElement)
    act(() => vi.advanceTimersByTime(700))
    expect(screen.getByTestId('send-mode-menu-button-tooltip')).toHaveTextContent('选择发送方式')
    vi.useRealTimers()

    await userEvent.click(menuButton)
    expect(
      screen.getByTestId('send-after-turn-option').querySelector('.lucide-clock-3')
    ).toBeInTheDocument()
    const sendAfterTurnOption = screen.getByTestId('send-after-turn-option')
    expect(sendAfterTurnOption.querySelector('.lucide-corner-down-left')).toBeInTheDocument()
    expect(
      screen.getByTestId('guide-current-turn-option').querySelector('.lucide-corner-down-left')
    ).not.toBeInTheDocument()
    expect(screen.getByTestId('interrupt-and-send-option')).toHaveTextContent('⇧')
    await userEvent.click(screen.getByTestId('interrupt-and-send-option'))

    expect(onSubmit).toHaveBeenCalledWith('立即改方向', { interruptWhenBusy: true })
  })

  test('distinguishes the active model from the next-turn model while streaming', async () => {
    const activeModel: UnifiedModel = {
      name: 'local-model:first',
      type: 'runtime',
      displayName: 'First Model',
      isActive: true,
    }
    const selectedModel: UnifiedModel = {
      name: 'local-model:second',
      type: 'runtime',
      displayName: 'Second Model',
      isActive: true,
    }

    const projectChat = projectChatControls({
      models: [activeModel, selectedModel],
      activeModel,
      selectedModel,
    })
    const { rerender } = render(
      <ChatInput
        value="换模型继续"
        onChange={vi.fn()}
        onSubmit={vi.fn()}
        disabled={false}
        variant="desktop"
        isStreaming
        projectChat={projectChat}
      />
    )

    expect(screen.getByTestId('model-selector-button')).toHaveTextContent('Next · Second Model')
    await userEvent.click(screen.getByTestId('send-mode-menu-button'))
    expect(screen.getByTestId('guide-current-turn-option')).toHaveTextContent(
      'Guide current response · First Model'
    )
    expect(screen.getByTestId('interrupt-and-send-option')).toHaveTextContent(
      'Interrupt and use Second Model'
    )

    rerender(
      <ChatInput
        value="换模型继续"
        onChange={vi.fn()}
        onSubmit={vi.fn()}
        disabled={false}
        variant="desktop"
        isStreaming={false}
        projectChat={projectChat}
      />
    )
    expect(screen.getByTestId('model-selector-button')).toHaveTextContent('Second Model')
    expect(screen.getByTestId('model-selector-button')).not.toHaveTextContent('Next')
  })

  test('warns before switching away from the model that owns the conversation context', async () => {
    const activeModel: UnifiedModel = {
      name: 'local-model:first',
      type: 'runtime',
      displayName: 'First Model',
      isActive: true,
      config: { ui: { family: 'local' } },
    }
    const targetModel: UnifiedModel = {
      name: 'local-model:second',
      type: 'runtime',
      displayName: 'Second Model',
      isActive: true,
      config: { ui: { family: 'local' } },
    }
    const setSelectedModel = vi.fn()
    const onModelSelectorOpenChange = vi.fn()

    render(
      <ChatInput
        value=""
        onChange={vi.fn()}
        onSubmit={vi.fn()}
        disabled={false}
        variant="desktop"
        projectChat={projectChatControls({
          models: [activeModel, targetModel],
          activeModel,
          selectedModel: activeModel,
          setSelectedModel,
          onModelSelectorOpenChange,
        })}
      />
    )

    await userEvent.click(screen.getByTestId('model-selector-button'))
    await userEvent.click(screen.getByTestId('model-option-local-model:second'))

    expect(screen.getByTestId('model-switch-warning-dialog')).toHaveTextContent(
      'Switching to Second Model may change how the existing context is understood.'
    )
    expect(screen.getByTestId('model-switch-warning-dialog-overlay').parentElement).toBe(
      document.body
    )
    expect(screen.queryByTestId('model-selector-menu')).not.toBeInTheDocument()
    expect(setSelectedModel).not.toHaveBeenCalled()
    expect(onModelSelectorOpenChange).toHaveBeenLastCalledWith(false, 'selection')

    await userEvent.click(screen.getByTestId('model-switch-warning-cancel-button'))

    expect(screen.queryByTestId('model-switch-warning-dialog')).not.toBeInTheDocument()
    expect(setSelectedModel).not.toHaveBeenCalled()
    expect(onModelSelectorOpenChange).toHaveBeenLastCalledWith(false, 'dismiss')

    await userEvent.click(screen.getByTestId('model-selector-button'))
    await userEvent.click(screen.getByTestId('model-option-local-model:second'))
    await userEvent.click(screen.getByTestId('model-switch-warning-confirm-button'))

    expect(setSelectedModel).toHaveBeenCalledWith(targetModel)
    expect(screen.queryByTestId('model-switch-warning-dialog')).not.toBeInTheDocument()
  })

  test('recovers a deleted model in the same conversation despite its unavailable placeholder', async () => {
    const activeModel: UnifiedModel = {
      name: 'codex-official-unavailable',
      type: 'runtime',
      provider: 'local',
      isActive: false,
      config: { weworkModelKind: 'codex-official' },
    }
    const targetModel: UnifiedModel = {
      name: 'replacement-model',
      type: 'public',
      provider: 'openai',
      displayName: 'Replacement Model',
      isActive: true,
    }
    const setSelectedModel = vi.fn()

    render(
      <ChatInput
        value="Continue the original task"
        onChange={vi.fn()}
        onSubmit={vi.fn()}
        disabled={false}
        variant="desktop"
        projectChat={projectChatControls({
          models: [targetModel],
          activeModel,
          selectedModel: null,
          isModelSelectionReady: false,
          setSelectedModel,
        })}
      />
    )

    await userEvent.click(screen.getByTestId('model-selector-button'))
    await userEvent.click(screen.getByTestId('model-option-replacement-model'))
    expect(screen.getByTestId('model-switch-warning-dialog')).toHaveTextContent(
      'Switching to Replacement Model may change how the existing context is understood.'
    )
    await userEvent.click(screen.getByTestId('model-switch-warning-confirm-button'))

    expect(setSelectedModel).toHaveBeenCalledWith(targetModel)
  })

  test.each(['account-to-router', 'router-to-account'])(
    'switches %s in the existing conversation without rewriting the draft',
    async direction => {
      const accountModel: UnifiedModel = {
        name: 'gpt-5.6-sol',
        type: 'runtime',
        provider: 'local',
        displayName: 'GPT 5.6 Sol',
        isActive: true,
        config: { weworkModelKind: 'codex-official' },
      }
      const routerModel: UnifiedModel = {
        name: 'router-model',
        type: 'runtime',
        provider: 'local',
        displayName: 'Router Model',
        isActive: true,
        config: {
          weworkModelKind: 'codex-provider',
          codexProviderId: 'wecode-openai',
        },
      }
      const activeModel = direction === 'account-to-router' ? accountModel : routerModel
      const targetModel = direction === 'account-to-router' ? routerModel : accountModel
      const setSelectedModel = vi.fn()
      const onChange = vi.fn()

      render(
        <ChatInput
          value="继续排查"
          onChange={onChange}
          onSubmit={vi.fn()}
          disabled={false}
          variant="desktop"
          projectChat={projectChatControls({
            models: [activeModel, targetModel],
            supportsModelProviderSwitch: true,
            activeModel,
            selectedModel: activeModel,
            setSelectedModel,
          })}
        />
      )

      await userEvent.click(screen.getByTestId('model-selector-button'))
      await userEvent.click(screen.getByTestId(`model-option-${targetModel.name}`))

      expect(screen.getByTestId('model-switch-warning-dialog')).toHaveTextContent(
        `Switching to ${targetModel.displayName} may change how the existing context is understood`
      )
      expect(screen.getByTestId('model-switch-warning-confirm-button')).toHaveTextContent(
        'Switch model'
      )

      await userEvent.click(screen.getByTestId('model-switch-warning-confirm-button'))

      expect(setSelectedModel).toHaveBeenCalledExactlyOnceWith(targetModel)
      expect(onChange).not.toHaveBeenCalled()
    }
  )

  test.each([true, false])(
    'confirms same-name provider replacement only in stand-in session mode (%s)',
    async session => {
      const model: UnifiedModel = {
        name: 'same-model',
        type: 'runtime',
        provider: 'local',
        isActive: true,
        config: { weworkModelKind: 'codex-provider', codexProviderId: 'company' },
      }
      const setSelectedModel = vi.fn()
      const continueInNewConversation = vi.fn()
      render(
        <ChatInput
          value="Keep the draft"
          onChange={vi.fn()}
          onSubmit={vi.fn()}
          disabled={false}
          variant="desktop"
          projectChat={projectChatControls({
            models: [model],
            selectedModel: model,
            activeModel: model,
            activeModelSelection: {
              modelName: model.name,
              modelType: 'runtime',
              options: { codexProviderId: 'openai' },
            },
            modelSwitchMode: session ? 'session' : undefined,
            setSelectedModel,
            continueInNewConversation,
          })}
        />
      )
      await userEvent.click(screen.getByTestId('model-selector-button'))
      await userEvent.click(screen.getByTestId('model-option-same-model'))
      if (session) {
        expect(screen.getByTestId('model-switch-warning-dialog')).toHaveTextContent(
          'Your next message will start a new session here.'
        )
        expect(setSelectedModel).not.toHaveBeenCalled()
        await userEvent.click(screen.getByTestId('model-switch-warning-confirm-button'))
      } else {
        expect(screen.queryByTestId('model-switch-warning-dialog')).not.toBeInTheDocument()
      }
      expect(setSelectedModel).toHaveBeenCalledWith(model)
      expect(continueInNewConversation).not.toHaveBeenCalled()
    }
  )

  test('binds recovery confirmation to the session dialog even when provider metadata arrives late', async () => {
    const model: UnifiedModel = {
      name: 'same-model',
      type: 'runtime',
      provider: 'local',
      isActive: true,
      config: { weworkModelKind: 'codex-official' },
    }
    const confirmOldSession = vi.fn()
    const confirmNewSession = vi.fn()
    const setSelectedModel = vi.fn()
    const input = (requiresNewSession: boolean, onSessionStartConfirmed: () => void) => (
      <ChatInput
        value="Keep the draft"
        onChange={vi.fn()}
        onSubmit={vi.fn()}
        disabled={false}
        variant="desktop"
        projectChat={projectChatControls({
          models: [model],
          activeModel: model,
          selectedModel: model,
          activeModelProvider: 'openai',
          modelSwitchMode: 'session',
          requiresNewSession,
          onSessionStartConfirmed,
          setSelectedModel,
        })}
      />
    )
    const view = render(input(true, confirmOldSession))
    await userEvent.click(screen.getByTestId('model-selector-button'))
    await userEvent.click(screen.getByTestId('model-option-same-model'))
    await userEvent.click(screen.getByTestId('model-switch-warning-cancel-button'))
    expect(confirmOldSession).not.toHaveBeenCalled()
    expect(setSelectedModel).not.toHaveBeenCalled()
    await userEvent.click(screen.getByTestId('model-selector-button'))
    await userEvent.click(screen.getByTestId('model-option-same-model'))
    view.rerender(input(false, confirmNewSession))
    await userEvent.click(screen.getByTestId('model-switch-warning-confirm-button'))
    expect(confirmOldSession).toHaveBeenCalledOnce()
    expect(confirmOldSession).toHaveBeenCalledWith(model)
    expect(confirmNewSession).not.toHaveBeenCalled()
    expect(setSelectedModel).toHaveBeenCalledWith(model)
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

  test('renders native queued follow-up actions without local queue controls', async () => {
    const onForceStartQueuedMessage = vi.fn()
    const onCancelQueuedMessage = vi.fn()

    render(
      <ChatInput
        value=""
        onChange={vi.fn()}
        onSubmit={vi.fn()}
        disabled={false}
        variant="desktop"
        queuedMessages={[
          {
            id: 'runtime-queued-1',
            content: '继续修复并行问题',
            status: 'queued',
            runtimeQueued: true,
            runtimeQueuePosition: 2,
            createdAt: '2026-09-10T15:00:00.000+08:00',
          },
        ]}
        onForceStartQueuedMessage={onForceStartQueuedMessage}
        onCancelQueuedMessage={onCancelQueuedMessage}
        onSendQueuedAsGuidance={vi.fn()}
        onInterruptAndSendQueuedMessage={vi.fn()}
        onEditQueuedMessage={vi.fn()}
      />
    )

    expect(screen.getByText('排队中 · 第 2 位')).toBeInTheDocument()
    expect(screen.getByTestId('queue-force-start-button-runtime-queued-1')).toBeInTheDocument()
    expect(screen.queryByTestId('queue-guidance-button-runtime-queued-1')).not.toBeInTheDocument()
    expect(screen.queryByTestId('queue-interrupt-button-runtime-queued-1')).not.toBeInTheDocument()
    expect(screen.queryByTestId('queue-more-button-runtime-queued-1')).not.toBeInTheDocument()

    await userEvent.click(screen.getByTestId('queue-force-start-button-runtime-queued-1'))
    await userEvent.click(screen.getByTestId('queue-cancel-button-runtime-queued-1'))

    expect(onForceStartQueuedMessage).toHaveBeenCalledWith('runtime-queued-1')
    expect(onCancelQueuedMessage).toHaveBeenCalledWith('runtime-queued-1')
  })

  test('restores queued message text into the composer when editing', async () => {
    function Harness() {
      const [value, setValue] = useState('')
      const [queuedMessages, setQueuedMessages] = useState<QueuedWorkbenchMessage[]>([
        {
          id: 'queued-1',
          content: '先检查引导条里的文本',
          status: 'queued',
          createdAt: '2026-05-25T15:08:00.000+08:00',
        },
      ])

      return (
        <ChatInput
          value={value}
          onChange={setValue}
          onSubmit={vi.fn()}
          disabled={false}
          variant="desktop"
          queuedMessages={queuedMessages}
          onEditQueuedMessage={id => {
            const message = queuedMessages.find(item => item.id === id)
            if (!message) return
            setValue(message.content)
            setQueuedMessages(current => current.filter(item => item.id !== id))
          }}
        />
      )
    }

    render(<Harness />)

    await userEvent.click(screen.getByTestId('queue-more-button-queued-1'))
    await userEvent.click(screen.getByTestId('queue-edit-button-queued-1'))

    await waitFor(() =>
      expect(screen.getByTestId('chat-message-input')).toHaveTextContent('先检查引导条里的文本')
    )

    const editor = screen.getByTestId('chat-message-input')
    expect(editor).toHaveFocus()
    await userEvent.type(editor, '，继续')
    expect(editor).toHaveTextContent('先检查引导条里的文本，继续')
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
    const inputRef = createRef<ChatInputHandle>()
    const onSubmit = vi.fn()
    const onResumeQueue = vi.fn()
    const onChange = vi.fn()
    const onResumeQueueWithInput = vi.fn()

    render(
      <ChatInput
        ref={inputRef}
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
    expect(screen.getByTestId('paused-queue-send-dialog-overlay').parentElement).toBe(document.body)
    expect(onSubmit).not.toHaveBeenCalled()

    await userEvent.click(screen.getByTestId('paused-queue-send-preserve-button'))

    expect(onSubmit).not.toHaveBeenCalled()
    expect(onResumeQueueWithInput).toHaveBeenCalled()
    expect(onChange).toHaveBeenCalledWith('')
    expect(inputRef.current?.getValue()).toBe('')
  })

  test('exposes permission modes from the compact composer context sheet', async () => {
    const setSelectedModelOption = vi.fn()
    render(
      <ChatInput
        value=""
        onChange={vi.fn()}
        onSubmit={vi.fn()}
        disabled={false}
        projectChat={projectChatControls({
          selectedModelOptions: { permissionMode: 'workspace-write' },
          setSelectedModelOption,
        })}
      />
    )

    await userEvent.click(screen.getByTestId('add-context-button'))

    expect(screen.getByTestId('mobile-permission-mode-row')).toBeInTheDocument()
    await userEvent.click(screen.getByTestId('permission-mode-menu-button'))
    await userEvent.click(screen.getByTestId('permission-mode-read-only'))

    expect(setSelectedModelOption).toHaveBeenCalledWith('permissionMode', 'read-only')
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

  test.each(['desktop', 'compact'] as const)(
    'dismisses an attachment failure in the %s composer without losing the draft',
    async variant => {
      const upload = vi.fn().mockRejectedValue(new Error('test disk full'))
      render(
        <AttachmentChatInput upload={upload} variant={variant} initialValue="keep this draft" />
      )
      const editor = screen.getByTestId('chat-message-input')
      await userEvent.click(editor)
      expect(editor).toHaveValue('keep this draft')
      const input = screen.getByTestId(
        variant === 'desktop' ? 'attachment-file-input' : 'mobile-image-file-input'
      )
      await userEvent.upload(input, new File(['test'], 'failed.log'))

      const error = await screen.findByTestId('attachment-error-badge')
      expect(error).toHaveTextContent('failed.log')
      expect(error).toHaveTextContent('test disk full')
      expect(error).not.toHaveTextContent('failed.log:')
      const dismiss = screen.getByTestId('dismiss-attachment-error-button')
      dismiss.focus()
      await userEvent.keyboard('{Enter}')

      expect(screen.queryByTestId('attachment-error-badge')).not.toBeInTheDocument()
      expect(editor).toHaveValue('keep this draft')
      expect(upload).toHaveBeenCalledTimes(1)
    }
  )

  test('uploads pasted images from the desktop message textbox', async () => {
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

    await waitFor(() => expect(handleFileSelect).toHaveBeenCalledWith([image]))
  })

  test('normalizes a TIFF from clipboard history before attaching it', async () => {
    const handleFileSelect = vi.fn().mockResolvedValue(undefined)
    const screenshot = new File(['tiff'], '2026-11-12_14-07-58.tiff', {
      type: 'image/tiff',
    })
    vi.spyOn(runtimeEnvironment, 'isElectronRuntime').mockReturnValue(true)
    vi.spyOn(desktopHost, 'invokeDesktopHost').mockResolvedValue(
      'data:image/png;base64,iVBORw0KGgo='
    )

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
      clipboardData: { files: [screenshot] },
    })

    await waitFor(() => expect(handleFileSelect).toHaveBeenCalledOnce())
    const [files] = handleFileSelect.mock.calls[0] as unknown as [File[]]
    expect(files).toHaveLength(1)
    expect(files[0]).toMatchObject({
      name: '2026-11-12_14-07-58.png',
      type: 'image/png',
    })
    expect(desktopHost.invokeDesktopHost).toHaveBeenCalledWith('clipboard.convertImageToPng', {
      dataBase64: 'dGlmZg==',
      fileName: '2026-11-12_14-07-58.tiff',
      mimeType: 'image/tiff',
    })
  })

  test.each(['drop'] as const)(
    'renders a local Markdown file %s as an attachment outside the text editor',
    async action => {
      const file = new File(['test file content'], 'test-document.md', { type: 'text/markdown' })
      const upload = vi.fn().mockResolvedValue({
        id: 101,
        filename: file.name,
        file_size: file.size,
        mime_type: file.type,
        file_extension: '.md',
        status: 'ready',
        created_at: '2026-09-19T00:00:00Z',
      })
      const runtimeSpy = vi.spyOn(runtimeEnvironment, 'isDesktopRuntime').mockReturnValue(true)
      const hostSpy = vi
        .spyOn(desktopHost, 'invokeDesktopHost')
        .mockResolvedValue([{ path: '/tmp/test-document.md', isDirectory: false }])
      try {
        render(<AttachmentChatInput upload={upload} />)
        const editor = screen.getByTestId('chat-message-input')
        const transfer = {
          types: ['Files', 'text/uri-list'],
          files: [file],
          getData: (type: string) =>
            type === 'text/uri-list' ? 'file:///tmp/test-document.md' : '',
        }
        fireEvent[action](
          editor,
          action === 'paste' ? { clipboardData: transfer } : { dataTransfer: transfer }
        )
        await waitFor(() => expect(upload).toHaveBeenCalledWith(file, expect.any(Function)))
        const card = await screen.findByTestId('attachment-badge')
        expect(card).toHaveTextContent('test-document.md')
        expect(card).not.toHaveTextContent('test file content')
        expect(editor.contains(card)).toBe(false)
        expect(editor).toHaveValue('')
        expect(screen.queryByTestId('composer-path-chip-test-document-md')).not.toBeInTheDocument()
        expect(screen.getByTestId('send-message-button')).toBeEnabled()
        await userEvent.click(screen.getByTestId('remove-attachment-button'))
        await waitFor(() =>
          expect(screen.queryByTestId('attachment-badge')).not.toBeInTheDocument()
        )
      } finally {
        runtimeSpy.mockRestore()
        hostSpy.mockRestore()
      }
    }
  )

  test('uploads pasted documents for a remote desktop workspace', async () => {
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
        workspaceTarget={REMOTE_WORKSPACE_TARGET}
      />
    )

    fireEvent.paste(screen.getByTestId('chat-message-input'), {
      clipboardData: {
        files: [documentFile],
      },
    })

    await waitFor(() => expect(handleFileSelect).toHaveBeenCalledWith([documentFile]))
  })

  test('keeps pasted text identity through upload and restores its complete multiline content', async () => {
    const text = 'test\n'.repeat(1000)
    const upload = vi.fn(
      async (file: File): Promise<Attachment> => ({
        id: 102,
        filename: file.name,
        mime_type: file.type,
        file_size: file.size,
        file_extension: '.txt',
        status: 'ready',
        created_at: '2026-09-19T00:00:00Z',
      })
    )
    render(<AttachmentChatInput upload={upload} />)
    const editor = screen.getByTestId('chat-message-input')
    fireEvent.paste(editor, {
      clipboardData: {
        files: [],
        types: ['text/plain'],
        getData: (type: string) => (type === 'text/plain' ? text : ''),
      },
    })
    const card = await screen.findByTestId('attachment-badge')
    expect(within(card).getByTestId('attachment-text-preview')).toHaveTextContent('test')
    expect(screen.queryByTestId('uploading-attachment-badge')).not.toBeInTheDocument()
    expect(screen.queryByTestId('attachment-document-icon')).not.toBeInTheDocument()
    expect(screen.getByTestId('attachment-badge-list')).toHaveClass('overflow-x-auto')
    expect(screen.getByTestId('attachment-badge-list')).not.toHaveClass('flex-wrap')
    expect(editor).toHaveValue('')
    expect(await upload.mock.calls[0][0].text()).toBe(text)
    await userEvent.click(screen.getByTestId('show-text-attachment-button'))
    await waitFor(() => expect(screen.queryByTestId('attachment-badge')).not.toBeInTheDocument())
    expect(editor).toHaveValue(text)
  })

  test('keeps a later selected file before pasted text while either upload is pending', async () => {
    const text = 'test\n'.repeat(1000)
    const pending = new Map<File, (attachment: Attachment) => void>()
    const upload = vi.fn(
      (file: File) => new Promise<Attachment>(resolve => pending.set(file, resolve))
    )
    const finish = async (file: File, id: number) => {
      await act(async () =>
        pending.get(file)!({
          id,
          filename: file.name,
          mime_type: file.type,
          file_size: file.size,
          file_extension: '.txt',
          status: 'ready',
          created_at: '2026-09-19T00:00:00Z',
        })
      )
    }
    render(<AttachmentChatInput upload={upload} />)
    const editor = screen.getByTestId('chat-message-input')
    fireEvent.paste(editor, {
      clipboardData: {
        files: [],
        types: ['text/plain'],
        getData: (type: string) => (type === 'text/plain' ? text : ''),
      },
    })
    await waitFor(() => expect(upload).toHaveBeenCalledTimes(1))
    const pastedFile = upload.mock.calls[0][0]
    // A selected text file stays a file even when its name resembles a pasted attachment.
    const file = new File(['test document'], 'clipboard-text-test.txt', { type: 'text/plain' })
    await userEvent.click(screen.getByTestId('add-context-button'))
    await userEvent.upload(screen.getByTestId('attachment-file-input'), file)

    const cards = () =>
      within(screen.getByTestId('attachment-badge-list')).getAllByTestId(
        /^(uploading-)?attachment-badge$/
      )
    expect(cards()).toHaveLength(2)
    expect(cards()[0]).toHaveTextContent(file.name)
    expect(cards()[1]).toHaveAttribute('aria-busy', 'true')
    await waitFor(() =>
      expect(within(cards()[1]).getByTestId('attachment-text-preview')).toHaveTextContent('test')
    )
    expect(cards()[1]).not.toHaveTextContent(pastedFile.name)

    await finish(pastedFile, 101)
    await screen.findByTestId('attachment-badge')
    expect(cards()[1]).not.toHaveAttribute('aria-busy')
    expect(cards()[0]).toHaveTextContent(file.name)
    expect(within(cards()[1]).getByTestId('attachment-text-preview')).toHaveTextContent('test')

    await finish(file, 102)
    await waitFor(() =>
      expect(screen.queryByTestId('uploading-attachment-badge')).not.toBeInTheDocument()
    )
    expect(cards()[0]).toHaveTextContent(file.name)
    expect(within(cards()[0]).getByTestId('attachment-document-icon')).toBeInTheDocument()
    expect(within(cards()[1]).getByTestId('attachment-text-preview')).toHaveTextContent('test')

    await userEvent.click(within(cards()[0]).getByTestId('remove-attachment-button'))
    await waitFor(() => expect(cards()).toHaveLength(1))
    await userEvent.click(screen.getByTestId('show-text-attachment-button'))
    await waitFor(() =>
      expect(screen.queryByTestId('attachment-badge-list')).not.toBeInTheDocument()
    )
    expect(editor).toHaveValue(text)
  })

  test('adds workspace files dragged from the right sidebar as path references', async () => {
    const onChange = vi.fn()

    render(
      <ChatInput
        value=""
        onChange={onChange}
        onSubmit={vi.fn()}
        disabled={false}
        variant="desktop"
      />
    )

    fireEvent.drop(screen.getByTestId('chat-message-input'), {
      dataTransfer: {
        types: [WORKSPACE_PATH_DRAG_TYPE],
        files: [],
        getData: (type: string) =>
          type === WORKSPACE_PATH_DRAG_TYPE
            ? JSON.stringify([
                {
                  path: '/workspace/project/docs/requirements.md',
                  isDirectory: false,
                },
              ])
            : '',
      },
    })

    await waitFor(() =>
      expect(screen.getByTestId('composer-path-chip-requirements-md')).toHaveAttribute(
        'data-composer-path',
        '/workspace/project/docs/requirements.md'
      )
    )
    expect(onChange).toHaveBeenCalledWith(expect.stringContaining('requirements.md'))
  })

  test('accepts selected workspace text dragged into the desktop composer', () => {
    const onChange = vi.fn()

    render(
      <ChatInput
        value=""
        onChange={onChange}
        onSubmit={vi.fn()}
        disabled={false}
        variant="desktop"
      />
    )

    const composer = screen.getByTestId('project-chat-composer-form')
    const dataTransfer = {
      types: [SELECTED_TEXT_DRAG_TYPE, 'text/plain'],
      dropEffect: 'none',
      getData: (type: string) =>
        type === 'text/plain' ? 'export const selectedTextDrag = true' : 'true',
    }
    fireEvent.dragOver(composer, { dataTransfer })
    expect(dataTransfer.dropEffect).toBe('copy')
    fireEvent.drop(composer, { dataTransfer })

    expect(onChange).toHaveBeenCalledWith('export const selectedTextDrag = true')
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

  test('uses the current API model efforts without switching to same-id Codex Auth', async () => {
    const apiModel: UnifiedModel = {
      name: 'local-model:api-sol',
      type: 'runtime',
      provider: 'local',
      displayName: 'API Sol',
      modelId: 'gpt-5.6-sol',
      config: {
        weworkModelKind: 'model-interface',
        ui: {
          family: 'model-interface',
          modelLabel: 'API Sol',
          reasoningEfforts: ['minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
          defaultReasoningEffort: 'minimal',
          controls: ['speed'],
        },
      },
    }
    const officialModel: UnifiedModel = {
      name: 'gpt-5.6-sol',
      type: 'runtime',
      provider: 'local',
      displayName: 'GPT 5.6 Sol',
      modelId: 'gpt-5.6-sol',
      config: {
        weworkModelKind: 'codex-official',
        ui: {
          family: 'codex-official',
          modelLabel: 'GPT 5.6 Sol',
          reasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'ultra'],
          defaultReasoningEffort: 'medium',
          controls: ['speed'],
        },
      },
    }
    const setSelectedModel = vi.fn()
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
          models: [officialModel, apiModel],
          selectedModel: apiModel,
          selectedModelOptions: { reasoning: 'xhigh', speed: 'standard' },
          setSelectedModel,
          setSelectedModelAndOptions,
          setSelectedModelOption,
        })}
      />
    )

    await userEvent.click(screen.getByTestId('model-selector-button'))

    expect(screen.getByTestId('model-advanced-panel')).toBeInTheDocument()
    expect(screen.getByTestId('model-control-reasoning-minimal')).toHaveAccessibleName('Minimal')
    expect(screen.getByTestId('model-control-reasoning-low')).toHaveAccessibleName('Low')
    expect(screen.getByTestId('model-control-reasoning-xhigh')).toHaveAccessibleName('Extra high')
    expect(screen.getByTestId('model-control-reasoning-max')).toHaveAccessibleName('Maximum')
    expect(screen.getByTestId('model-control-reasoning-ultra')).toHaveAccessibleName('Ultra')
    expect(screen.queryByTestId('model-control-reasoning-none')).not.toBeInTheDocument()

    await userEvent.click(screen.getByTestId('model-control-reasoning-max'))

    expect(setSelectedModelOption).toHaveBeenCalledWith('reasoning', 'max')
    expect(setSelectedModel).not.toHaveBeenCalled()
    expect(setSelectedModelAndOptions).not.toHaveBeenCalled()
  })

  test('offers the Codex-reported default model when another model is selected', async () => {
    const solModel: UnifiedModel = {
      name: 'gpt-5.6-sol',
      type: 'runtime',
      displayName: 'GPT 5.6 Sol',
      config: {
        codexAuthConfigured: true,
        codexIsDefault: true,
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
        codexAuthConfigured: true,
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

    await userEvent.click(screen.getByTestId('model-advanced-toggle'))
    expect(screen.getByTestId('model-option-default')).toHaveTextContent('默认推荐模型集')
    expect(screen.getByTestId('model-option-default')).toHaveClass(
      'hover:bg-muted',
      'focus-visible:bg-muted'
    )
    expect(screen.getByTestId('model-option-default')).toHaveAttribute('aria-checked', 'false')
    expect(screen.getByTestId('model-option-gpt-5.6-terra')).toHaveAttribute('aria-checked', 'true')

    await userEvent.click(screen.getByTestId('model-option-default'))

    expect(setSelectedModelAndOptions).toHaveBeenCalledWith(solModel, {
      modelSelection: 'runtime:gpt-5.6-sol:recommended',
      reasoning: 'medium',
      speed: 'standard',
    })
    expect(screen.getByTestId('model-selector-menu')).toHaveAttribute('data-panel', 'simple')
  })

  test('keeps Default and its concrete Codex model mutually exclusive', async () => {
    const defaultModel: UnifiedModel = {
      name: 'gpt-6.1-sol',
      type: 'runtime',
      provider: 'local',
      displayName: 'GPT-6.1 Sol',
      config: {
        codexAuthConfigured: true,
        codexIsDefault: true,
        weworkModelKind: 'codex-official',
        ui: {
          family: 'codex-official',
          modelLabel: 'GPT-6.1 Sol',
          reasoningEfforts: ['low', 'medium', 'high', 'xhigh'],
          defaultReasoningEffort: 'medium',
          controls: ['speed'],
        },
      },
    }
    const cloudModel: UnifiedModel = {
      name: 'cloud-gpt',
      type: 'public',
      provider: 'cloud',
      displayName: 'Cloud GPT',
      config: {
        ui: {
          family: 'gpt',
          modelLabel: 'Cloud GPT',
          reasoningEfforts: ['low', 'medium'],
          defaultReasoningEffort: 'medium',
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
          models: [defaultModel, cloudModel],
          selectedModel: defaultModel,
          selectedModelOptions: { reasoning: 'medium', speed: 'standard' },
          setSelectedModel: vi.fn(),
        })}
      />
    )

    await userEvent.click(screen.getByTestId('model-selector-button'))
    await userEvent.click(screen.getByTestId('model-advanced-toggle'))

    const defaultOption = screen.getByTestId('model-option-default')
    const concreteOption = screen.getByTestId('model-option-gpt-6.1-sol')
    expect(screen.getByTestId('model-source-local-chatgpt')).toContainElement(defaultOption)
    expect(screen.getByTestId('model-group-codex-official')).not.toContainElement(defaultOption)
    expect(screen.getByTestId('model-group-codex-official')).toContainElement(concreteOption)
    expect(screen.getByTestId('model-group-gpt')).not.toContainElement(defaultOption)
    expect(defaultOption).toHaveAttribute('aria-checked', 'true')
    expect(concreteOption).toHaveAttribute('aria-checked', 'false')

    await userEvent.click(concreteOption)

    expect(defaultOption).toHaveAttribute('aria-checked', 'false')
    expect(concreteOption).toHaveAttribute('aria-checked', 'true')
  })

  test('switches both model and reasoning effort from the ChatGPT power slider', async () => {
    const solModel: UnifiedModel = {
      name: 'gpt-6.1-sol',
      type: 'runtime',
      provider: 'local',
      displayName: 'GPT-6.1 Sol',
      config: {
        codexAuthConfigured: true,
        codexIsDefault: true,
        weworkModelKind: 'codex-official',
        ui: {
          family: 'codex-official',
          modelLabel: 'GPT-6.1 Sol',
          reasoningEfforts: ['low', 'medium', 'high', 'xhigh'],
          defaultReasoningEffort: 'medium',
        },
      },
    }
    const lunaModel: UnifiedModel = {
      name: 'gpt-6-luna',
      type: 'runtime',
      provider: 'local',
      displayName: 'GPT-6 Luna',
      config: {
        weworkModelKind: 'codex-official',
        ui: {
          family: 'codex-official',
          modelLabel: 'GPT-6 Luna',
          reasoningEfforts: ['high'],
          defaultReasoningEffort: 'high',
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
          models: [solModel, lunaModel],
          selectedModel: solModel,
          selectedModelOptions: { reasoning: 'low', speed: 'standard' },
          setSelectedModelAndOptions,
        })}
      />
    )

    await userEvent.click(screen.getByTestId('model-selector-button'))
    await userEvent.click(screen.getByTestId('model-power-setting-gpt-6-luna-high'))

    expect(setSelectedModelAndOptions).toHaveBeenCalledWith(lunaModel, {
      reasoning: 'high',
      speed: 'standard',
    })
  })

  test('uses a cloud-provided default model set and slider configuration', async () => {
    const defaultCloudModel: UnifiedModel = {
      name: 'cloud-sol',
      type: 'public',
      provider: 'cloud',
      displayName: 'Cloud Sol',
      config: {
        ui: {
          family: 'cloud-openai',
          modelLabel: 'Cloud Sol',
          defaultModel: true,
          reasoningEfforts: ['low', 'medium', 'high'],
          defaultReasoningEffort: 'medium',
          sliderModelsConfig: {
            defaultPreset: 'recommended',
            presets: [
              {
                name: 'recommended',
                label: '推荐',
                description: '日常推荐',
                models: [
                  { model: 'cloud-luna', reasoning_effort: 'high' },
                  { model: 'cloud-sol', reasoning_effort: 'low' },
                  { model: 'cloud-sol', reasoning_effort: 'medium' },
                  { model: 'cloud-sol', reasoning_effort: 'high' },
                ],
              },
              {
                name: 'quality',
                label: '高质量',
                description: '更重视质量',
                models: [
                  { model: 'cloud-terra', reasoning_effort: 'high' },
                  { model: 'not-visible', reasoning_effort: 'high' },
                ],
              },
              {
                name: 'unavailable',
                label: '不可用',
                models: [{ model: 'not-visible', reasoning_effort: 'high' }],
              },
            ],
          },
        },
      },
    }
    const cloudLunaModel: UnifiedModel = {
      name: 'cloud-luna',
      type: 'public',
      provider: 'cloud',
      displayName: 'Cloud Luna',
      config: {
        ui: {
          family: 'cloud-openai',
          modelLabel: 'Cloud Luna',
          reasoningEfforts: ['high'],
          defaultReasoningEffort: 'high',
        },
      },
    }
    const cloudTerraModel: UnifiedModel = {
      name: 'cloud-terra',
      type: 'public',
      provider: 'cloud',
      displayName: 'Cloud Terra',
      config: {
        ui: {
          family: 'cloud-openai',
          modelLabel: 'Cloud Terra',
          reasoningEfforts: ['high'],
          defaultReasoningEffort: 'high',
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
          models: [cloudLunaModel, defaultCloudModel, cloudTerraModel],
          selectedModel: defaultCloudModel,
          selectedModelOptions: { reasoning: 'low' },
          setSelectedModelAndOptions,
        })}
      />
    )

    await userEvent.click(screen.getByTestId('model-selector-button'))
    await userEvent.click(screen.getByTestId('model-advanced-toggle'))
    expect(screen.getByTestId('model-option-default')).toHaveTextContent('默认日常推荐')
    expect(screen.getByTestId('model-option-preset-quality')).toHaveTextContent('高质量更重视质量')
    expect(screen.queryByTestId('model-option-preset-unavailable')).not.toBeInTheDocument()
    await userEvent.click(screen.getByTestId('model-option-preset-quality'))

    expect(setSelectedModelAndOptions).toHaveBeenCalledWith(cloudTerraModel, {
      modelSelection: 'public:cloud-sol:quality',
      reasoning: 'high',
    })

    await userEvent.click(screen.getByTestId('model-advanced-toggle'))
    await userEvent.click(screen.getByTestId('model-option-default'))
    await userEvent.click(screen.getByTestId('model-power-setting-cloud-luna-high'))

    expect(setSelectedModelAndOptions).toHaveBeenCalledWith(cloudLunaModel, {
      reasoning: 'high',
    })
  })

  test('uses the selected model reasoning slider after choosing an explicit model', async () => {
    const solModel: UnifiedModel = {
      name: 'gpt-6.1-sol',
      type: 'runtime',
      provider: 'local',
      displayName: 'GPT-6.1 Sol',
      config: {
        codexIsDefault: true,
        weworkModelKind: 'codex-official',
        ui: {
          family: 'codex-official',
          modelLabel: 'GPT-6.1 Sol',
          reasoningEfforts: ['low', 'medium', 'high', 'xhigh'],
          defaultReasoningEffort: 'medium',
        },
      },
    }
    const lunaModel: UnifiedModel = {
      name: 'gpt-6-luna',
      type: 'runtime',
      provider: 'local',
      displayName: 'GPT-6 Luna',
      config: {
        weworkModelKind: 'codex-official',
        ui: {
          family: 'codex-official',
          modelLabel: 'GPT-6 Luna',
          reasoningEfforts: ['low', 'medium', 'high', 'xhigh'],
          defaultReasoningEffort: 'high',
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
          models: [solModel, lunaModel],
          selectedModel: lunaModel,
          selectedModelOptions: { reasoning: 'xhigh', speed: 'standard' },
          setSelectedModelOption,
        })}
      />
    )

    await userEvent.click(screen.getByTestId('model-selector-button'))

    expect(screen.getByTestId('model-selector-button')).toHaveTextContent('Select effort')
    expect(screen.getByTestId('model-simple-header')).toHaveTextContent('Extra High')
    expect(screen.getByTestId('model-simple-header')).toHaveTextContent('GPT-6 Luna')
    expect(screen.getByTestId('model-control-reasoning-track')).toHaveAttribute(
      'aria-valuetext',
      'Extra High'
    )

    await userEvent.click(screen.getByTestId('model-control-reasoning-low'))

    expect(setSelectedModelOption).toHaveBeenCalledWith('reasoning', 'low')
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

    await userEvent.click(screen.getByTestId('model-option-ali-qwen3-coder-plus'))

    expect(setSelectedModel).toHaveBeenCalledWith(model)
    expect(screen.getByTestId('model-selector-menu')).toBeInTheDocument()
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
    expect(disabledOption).not.toHaveTextContent('Incompatible with the current model protocol')

    await userEvent.click(disabledOption)

    expect(setSelectedModel).not.toHaveBeenCalled()
    expect(onBlockedModelSelect).toHaveBeenCalledWith(
      incompatibleModel,
      'Incompatible with the current model protocol'
    )
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
    expect(menu.getByText('目标')).toBeInTheDocument()
    expect(screen.getByTestId('attachment-file-input')).toBeInTheDocument()

    await userEvent.click(menu.getByTestId('set-plan-mode-button'))
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
    const details = screen.getByTestId('goal-status-details')
    const pauseButton = screen.getByTestId('pause-goal-button')
    expect(bar).not.toHaveTextContent('进行中')
    expect(bar).toHaveTextContent('实现 plan 里的功能')
    expect(bar).toHaveTextContent('2m 58s')
    expect(pauseButton).toHaveAccessibleName('暂停目标')
    expect(details).not.toContainElement(pauseButton)
    expect(details).toContainElement(screen.getByTestId('edit-goal-button'))
    expect(details).toContainElement(screen.getByTestId('clear-goal-button'))
    expect(details.compareDocumentPosition(pauseButton)).toBe(Node.DOCUMENT_POSITION_FOLLOWING)
    expect(screen.getByTestId('goal-running-icon')).toHaveClass('opacity-100')
    expect(screen.getByTestId('goal-pause-icon')).toHaveClass('absolute', 'inset-0', 'opacity-0')

    fireEvent.mouseEnter(bar)
    expect(screen.getByTestId('goal-running-icon')).toHaveClass('opacity-0')
    expect(screen.getByTestId('goal-pause-icon')).toHaveClass('opacity-100')

    await userEvent.click(screen.getByTestId('edit-goal-button'))
    await userEvent.click(pauseButton)
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

    expect(screen.getByTestId('goal-status-bar')).toHaveTextContent('正在开始下一轮')
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

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/attachments/43/download',
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: 'Bearer token-123' }),
      })
    )
  })

  test.each([true])('applies requireText=%s to attachment-only submissions', async requireText => {
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
        requireText={requireText}
      />
    )

    if (requireText) {
      expect(screen.getByTestId('send-message-button')).toBeDisabled()
      fireEvent.keyDown(screen.getByTestId('chat-message-input'), { key: 'Enter' })
      expect(onSubmit).not.toHaveBeenCalled()
      return
    }
    expect(screen.getByTestId('send-message-button')).toBeEnabled()
    await userEvent.click(screen.getByTestId('send-message-button'))
    expect(onSubmit).toHaveBeenCalledTimes(1)
  })

  test('keeps model selection usable while only submission is disabled', async () => {
    const onSubmit = vi.fn()
    render(
      <ChatInput
        value="Keep this draft"
        onChange={vi.fn()}
        onSubmit={onSubmit}
        disabled={false}
        submitDisabled
        variant="desktop"
        projectChat={projectChatControls()}
      />
    )
    expect(screen.getByTestId('chat-message-input')).toHaveAttribute('contenteditable', 'true')
    expect(screen.getByTestId('send-message-button')).toBeDisabled()
    fireEvent.keyDown(screen.getByTestId('chat-message-input'), { key: 'Enter' })
    await userEvent.click(screen.getByTestId('send-message-button'))
    expect(onSubmit).not.toHaveBeenCalled()
    expect(screen.getByTestId('model-selector-button')).toBeEnabled()
    await userEvent.click(screen.getByTestId('model-selector-button'))
    expect(screen.getByTestId('model-selector-menu')).toBeVisible()
    expect(screen.getByTestId('chat-message-input')).toHaveTextContent('Keep this draft')
  })

  test.each(['background', 'menu'] as const)(
    'restores the saved cloud model and sending after %s catalog recovery',
    async recovery => {
      const cloud: UnifiedModel = {
        name: 'cloud-restored-sol',
        modelId: 'gpt-6.1-sol',
        type: 'public',
        provider: 'openai',
        namespace: 'default',
        resourceUserId: 7,
        config: { protocol: 'openai-responses', ui: { reasoningEfforts: ['low', 'high'] } },
      }
      const profile: WorkspaceStandInSettings = {
        enabled: true,
        prompt: '',
        version: 1,
        executionDeviceId: 'device',
        model: cloudRunnerModelIdentity(cloud, 'codex'),
        modelOptions: { reasoning: 'high' },
      }
      const before = structuredClone(profile)
      let finish!: (models: UnifiedModel[]) => void
      const pending = new Promise<UnifiedModel[]>(resolve => (finish = resolve))
      const load = vi.fn(() => pending)
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
      if (recovery === 'menu') load.mockRejectedValueOnce(new Error('Cloud unavailable'))
      const cache = createCloudModelCatalog(load)
      const refresh = vi.fn(cache.refresh)
      const services = {
        standInApi: {
          catalog: vi.fn(async () => ({
            models: [
              {
                runtime: 'codex',
                provider: 'openai',
                model_id: cloud.modelId,
                local_model_id: cloud.modelId,
                label: 'Native Sol',
                is_default: true,
              },
            ],
          })),
        },
        modelApi: {
          subscribe: cache.subscribe,
          refresh,
          listModels: async () => {
            cache.loadIfNeeded()
            return { data: cache.getModels() }
          },
        },
      } as unknown as WorkbenchServices
      const onSubmit = vi.fn()
      let controls: ConversationModelControls | undefined
      function RecoveryComposer() {
        const model = useStandInConversationModel(services, profile)
        useEffect(() => {
          controls = model
        }, [model])
        const [value, setValue] = useState('Keep the cloud draft')
        return (
          <ChatInput
            value={value}
            onChange={setValue}
            onSubmit={() =>
              onSubmit(
                selectedModelExecutionFields(model.selectedModel, model.selectedModelOptions)
              )
            }
            disabled={false}
            submitDisabled={model.loading || model.unavailable}
            variant="desktop"
            projectChat={projectChatControls({
              ...model,
              activeModel: model.unavailable ? null : model.selectedModel,
              isModelSelectionReady: !model.loading && !model.unavailable,
            })}
          />
        )
      }
      const view = render(<RecoveryComposer />)
      try {
        await waitFor(() => expect(controls?.loading).toBe(false))
        expect(controls?.unavailable).toBe(true)
        expect(screen.getByTestId('send-message-button')).toBeDisabled()
        fireEvent.keyDown(screen.getByTestId('chat-message-input'), { key: 'Enter' })
        expect(onSubmit).not.toHaveBeenCalled()
        expect(screen.getByTestId('model-selector-button')).toBeEnabled()
        if (recovery === 'background') {
          await userEvent.click(screen.getByTestId('model-selector-button'))
          await userEvent.click(await screen.findByTestId('model-control-reasoning-low'))
          expect(controls?.selectedModelOptions.reasoning).toBe('low')
          expect(screen.getByTestId('send-message-button')).toBeDisabled()
          await userEvent.keyboard('{Escape}')
        }
        if (recovery === 'menu') {
          await waitFor(() => expect(warn).toHaveBeenCalledOnce())
          await userEvent.click(screen.getByTestId('model-selector-button'))
          expect(refresh).toHaveBeenCalledOnce()
          await waitFor(() => expect(load).toHaveBeenCalledTimes(2))
        }
        await act(async () => finish([cloud]))
        await waitFor(() => expect(screen.getByTestId('send-message-button')).toBeEnabled())
        expect(controls?.selectedModel).toBe(cloud)
        expect(controls?.selectedModelOptions.reasoning).toBe(
          recovery === 'background' ? 'low' : 'high'
        )
        expect(screen.getByTestId('chat-message-input')).toHaveTextContent('Keep the cloud draft')
        if (recovery === 'menu') {
          await userEvent.click(screen.getByTestId('model-advanced-toggle'))
          await userEvent.click(screen.getByTestId(`model-option-${cloud.name}`))
          await userEvent.keyboard('{Escape}')
          const updated = { ...cloud, contextWindow: 1_048_576, maxOutputTokens: 96_000 }
          load.mockResolvedValue([updated])
          await userEvent.click(screen.getByTestId('model-selector-button'))
          await waitFor(() => expect(controls?.models).toContain(updated))
          expect(controls?.selectedModel).toBe(updated)
          await userEvent.keyboard('{Escape}')
          expect(refresh).toHaveBeenCalledTimes(2)
        }
        await userEvent.click(screen.getByTestId('send-message-button'))
        expect(onSubmit).toHaveBeenCalledWith(
          expect.objectContaining({
            modelId: cloud.name,
            modelType: 'public',
            modelOptions: expect.objectContaining({
              reasoning: recovery === 'background' ? 'low' : 'high',
              weworkCloudModelNamespace: 'default',
              weworkCloudModelResourceUserId: '7',
            }),
          })
        )
        if (recovery === 'menu') {
          expect(onSubmit).toHaveBeenCalledWith(
            expect.objectContaining({
              modelOptions: expect.objectContaining({
                weworkCloudModelContextWindow: '1048576',
                weworkCloudModelMaxOutputTokens: '96000',
              }),
            })
          )
        }
        expect(profile).toEqual(before)
        expect(load).toHaveBeenCalledTimes(recovery === 'menu' ? 3 : 1)
      } finally {
        finish([])
        view.unmount()
        warn.mockRestore()
      }
    }
  )

  test.each(['saved Claude runtime', 'missing default', 'ambiguous default'])(
    'recovers a %s through the model menu without leaving stand-in chat',
    async reason => {
      const native: RunnerModel = {
        runtime: 'codex',
        provider: 'openai',
        model_id: 'gpt-6.1-sol',
        local_model_id: 'gpt-6.1-sol',
        label: 'Recovery Codex',
        account_label: 'ChatGPT',
        is_default: true,
      }
      const profile: WorkspaceStandInSettings = {
        enabled: true,
        prompt: '',
        version: 1,
        executionDeviceId: 'device',
        model: reason === 'saved Claude runtime' ? { ...native, runtime: 'claude_code' } : null,
      }
      const before = structuredClone(profile)
      const services = {
        standInApi: {
          catalog: vi.fn(async () => ({
            models:
              reason === 'missing default'
                ? [{ ...native, is_default: false }]
                : reason === 'ambiguous default'
                  ? [
                      native,
                      { ...native, model_id: 'other-default', local_model_id: 'other-default' },
                    ]
                  : [native],
          })),
        },
        modelApi: { listModels: vi.fn(async () => ({ data: [] })) },
      } as unknown as WorkbenchServices
      const onSubmit = vi.fn()
      const continueInNewConversation = vi.fn()
      function RecoveryComposer() {
        const controls = useStandInConversationModel(services, profile)
        const [value, setValue] = useState('Keep this draft')
        return (
          <ChatInput
            value={value}
            onChange={setValue}
            onSubmit={() =>
              onSubmit(
                selectedModelExecutionFields(controls.selectedModel, controls.selectedModelOptions)
              )
            }
            disabled={false}
            submitDisabled={controls.loading || controls.unavailable}
            variant="desktop"
            projectChat={projectChatControls({
              ...controls,
              activeModel: controls.unavailable ? null : controls.selectedModel,
              isModelSelectionReady: !controls.loading && !controls.unavailable,
              continueInNewConversation,
            })}
          />
        )
      }
      render(<RecoveryComposer />)
      expect(screen.getByTestId('send-message-button')).toBeDisabled()
      fireEvent.keyDown(screen.getByTestId('chat-message-input'), { key: 'Enter' })
      expect(onSubmit).not.toHaveBeenCalled()
      await userEvent.click(screen.getByTestId('model-selector-button'))
      const option = await screen.findByTestId(`model-option-${native.model_id}`)
      expect(option).toHaveAttribute('aria-checked', 'false')
      await userEvent.click(option)
      expect(screen.queryByTestId('model-switch-warning-dialog')).not.toBeInTheDocument()
      expect(screen.getByTestId('chat-message-input')).toHaveTextContent('Keep this draft')
      expect(screen.getByTestId('send-message-button')).toBeEnabled()
      await userEvent.click(screen.getByTestId('send-message-button'))
      expect(onSubmit).toHaveBeenCalledWith(
        expect.objectContaining({
          modelId: native.model_id,
          modelOptions: expect.objectContaining({ codexProviderId: native.provider }),
        })
      )
      expect(continueInNewConversation).not.toHaveBeenCalled()
      expect(profile).toEqual(before)
    }
  )

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

  test('shows three common plugin tasks and keeps additional tasks secondary', async () => {
    const dismissTrialGuide = vi.fn()
    const onSubmit = vi.fn()
    const trialTemplates = Array.from({ length: 4 }, (_, index) => ({
      name: `Scenario ${index + 1}`,
      path: `scenario-${index + 1}`,
      description: `Prompt ${index + 1}`,
    }))

    render(
      <ControlledChatInput
        variant="desktop"
        onSubmit={onSubmit}
        projectChat={projectChatControls({
          trialPluginName: 'Documents',
          trialPluginApp: {
            id: 'plugin:documents',
            name: 'Documents',
            pluginKey: 'documents',
            logoUrl: 'https://example.com/documents.png',
          },
          trialTemplates,
          dismissTrialGuide,
        })}
      />
    )

    expect(screen.getByTestId('plugin-trial-template-strip')).toBeInTheDocument()
    expect(screen.getByText('Documents 可以这样用')).toBeInTheDocument()
    expect(screen.getByTestId('plugin-trial-plugin-icon').querySelector('img')).toHaveAttribute(
      'src',
      'https://example.com/documents.png'
    )
    expect(screen.getByTestId('plugin-trial-recommendation-title')).toHaveTextContent('Scenario 1')
    expect(screen.getAllByTestId('plugin-trial-template-card')).toHaveLength(2)
    expect(screen.queryByText('Scenario 4')).not.toBeInTheDocument()

    await userEvent.click(screen.getByTestId('plugin-trial-other-tasks-toggle'))

    expect(screen.getAllByTestId('plugin-trial-template-card')).toHaveLength(3)
    expect(screen.getByText('Scenario 4')).toBeInTheDocument()

    await userEvent.click(screen.getByText('Scenario 4'))
    expect(
      (screen.getByTestId('chat-message-input') as HTMLElement & { value: string }).value
    ).toBe('Prompt 4 ')

    await userEvent.click(screen.getByTestId('plugin-trial-recommendation-apply'))
    expect(
      (screen.getByTestId('chat-message-input') as HTMLElement & { value: string }).value
    ).toBe('Prompt 1 ')
    expect(onSubmit).not.toHaveBeenCalled()

    await userEvent.click(screen.getByTestId('plugin-trial-template-dismiss'))
    expect(dismissTrialGuide).toHaveBeenCalledOnce()
  })

  test('places the caret after the task text when applying a plugin suggestion', async () => {
    const template = {
      name: 'Checkout flow',
      path: 'checkout-flow',
      description: 'Test my checkout flow on localhost',
    }
    const pluginReference = '[$Browser](plugin://browser@openai-bundled)'

    function Harness() {
      const [value, setValue] = useState(`${pluginReference} `)
      return (
        <ChatInput
          value={value}
          onChange={setValue}
          onSubmit={vi.fn()}
          disabled={false}
          variant="desktop"
          projectChat={projectChatControls({
            trialPluginName: 'Browser',
            trialTemplates: [template],
          })}
        />
      )
    }

    render(<Harness />)
    await userEvent.click(screen.getByTestId('plugin-trial-recommendation-apply'))

    const editor = screen.getByTestId('chat-message-input') as HTMLElement & { value: string }
    await waitFor(() => {
      expect(editor.value).toBe(`${pluginReference} ${template.description} `)
      expect(editor).toHaveFocus()
    })

    const trailingText = editor.querySelector('p')?.lastChild
    expect(trailingText?.textContent).toBe(`${template.description} `)
    expect(window.getSelection()?.anchorNode).toBe(trailingText)
    expect(window.getSelection()?.anchorOffset).toBe(trailingText?.textContent?.length)
  })
})
