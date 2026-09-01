// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import '@testing-library/jest-dom'
import React from 'react'
import { createPortal } from 'react-dom'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { MobileChatInputControlsProps } from '@/features/tasks/components/input/MobileChatInputControls'
import { MobileChatInputControls } from '@/features/tasks/components/input/MobileChatInputControls'
import type { Team } from '@/types/api'

const mockMobileModelSelector = jest.fn(
  ({
    selectedTeam: modelTeam,
    modelCategoryType,
  }: {
    selectedTeam?: Team | null
    modelCategoryType?: 'llm' | 'image' | 'video'
  }) => (
    <button
      type="button"
      data-testid={
        modelCategoryType === 'video' ? 'mobile-video-model-selector' : 'mobile-model-selector'
      }
      data-team-id={modelTeam?.id}
      data-model-category={modelCategoryType ?? 'llm'}
    >
      官网:kimi-k2.5-preview-with-a-very-long-model-name
    </button>
  )
)

jest.mock('@/features/tasks/components/selector/MobileModelSelector', () => ({
  __esModule: true,
  default: (props: { selectedTeam?: Team | null; modelCategoryType?: 'llm' | 'image' | 'video' }) =>
    mockMobileModelSelector(props),
}))

jest.mock('@/features/tasks/components/selector/VideoSettingsPopover', () => ({
  __esModule: true,
  default: ({ showDuration }: { showDuration?: boolean }) => (
    <button
      type="button"
      data-testid="mobile-video-settings"
      data-show-duration={showDuration === false ? 'false' : 'true'}
    />
  ),
}))

jest.mock('@/features/tasks/components/selector/MobileRepositorySelector', () => ({
  __esModule: true,
  default: () => <button type="button">Repository</button>,
}))

jest.mock('@/features/tasks/components/selector/MobileBranchSelector', () => ({
  __esModule: true,
  default: () => <button type="button">Branch</button>,
}))

jest.mock('@/features/tasks/components/clarification/MobileClarificationToggle', () => ({
  __esModule: true,
  default: () => <button type="button">Clarification</button>,
}))

