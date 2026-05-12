// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import '@testing-library/jest-dom'
import { fireEvent, render, screen } from '@testing-library/react'
import type { MobileChatInputControlsProps } from '@/features/tasks/components/input/MobileChatInputControls'
import { MobileChatInputControls } from '@/features/tasks/components/input/MobileChatInputControls'
import type { Team } from '@/types/api'

jest.mock('@/features/tasks/components/selector/MobileModelSelector', () => ({
  __esModule: true,
  default: () => (
    <button type="button" data-testid="mobile-model-selector">
      官网:kimi-k2.5-preview-with-a-very-long-model-name
    </button>
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
  default: () => <button type="button">Context</button>,
}))

jest.mock('@/features/tasks/components/AttachmentButton', () => ({
  __esModule: true,
  default: () => <button type="button">Attach</button>,
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

jest.mock('@/components/ui/button', () => ({
  Button: ({
    children,
    className,
    disabled,
    ...props
  }: {
    children: React.ReactNode
    className?: string
    disabled?: boolean
    [key: string]: unknown
  }) => (
    <button type="button" className={className} disabled={disabled} {...props}>
      {children}
    </button>
  ),
}))

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
  isLoading: false,
  isStreaming: false,
  isStopping: false,
  hasMessages: false,
  shouldHideChatInput: false,
  isModelSelectionRequired: false,
  isAttachmentReadyToSend: true,
  taskInputMessage: 'hello',
  isSubtaskStreaming: false,
  onStopStream: jest.fn(),
  onSendMessage: jest.fn(),
})

describe('MobileChatInputControls layout', () => {
  it('keeps long selector labels clipped without clipping the overflow menu', () => {
    render(<MobileChatInputControls {...buildProps()} />)

    fireEvent.click(screen.getByRole('button', { name: 'More actions' }))

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
  })
})
