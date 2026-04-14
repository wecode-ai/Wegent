// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import '@testing-library/jest-dom'
import { render, screen } from '@testing-library/react'
import type { ChatInputControlsProps } from '@/features/tasks/components/input/ChatInputControls'
import { ChatInputControls } from '@/features/tasks/components/input/ChatInputControls'

jest.mock('@/features/layout/hooks/useMediaQuery', () => ({
  useIsMobile: () => false,
}))

jest.mock('@/features/tasks/components/chat/ChatContextInput', () => ({
  __esModule: true,
  default: () => <div data-testid="chat-context-input" />,
}))

jest.mock('@/features/tasks/service/attachmentService', () => ({
  supportsAttachments: () => false,
}))

jest.mock('@/features/tasks/components/selector/ModelSelector', () => ({
  __esModule: true,
  default: () => <div data-testid="model-selector" />,
}))

jest.mock('@/features/tasks/components/selector/TeamSelectorButton', () => ({
  __esModule: true,
  default: () => <div data-testid="team-selector" />,
}))

jest.mock('@/features/tasks/components/selector/UnifiedRepositorySelector', () => ({
  __esModule: true,
  default: () => <div data-testid="repo-selector" />,
}))

jest.mock('@/features/tasks/components/clarification/ClarificationToggle', () => ({
  __esModule: true,
  default: () => <div data-testid="clarification-toggle" />,
}))

jest.mock('@/features/tasks/components/CorrectionModeToggle', () => ({
  __esModule: true,
  default: () => <div data-testid="correction-toggle" />,
}))

jest.mock('@/features/tasks/components/AttachmentButton', () => ({
  __esModule: true,
  default: () => <div data-testid="attachment-button" />,
}))

jest.mock('@/features/tasks/components/input/SendButton', () => ({
  __esModule: true,
  default: () => <button type="button">Send</button>,
}))

jest.mock('@/components/ui/action-button', () => ({
  __esModule: true,
  ActionButton: ({ title }: { title?: string }) => (
    <button type="button">{title || 'Action'}</button>
  ),
}))

jest.mock('@/features/tasks/components/message/LoadingDots', () => ({
  __esModule: true,
  default: () => <div data-testid="loading-dots" />,
}))

jest.mock('@/features/tasks/components/params/QuotaUsage', () => ({
  __esModule: true,
  default: () => <div data-testid="quota-usage" />,
}))

jest.mock('@/features/tasks/components/input/MobileChatInputControls', () => ({
  __esModule: true,
  MobileChatInputControls: () => <div data-testid="mobile-controls" />,
}))

jest.mock('@/features/tasks/components/selector/SkillSelectorPopover', () => ({
  __esModule: true,
  default: () => <div data-testid="skill-selector" />,
}))

jest.mock('@/features/tasks/components/selector', () => ({
  __esModule: true,
  ImageSizeSelector: () => <div data-testid="image-size-selector" />,
  GenerateModeSelector: () => <div data-testid="generate-mode-selector" />,
  VideoSettingsPopover: () => <div data-testid="video-settings-popover" />,
  isGenerateMode: () => false,
}))

function createProps(): ChatInputControlsProps {
  return {
    taskType: 'chat',
    selectedTeam: null,
    teams: [],
    selectedModel: null,
    setSelectedModel: jest.fn(),
    forceOverride: false,
    setForceOverride: jest.fn(),
    showRepositorySelector: false,
    selectedRepo: null,
    setSelectedRepo: jest.fn(),
    selectedBranch: null,
    setSelectedBranch: jest.fn(),
    selectedTaskDetail: null,
    enableDeepThinking: true,
    setEnableDeepThinking: jest.fn(),
    enableClarification: false,
    setEnableClarification: jest.fn(),
    selectedContexts: [],
    setSelectedContexts: jest.fn(),
    attachmentState: {
      attachments: [],
      uploadingFiles: new Map(),
      errors: new Map(),
    },
    onFileSelect: jest.fn(),
    onAttachmentRemove: jest.fn(),
    isLoading: false,
    isStreaming: false,
    isStopping: false,
    hasMessages: false,
    shouldCollapseSelectors: false,
    shouldHideQuotaUsage: true,
    shouldHideChatInput: false,
    isModelSelectionRequired: false,
    isAttachmentReadyToSend: true,
    taskInputMessage: 'hello',
    isSubtaskStreaming: false,
    onStopStream: jest.fn(),
    onSendMessage: jest.fn(),
  }
}

describe('ChatInputControls send state', () => {
  it('shows stop action while waiting for stream start after send', () => {
    render(
      <ChatInputControls
        {...createProps()}
        {...({ isAwaitingResponseStart: true } as Partial<ChatInputControlsProps>)}
      />
    )

    expect(screen.getByRole('button', { name: 'Stop generating' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Send' })).not.toBeInTheDocument()
  })
})
