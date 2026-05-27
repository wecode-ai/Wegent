// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import '@testing-library/jest-dom'
import { fireEvent, render, screen } from '@testing-library/react'

import {
  ChatInputControls,
  type ChatInputControlsProps,
} from '@/features/tasks/components/input/ChatInputControls'
import type { Team } from '@/types/api'

const routerPush = jest.fn()

jest.mock('next/navigation', () => ({
  useRouter: () => ({
    push: routerPush,
  }),
}))

jest.mock('@/features/layout/hooks/useMediaQuery', () => ({
  useIsMobile: () => false,
}))

jest.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => ({
    t: (_key: string, fallback?: string | Record<string, unknown>) =>
      typeof fallback === 'string' ? fallback : _key,
  }),
}))

jest.mock('@/components/ui/tooltip', () => ({
  TooltipProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}))

jest.mock('@/features/tasks/components/selector/ModelSelector', () => ({
  __esModule: true,
  default: () => <div data-testid="model-selector" />,
}))

jest.mock('@/features/tasks/components/selector/UnifiedRepositorySelector', () => ({
  __esModule: true,
  default: () => <div data-testid="repo-selector" />,
}))

jest.mock('@/features/tasks/components/chat/ChatContextInput', () => ({
  __esModule: true,
  default: ({ iconOnly }: { iconOnly?: boolean }) => (
    <button
      type="button"
      data-testid="chat-context-input"
      data-icon-only={iconOnly ? 'true' : 'false'}
    >
      Context
    </button>
  ),
}))

jest.mock('@/features/tasks/components/AttachmentButton', () => ({
  __esModule: true,
  default: () => <button type="button" data-testid="attachment-button" />,
}))

jest.mock('@/features/tasks/components/selector/TeamSelectorButton', () => ({
  __esModule: true,
  default: () => <button type="button" data-testid="team-selector" />,
}))

jest.mock('@/features/tasks/components/selector/SkillSelectorPopover', () => ({
  __esModule: true,
  default: () => <button type="button" data-testid="skill-selector" />,
}))

jest.mock('@/features/tasks/components/clarification/ClarificationToggle', () => ({
  __esModule: true,
  default: () => <button type="button" data-testid="clarification-toggle" />,
}))

jest.mock('@/features/tasks/components/CorrectionModeToggle', () => ({
  __esModule: true,
  default: () => <button type="button" data-testid="correction-toggle" />,
}))

jest.mock('@/features/tasks/components/input/SendButton', () => ({
  __esModule: true,
  default: () => <button type="button">Send</button>,
}))

jest.mock('@/features/tasks/components/message/LoadingDots', () => ({
  __esModule: true,
  default: () => <div data-testid="loading-dots" />,
}))

jest.mock('@/features/tasks/components/params/QuotaUsage', () => ({
  __esModule: true,
  default: () => <div data-testid="quota-usage" />,
}))

jest.mock('@/features/tasks/components/selector', () => ({
  __esModule: true,
  ImageSizeSelector: () => <div data-testid="image-size-selector" />,
  GenerateModeSelector: () => <div data-testid="generate-mode-selector" />,
  VideoSettingsPopover: () => <div data-testid="video-settings-popover" />,
  isGenerateMode: () => false,
}))

const selectedTeam: Team = {
  id: 1,
  name: 'assistant',
  displayName: '智能助理',
  description: '',
  bots: [],
  workflow: {},
  is_active: true,
  user_id: 1,
  created_at: '',
  updated_at: '',
  agent_type: 'chat',
  bind_mode: ['chat'],
}

function createProps(): ChatInputControlsProps {
  return {
    taskType: 'chat',
    selectedTeam,
    teams: [selectedTeam],
    onTeamChange: jest.fn(),
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
    enableDeepThinking: false,
    setEnableDeepThinking: jest.fn(),
    enableClarification: false,
    setEnableClarification: jest.fn(),
    enableCorrectionMode: false,
    correctionModelName: null,
    onCorrectionModeToggle: jest.fn(),
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
    availableSkills: [
      {
        id: 1,
        name: 'research',
        displayName: 'Research',
        description: '',
        namespace: 'default',
        is_public: false,
        is_active: true,
        user_id: 1,
      },
    ],
    teamSkillNames: [],
    preloadedSkillNames: [],
    selectedSkillNames: [],
    onToggleSkill: jest.fn(),
  }
}

describe('ChatInputControls toolbar actions', () => {
  beforeEach(() => {
    routerPush.mockClear()
  })

  it('adds an icon-only code entry on the left that navigates to code mode', () => {
    render(<ChatInputControls {...createProps()} />)

    const leftActions = screen.getByTestId('input-left-actions')
    const codeButton = screen.getByTestId('code-mode-button')

    expect(leftActions).toContainElement(codeButton)

    fireEvent.click(codeButton)

    expect(routerPush).toHaveBeenCalledWith('/code')
  })

  it('combines agent and skill selectors behind one visible desktop action', () => {
    render(<ChatInputControls {...createProps()} />)

    expect(screen.getByTestId('agent-skill-selector-button')).toBeInTheDocument()
    expect(screen.queryByTestId('team-selector')).not.toBeInTheDocument()
    expect(screen.queryByTestId('skill-selector')).not.toBeInTheDocument()
  })

  it('keeps knowledge visible as an icon action and moves clarification/correction into more actions', () => {
    render(<ChatInputControls {...createProps()} />)

    const rightActions = screen.getByTestId('input-right-actions')
    const knowledgeButton = screen.getByTestId('chat-context-input')
    const moreButton = screen.getByTestId('desktop-input-more-actions-button')

    expect(rightActions).toContainElement(knowledgeButton)
    expect(knowledgeButton).toHaveAttribute('data-icon-only', 'true')
    expect(screen.queryByTestId('clarification-toggle')).not.toBeInTheDocument()
    expect(screen.queryByTestId('correction-toggle')).not.toBeInTheDocument()

    fireEvent.click(moreButton)

    expect(screen.getByTestId('desktop-input-more-actions-menu')).toBeInTheDocument()
    expect(screen.getByTestId('clarification-toggle')).toBeInTheDocument()
    expect(screen.getByTestId('correction-toggle')).toBeInTheDocument()
  })
})
