// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import '@testing-library/jest-dom'
import React from 'react'
import { createPortal } from 'react-dom'
import { fireEvent, render, screen } from '@testing-library/react'
import type { MobileChatInputControlsProps } from '@/features/tasks/components/input/MobileChatInputControls'
import { MobileChatInputControls } from '@/features/tasks/components/input/MobileChatInputControls'
import type { UnifiedSkill } from '@/apis/skills'
import type { Team } from '@/types/api'

jest.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => ({
    t: (key: string, options?: { count?: number }) =>
      typeof options?.count === 'number' ? `${options.count} skills` : key,
  }),
}))

const mockMobileModelSelector = jest.fn(
  ({
    disabled,
    modelCategoryType,
    triggerVariant,
  }: {
    disabled?: boolean
    modelCategoryType?: 'llm' | 'image' | 'video'
    triggerVariant?: string
  }) => (
    <button
      type="button"
      data-testid={
        modelCategoryType === 'video'
          ? 'mobile-video-model-selector'
          : modelCategoryType === 'image'
            ? 'mobile-image-model-selector'
            : 'mobile-model-selector'
      }
      data-disabled={disabled ? 'true' : 'false'}
      data-trigger-variant={triggerVariant}
    >
      Model
    </button>
  )
)

const mockMobileTeamSelector = jest.fn(
  ({
    disabled,
    triggerVariant,
    onClear,
    showClearButton,
  }: {
    disabled?: boolean
    triggerVariant?: string
    onClear?: () => void
    showClearButton?: boolean
  }) => (
    <div>
      <button
        type="button"
        data-testid="mobile-team-selector"
        data-disabled={disabled ? 'true' : 'false'}
        data-trigger-variant={triggerVariant}
      >
        Agent
      </button>
      {showClearButton && onClear && (
        <button type="button" data-testid="mobile-team-selector-clear" onClick={onClear}>
          Clear agent
        </button>
      )}
    </div>
  )
)

const mockMobileSkillSelector = jest.fn(
  ({
    readOnly,
    open,
    hideTrigger,
  }: {
    readOnly?: boolean
    open?: boolean
    hideTrigger?: boolean
  }) =>
    open ? (
      <div
        data-testid="mobile-skill-drawer"
        data-read-only={readOnly ? 'true' : 'false'}
        data-hide-trigger={hideTrigger ? 'true' : 'false'}
      />
    ) : null
)

jest.mock('@/features/tasks/components/selector/MobileModelSelector', () => ({
  __esModule: true,
  default: (props: {
    disabled?: boolean
    modelCategoryType?: 'llm' | 'image' | 'video'
    triggerVariant?: string
  }) => mockMobileModelSelector(props),
}))

jest.mock('@/features/tasks/components/selector/MobileTeamSelector', () => ({
  __esModule: true,
  default: (props: {
    disabled?: boolean
    triggerVariant?: string
    onClear?: () => void
    showClearButton?: boolean
  }) => mockMobileTeamSelector(props),
}))

jest.mock('@/features/tasks/components/selector/MobileSkillSelector', () => ({
  __esModule: true,
  default: (props: { readOnly?: boolean; open?: boolean; hideTrigger?: boolean }) =>
    mockMobileSkillSelector(props),
}))

jest.mock('@/features/tasks/components/selector/VideoSettingsPopover', () => ({
  __esModule: true,
  default: ({
    showDuration,
    hiddenVideoParams,
  }: {
    showDuration?: boolean
    hiddenVideoParams?: string[]
  }) => (
    <button
      type="button"
      data-testid="mobile-video-settings"
      data-show-duration={showDuration === false ? 'false' : 'true'}
      data-hidden-video-params={hiddenVideoParams?.join(',')}
    />
  ),
}))

jest.mock('@/features/tasks/components/selector/MobileRepositorySelector', () => ({
  __esModule: true,
  default: () => <button type="button">Repository</button>,
}))

jest.mock('@/features/tasks/components/clarification/MobileClarificationToggle', () => ({
  __esModule: true,
  default: () => <button type="button">Clarification</button>,
}))

jest.mock('@/features/tasks/components/MobileCorrectionModeToggle', () => ({
  __esModule: true,
  default: function MockMobileCorrectionModeToggle({
    onSelectorOpenChange,
  }: {
    onSelectorOpenChange?: (open: boolean) => void
  }) {
    const [open, setOpen] = React.useState(false)
    return (
      <>
        <button
          type="button"
          onClick={() => {
            setOpen(true)
            onSelectorOpenChange?.(true)
          }}
        >
          Correction
        </button>
        {open
          ? createPortal(
              <div role="dialog" data-testid="owned-correction-model-drawer">
                <button
                  type="button"
                  onClick={() => {
                    setOpen(false)
                    onSelectorOpenChange?.(false)
                  }}
                >
                  Close correction
                </button>
              </div>,
              document.body
            )
          : null}
      </>
    )
  },
}))