jest.mock('@/features/tasks/components/MobileCorrectionModeToggle', () => ({
  __esModule: true,
  default: () => <button type="button">Correction</button>,
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
          aria-controls="context-selector-popover"
          onClick={() => {
            setOpen(true)
            onSelectorOpenChange?.(true)
          }}
        >
          Context
        </button>
        {open
          ? createPortal(
              <div id="context-selector-popover" role="dialog" data-testid="owned-context-popover">
                Context selector
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

jest.mock('@/components/ui/dropdown', () => ({
  DropdownMenu: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DropdownMenuTrigger: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DropdownMenuContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DropdownMenuSeparator: () => <div data-testid="dropdown-separator" />,
}))

jest.mock('@/features/tasks/components/selector/SkillSelectorPopover', () => ({
  __esModule: true,
  default: () => <button type="button">Skills</button>,
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

const buildProps = (): MobileChatInputControlsProps => ({
  taskType: 'chat',
  selectedTeam,
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
  it('shows only video controls for workflow-managed video chat', async () => {
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

    await waitFor(() => {
      expect(screen.getByTestId('mobile-video-model-selector')).toBeInTheDocument()
      expect(screen.queryByTestId('mobile-model-selector')).not.toBeInTheDocument()
    })
    expect(screen.getByTestId('mobile-video-model-selector')).toHaveAttribute(
      'data-team-id',
      String(selectedTeam.id)
    )
    expect(screen.getByTestId('mobile-video-model-selector')).toHaveAttribute(
      'data-model-category',
      'video'
    )

    fireEvent.click(screen.getByTestId('mobile-input-more-actions-button'))
    expect(screen.getByTestId('mobile-video-settings')).toHaveAttribute(
      'data-show-duration',
      'false'
    )
  })

  it('hides workflow-owned mobile video controls through hiddenVideoParams', async () => {
    render(
      <MobileChatInputControls
        {...buildProps()}
        selectedTeam={{
          ...selectedTeam,
          mode_spec: {
            allowedModelCategories: ['video'],
            hiddenVideoParams: ['duration', 'model', 'resolution', 'ratio'],
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

    await waitFor(() => {
      expect(screen.queryByTestId('mobile-video-model-selector')).not.toBeInTheDocument()
      expect(screen.queryByTestId('mobile-model-selector')).not.toBeInTheDocument()
    })

    fireEvent.click(screen.getByTestId('mobile-input-more-actions-button'))
    expect(screen.queryByTestId('mobile-video-settings')).not.toBeInTheDocument()
  })

  it('hides more actions when the workflow exposes no mobile actions', () => {
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

    expect(screen.queryByTestId('mobile-input-more-actions-button')).not.toBeInTheDocument()
    expect(screen.queryByTestId('mobile-input-more-actions-menu')).not.toBeInTheDocument()
    expect(screen.getByTestId('send-button')).toBeInTheDocument()
  })

  it('keeps long selector labels clipped without clipping the overflow menu', async () => {
    render(<MobileChatInputControls {...buildProps()} />)

    const moreActionsButton = screen.getByRole('button', { name: 'More actions' })
    moreActionsButton.getBoundingClientRect = jest.fn(
      () =>
        ({
          left: 32,
          top: 420,
          right: 64,
          bottom: 452,
          width: 32,
          height: 32,
          x: 32,
          y: 420,
          toJSON: () => {},
        }) as DOMRect
    )

    fireEvent.click(moreActionsButton)

    const sendSlot = screen.getByTestId('send-button').parentElement
    const rightControls = sendSlot?.parentElement
    const modelSlot = screen.getByTestId('mobile-model-selector').parentElement
    const root = rightControls?.parentElement

    expect(root).toHaveClass('min-w-0')
    expect(root).not.toHaveClass('overflow-hidden')
    expect(rightControls).toHaveClass('flex-1')
    expect(rightControls).toHaveClass('min-w-0')
    expect(rightControls).toHaveClass('overflow-hidden')
    expect(rightControls).toHaveClass('justify-end')
    expect(modelSlot).toHaveClass('flex-1')
    expect(modelSlot).toHaveClass('min-w-0')
    expect(modelSlot).toHaveClass('overflow-hidden')
    expect(sendSlot).toHaveClass('flex-shrink-0')
    expect(screen.getByText('Attach')).toBeInTheDocument()

    const menu = screen.getByTestId('mobile-input-more-actions-menu')
    await waitFor(() => {
      expect(menu).toHaveStyle({
        left: '32px',
        top: '124px',
        maxHeight: '288px',
      })
    })
    expect(menu).toHaveClass('fixed')
    expect(menu).toHaveClass('overflow-y-auto')
    expect(menu).toHaveClass('overscroll-contain')
  })

  it('closes the more actions menu after selecting an attachment', () => {
    const props = buildProps()
    render(<MobileChatInputControls {...props} />)

    fireEvent.click(screen.getByTestId('mobile-input-more-actions-button'))
    fireEvent.click(screen.getByRole('button', { name: 'Attach' }))

    expect(props.onFileSelect).toHaveBeenCalledWith([expect.any(File)])
    expect(screen.queryByTestId('mobile-input-more-actions-menu')).not.toBeInTheDocument()
  })

  it('closes the more actions menu when tapping outside', () => {
    render(<MobileChatInputControls {...buildProps()} />)

    fireEvent.click(screen.getByTestId('mobile-input-more-actions-button'))
    fireEvent.pointerDown(document.body)

    expect(screen.queryByTestId('mobile-input-more-actions-menu')).not.toBeInTheDocument()
  })

  it('closes the more actions menu when pressing Escape', () => {
    render(<MobileChatInputControls {...buildProps()} />)

    fireEvent.click(screen.getByTestId('mobile-input-more-actions-button'))
    fireEvent.keyDown(document, { key: 'Escape' })

    expect(screen.queryByTestId('mobile-input-more-actions-menu')).not.toBeInTheDocument()
  })

  it('hides the more actions menu while keeping its context selector mounted', () => {
    render(<MobileChatInputControls {...buildProps()} />)

    fireEvent.click(screen.getByTestId('mobile-input-more-actions-button'))
    fireEvent.click(screen.getByRole('button', { name: 'Context' }))

    const menu = screen.getByTestId('mobile-input-more-actions-menu')
    expect(menu).toHaveClass('invisible')
    expect(menu).toHaveClass('pointer-events-none')
    expect(screen.getByTestId('owned-context-popover')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Close context' }))

    expect(screen.queryByTestId('mobile-input-more-actions-menu')).not.toBeInTheDocument()
    expect(screen.queryByTestId('owned-context-popover')).not.toBeInTheDocument()
    expect(screen.getByTestId('mobile-input-more-actions-button')).toHaveFocus()
  })

  it('closes the menu when interacting with an unrelated dialog', () => {
    render(
      <>
        <MobileChatInputControls {...buildProps()} />
        <div role="dialog" data-testid="unrelated-dialog" />
      </>
    )

    fireEvent.click(screen.getByTestId('mobile-input-more-actions-button'))
    fireEvent.pointerDown(screen.getByTestId('unrelated-dialog'))

    expect(screen.queryByTestId('mobile-input-more-actions-menu')).not.toBeInTheDocument()
  })
})