jest.mock('@/features/tasks/components/chat/ChatContextInput', () => ({
  __esModule: true,
  default: function MockChatContextInput({
    onSelectorOpenChange,
  }: {
    onSelectorOpenChange?: (open: boolean) => void
  }) {
    const [open, setOpen] = React.useState(false)
    return (
      <>
        <button
          type="button"
          onClick={() => {
            setOpen(true)
            onSelectorOpenChange?.(true)
          }}
        >
          Context
        </button>
        {open
          ? createPortal(
              <div role="dialog" data-testid="owned-context-selector">
                <button
                  type="button"
                  onClick={() => {
                    setOpen(false)
                    onSelectorOpenChange?.(false)
                  }}
                >
                  Close context
                </button>
              </div>,
              document.body
            )
          : null}
      </>
    )
  },
}))

jest.mock('@/features/tasks/components/AttachmentButton', () => ({
  __esModule: true,
  default: ({ onFileSelect }: { onFileSelect: (files: File[]) => void }) => (
    <button type="button" onClick={() => onFileSelect([new File(['content'], 'test.txt')])}>
      Attach
    </button>
  ),
}))

jest.mock('@/features/tasks/components/input/SendButton', () => ({
  __esModule: true,
  default: () => (
    <button type="button" data-testid="send-button">
      Send
    </button>
  ),
}))

jest.mock('@/features/tasks/components/message/LoadingDots', () => ({
  __esModule: true,
  default: () => <div data-testid="loading-dots" />,
}))

jest.mock('@/components/ui/action-button', () => ({
  ActionButton: ({ title }: { title?: string }) => (
    <button type="button">{title || 'Action'}</button>
  ),
}))

jest.mock('@/components/ui/button', () => {
  const MockButton = React.forwardRef<
    HTMLButtonElement,
    React.ButtonHTMLAttributes<HTMLButtonElement>
  >(({ children, className, disabled, ...props }, ref) => (
    <button ref={ref} type="button" className={className} disabled={disabled} {...props}>
      {children}
    </button>
  ))
  MockButton.displayName = 'MockButton'

  return { Button: MockButton }
})

jest.mock('@/components/ui/drawer', () => ({
  Drawer: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  DrawerContent: ({
    children,
    showHandle: _showHandle,
    ...props
  }: React.HTMLAttributes<HTMLDivElement> & { showHandle?: boolean }) => (
    <div {...props}>{children}</div>
  ),
  DrawerDescription: (props: React.HTMLAttributes<HTMLParagraphElement>) => <p {...props} />,
  DrawerTitle: (props: React.HTMLAttributes<HTMLHeadingElement>) => <h2 {...props} />,
}))

const selectedTeam: Team = {
  id: 1,
  name: 'wegent-assistant',
  displayName: 'Wegent智能助理',
  description: '',
  bots: [],
  workflow: {},
  is_active: true,
  user_id: 1,
  created_at: '',
  updated_at: '',
  agent_type: 'chat',
}

const availableSkill: UnifiedSkill = {
  id: 1,
  name: 'planning',
  namespace: 'default',
  displayName: 'Planning',
  description: '',
  is_active: true,
  is_public: false,
  user_id: 1,
}

const buildProps = (): MobileChatInputControlsProps => ({
  taskType: 'chat',
  selectedTeam,
  teams: [selectedTeam],
  onTeamChange: jest.fn(),
  selectedModel: {
    name: '官网:kimi-k2.5-preview-with-a-very-long-model-name',
    provider: 'moonshot',
    modelId: 'kimi-k2.5-preview-with-a-very-long-model-name',
    type: 'user',
  },
  setSelectedModel: jest.fn(),
  forceOverride: false,
  setForceOverride: jest.fn(),
  showRepositorySelector: false,
  selectedRepo: null,
  setSelectedRepo: jest.fn(),
  selectedBranch: null,
  setSelectedBranch: jest.fn(),
  selectedTaskDetail: null,
  enableClarification: false,
  setEnableClarification: jest.fn(),
  selectedContexts: [],
  setSelectedContexts: jest.fn(),
  onFileSelect: jest.fn(),
  isStreaming: false,
  isStopping: false,
  hasMessages: false,
  shouldHideChatInput: false,
  isModelSelectionRequired: false,
  isAttachmentReadyToSend: true,
  taskInputMessage: 'hello',
  onStopStream: jest.fn(),
  onSendMessage: jest.fn(),
})

describe('MobileChatInputControls layout', () => {
  beforeEach(() => {
    mockMobileModelSelector.mockClear()
    mockMobileTeamSelector.mockClear()
    mockMobileSkillSelector.mockClear()
  })

  it('uses plus, agent, model, and send as separate primary entries', () => {
    render(<MobileChatInputControls {...buildProps()} />)

    expect(screen.getByTestId('mobile-input-more-actions-button')).toHaveClass('h-11', 'w-11')
    expect(screen.getByTestId('mobile-team-selector-slot')).toContainElement(
      screen.getByTestId('mobile-team-selector')
    )
    expect(screen.getByTestId('mobile-model-selector-slot')).toContainElement(
      screen.getByTestId('mobile-model-selector')
    )
    expect(screen.getByTestId('mobile-team-selector')).toHaveAttribute(
      'data-trigger-variant',
      'compact'
    )
    expect(screen.getByTestId('mobile-model-selector')).toHaveAttribute(
      'data-trigger-variant',
      'compact'
    )
    expect(screen.getByTestId('send-button')).toBeInTheDocument()
    expect(screen.queryByTestId('mobile-chat-configuration-trigger')).not.toBeInTheDocument()
  })

  it('keeps model selection outside the more drawer', () => {
    render(<MobileChatInputControls {...buildProps()} />)

    fireEvent.click(screen.getByTestId('mobile-input-more-actions-button'))

    const moreDrawer = screen.getByTestId('mobile-input-more-actions-menu')
    expect(moreDrawer).toBeInTheDocument()
    expect(moreDrawer).toHaveClass('max-h-[85vh]', 'bg-[#f2f2f7]')
    expect(moreDrawer).not.toHaveClass('max-w-[430px]')
    expect(screen.getByText('Attach')).toBeInTheDocument()
    expect(screen.getByText('Context')).toBeInTheDocument()
    expect(moreDrawer).not.toContainElement(screen.getByTestId('mobile-model-selector'))
  })

  it('clears the selected agent from the compact control', () => {
    const onClearTeam = jest.fn()

    render(
      <MobileChatInputControls {...buildProps()} onClearTeam={onClearTeam} showClearTeamButton />
    )

    fireEvent.click(screen.getByTestId('mobile-team-selector-clear'))

    expect(onClearTeam).toHaveBeenCalledTimes(1)
  })

  it('closes more before opening the standalone skill drawer', () => {
    render(
      <MobileChatInputControls
        {...buildProps()}
        availableSkills={[availableSkill]}
        onToggleSkill={jest.fn()}
      />
    )

    fireEvent.click(screen.getByTestId('mobile-input-more-actions-button'))
    const skillButton = screen.getByTestId('mobile-more-skills-button')
    expect(skillButton.querySelector('svg')).toHaveClass('h-4', 'w-4')
    expect(skillButton.querySelector('.h-10.w-10')).not.toBeInTheDocument()
    fireEvent.click(skillButton)

    expect(screen.queryByTestId('mobile-input-more-actions-menu')).not.toBeInTheDocument()
    expect(screen.getByTestId('mobile-skill-drawer')).toHaveAttribute('data-hide-trigger', 'true')
  })

  it('locks agent and skills after the conversation starts', () => {
    render(
      <MobileChatInputControls
        {...buildProps()}
        hasMessages
        availableSkills={[availableSkill]}
        onToggleSkill={jest.fn()}
      />
    )

    expect(screen.getByTestId('mobile-team-selector')).toHaveAttribute('data-disabled', 'true')

    fireEvent.click(screen.getByTestId('mobile-input-more-actions-button'))
    fireEvent.click(screen.getByTestId('mobile-more-skills-button'))
    expect(screen.getByTestId('mobile-skill-drawer')).toHaveAttribute('data-read-only', 'true')
  })

  it('closes the content drawer after selecting an attachment', () => {
    const props = buildProps()
    render(<MobileChatInputControls {...props} />)

    fireEvent.click(screen.getByTestId('mobile-input-more-actions-button'))
    fireEvent.click(screen.getByRole('button', { name: 'Attach' }))

    expect(props.onFileSelect).toHaveBeenCalledWith([expect.any(File)])
    expect(screen.queryByTestId('mobile-input-more-actions-menu')).not.toBeInTheDocument()
  })

  it('hides the more drawer while the correction model drawer is open', () => {
    render(<MobileChatInputControls {...buildProps()} onCorrectionModeToggle={jest.fn()} />)

    fireEvent.click(screen.getByTestId('mobile-input-more-actions-button'))
    fireEvent.click(screen.getByRole('button', { name: 'Correction' }))

    const menu = screen.getByTestId('mobile-input-more-actions-menu')
    expect(menu).toHaveClass('invisible', 'pointer-events-none')
    expect(screen.getByTestId('owned-correction-model-drawer')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Close correction' }))

    expect(screen.queryByTestId('mobile-input-more-actions-menu')).not.toBeInTheDocument()
    expect(screen.queryByTestId('owned-correction-model-drawer')).not.toBeInTheDocument()
  })

  it('hides the more drawer while the context selector is open', () => {
    render(<MobileChatInputControls {...buildProps()} />)

    fireEvent.click(screen.getByTestId('mobile-input-more-actions-button'))
    fireEvent.click(screen.getByRole('button', { name: 'Context' }))

    expect(screen.getByTestId('mobile-input-more-actions-menu')).toHaveClass(
      'invisible',
      'pointer-events-none'
    )
    expect(screen.getByTestId('owned-context-selector')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Close context' }))

    expect(screen.queryByTestId('mobile-input-more-actions-menu')).not.toBeInTheDocument()
    expect(screen.queryByTestId('owned-context-selector')).not.toBeInTheDocument()
  })

  it('preserves workflow-managed video controls and settings', () => {
    render(
      <MobileChatInputControls
        {...buildProps()}
        selectedTeam={{
          ...selectedTeam,
          mode_spec: {
            allowedModelCategories: ['video'],
            hiddenVideoParams: ['duration'],
          },
        }}
        showVideoControlsInChat
        selectedVideoModel={null}
        onVideoModelChange={jest.fn()}
        selectedResolution="1080p"
        onResolutionChange={jest.fn()}
        selectedRatio="9:16"
        onRatioChange={jest.fn()}
        selectedDuration={5}
        onDurationChange={jest.fn()}
        hideDurationSelector
      />
    )

    expect(screen.getByTestId('mobile-video-model-selector')).toBeInTheDocument()
    expect(screen.getByTestId('mobile-team-selector-slot')).toContainElement(
      screen.getByTestId('mobile-team-selector')
    )
    expect(screen.queryByTestId('mobile-model-selector-slot')).not.toBeInTheDocument()

    fireEvent.click(screen.getByTestId('mobile-input-more-actions-button'))
    expect(screen.getByTestId('mobile-video-settings')).toHaveAttribute(
      'data-show-duration',
      'false'
    )
    expect(screen.getByTestId('mobile-video-settings')).toHaveAttribute(
      'data-hidden-video-params',
      'duration'
    )
  })

  it('hides workflow-owned mobile video controls', () => {
    render(
      <MobileChatInputControls
        {...buildProps()}
        selectedTeam={{
          ...selectedTeam,
          agent_type: 'dify',
          mode_spec: {
            allowedModelCategories: ['video'],
            hiddenVideoParams: ['duration', 'model', 'resolution', 'ratio'],
          },
        }}
        showVideoControlsInChat
        selectedVideoGenerationMode="first_last_frame"
        selectedVideoModel={null}
        onVideoModelChange={jest.fn()}
        selectedResolution="1080p"
        onResolutionChange={jest.fn()}
        selectedRatio="9:16"
        onRatioChange={jest.fn()}
        selectedDuration={5}
        onDurationChange={jest.fn()}
      />
    )

    expect(screen.queryByTestId('mobile-video-model-selector')).not.toBeInTheDocument()
    expect(screen.queryByTestId('mobile-video-settings')).not.toBeInTheDocument()
    expect(screen.queryByTestId('mobile-input-more-actions-button')).not.toBeInTheDocument()
    expect(screen.getByTestId('send-button')).toBeInTheDocument()
  })

  it('shows the image agent and model selectors in the primary row', () => {
    render(
      <MobileChatInputControls
        {...buildProps()}
        taskType="image"
        selectedImageModel={null}
        onImageModelChange={jest.fn()}
        isImageModelsLoading={false}
      />
    )

    expect(screen.getByTestId('mobile-team-selector-slot')).toContainElement(
      screen.getByTestId('mobile-team-selector')
    )
    expect(screen.getByTestId('mobile-image-model-selector-slot')).toContainElement(
      screen.getByTestId('mobile-image-model-selector')
    )
    expect(screen.getByTestId('mobile-image-model-selector')).toHaveAttribute(
      'data-trigger-variant',
      'compact'
    )
    expect(screen.queryByTestId('mobile-model-selector-slot')).not.toBeInTheDocument()
  })
})
