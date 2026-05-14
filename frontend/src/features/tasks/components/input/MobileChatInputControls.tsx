// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import React, { useMemo, useState } from 'react'
import { CircleStop, Hand, Plus } from 'lucide-react'
import MobileModelSelector from '../selector/MobileModelSelector'
import type { Model } from '../selector/ModelSelector'
import MobileTeamSelector from '../selector/MobileTeamSelector'
import MobileRepositorySelector from '../selector/MobileRepositorySelector'
import MobileBranchSelector from '../selector/MobileBranchSelector'
import MobileClarificationToggle from '../clarification/MobileClarificationToggle'
import MobileCorrectionModeToggle from '../MobileCorrectionModeToggle'
import ChatContextInput from '../chat/ChatContextInput'
import AttachmentButton from '../AttachmentButton'
import SendButton from './SendButton'
import LoadingDots from '../message/LoadingDots'
import { ActionButton } from '@/components/ui/action-button'
import { Button } from '@/components/ui/button'
import type {
  Team,
  GitRepoInfo,
  GitBranch as GitBranchType,
  TaskDetail,
  TaskType,
} from '@/types/api'
import type { ContextItem } from '@/types/context'
import type { UnifiedSkill } from '@/apis/skills'
import {
  canUseChatContexts,
  isChatShell,
  teamRequiresWorkspace,
} from '../../service/messageService'
import { supportsAttachments } from '../../service/attachmentService'
import SkillSelectorPopover from '../selector/SkillSelectorPopover'
import { getChatSendState } from './chatSendState'
import { useTranslation } from '@/hooks/useTranslation'

export interface MobileChatInputControlsProps {
  taskType?: TaskType
  // Team and Model
  selectedTeam: Team | null
  teams?: Team[]
  onTeamChange?: (team: Team) => void
  selectedModel: Model | null
  setSelectedModel: (model: Model | null) => void
  forceOverride: boolean
  setForceOverride: (value: boolean) => void
  teamId?: number | null
  taskId?: number | null
  taskModelId?: string | null
  /** Knowledge base ID to exclude from context selector (used in notebook mode) */
  knowledgeBaseId?: number

  // Repository and Branch
  showRepositorySelector: boolean
  selectedRepo: GitRepoInfo | null
  setSelectedRepo: (repo: GitRepoInfo | null) => void
  selectedBranch: GitBranchType | null
  setSelectedBranch: (branch: GitBranchType | null) => void
  selectedTaskDetail: TaskDetail | null
  /** Effective requires workspace value (considering user override) */
  effectiveRequiresWorkspace?: boolean
  /** Callback when user toggles the requires workspace switch */
  onRequiresWorkspaceChange?: (value: boolean) => void

  // Clarification
  enableClarification: boolean
  setEnableClarification: (value: boolean) => void

  // Correction mode
  enableCorrectionMode?: boolean
  correctionModelName?: string | null
  onCorrectionModeToggle?: (enabled: boolean, modelId?: string, modelName?: string) => void

  // Context selection
  selectedContexts: ContextItem[]
  setSelectedContexts: (contexts: ContextItem[]) => void

  // Attachment
  onFileSelect: (files: File | File[]) => void

  // State flags
  isLoading: boolean
  isStreaming: boolean
  isAwaitingResponseStart?: boolean
  isStopping: boolean
  hasMessages: boolean
  shouldHideChatInput: boolean
  isModelSelectionRequired: boolean
  isAttachmentReadyToSend: boolean
  taskInputMessage: string
  isSubtaskStreaming: boolean
  canQueueMessage?: boolean
  canSendGuidance?: boolean

  // Actions
  onStopStream: () => void
  onSendMessage: () => void
  onSendGuidance?: () => void

  // Whether there are no available teams (shows disabled state)
  hasNoTeams?: boolean

  // Skill selector support
  availableSkills?: UnifiedSkill[]
  teamSkillNames?: string[]
  preloadedSkillNames?: string[]
  selectedSkillNames?: string[]
  onToggleSkill?: (skillName: string) => void

  /** When true, hide all selectors - only show send button */
  hideSelectors?: boolean
}

/**
 * Mobile-specific Chat Input Controls
 * Optimized layout for mobile devices with dropdown menu
 */
export function MobileChatInputControls({
  taskType,
  selectedTeam,
  teams = [],
  onTeamChange,
  selectedModel,
  setSelectedModel,
  forceOverride,
  setForceOverride,
  teamId,
  taskId,
  taskModelId,
  knowledgeBaseId,
  showRepositorySelector,
  selectedRepo,
  setSelectedRepo,
  selectedBranch,
  setSelectedBranch,
  selectedTaskDetail,
  effectiveRequiresWorkspace,
  onRequiresWorkspaceChange: _onRequiresWorkspaceChange,
  enableClarification,
  setEnableClarification,
  enableCorrectionMode = false,
  correctionModelName,
  onCorrectionModeToggle,
  selectedContexts,
  setSelectedContexts,
  onFileSelect,
  isLoading,
  isStreaming,
  isAwaitingResponseStart = false,
  isStopping,
  hasMessages,
  shouldHideChatInput,
  isModelSelectionRequired,
  isAttachmentReadyToSend,
  taskInputMessage,
  isSubtaskStreaming,
  canQueueMessage = false,
  canSendGuidance = false,
  onStopStream,
  onSendMessage,
  onSendGuidance,
  hasNoTeams = false,
  availableSkills = [],
  teamSkillNames = [],
  preloadedSkillNames = [],
  selectedSkillNames = [],
  onToggleSkill,
  hideSelectors,
}: MobileChatInputControlsProps) {
  const { t } = useTranslation('chat')
  const [moreMenuOpen, setMoreMenuOpen] = useState(false)
  const showChatContexts = canUseChatContexts(taskType, selectedTeam)
  const showAttachmentAction = supportsAttachments(selectedTeam)
  const showSkillAction = availableSkills.length > 0 && Boolean(onToggleSkill)
  const currentMode = taskType ?? 'chat'
  const filteredTeams = useMemo(() => {
    return teams
      .filter(team => !(Array.isArray(team.bind_mode) && team.bind_mode.length === 0))
      .filter(team => !team.bind_mode || team.bind_mode.includes(currentMode))
  }, [teams, currentMode])
  const selectedTeamForDisplay = useMemo(() => {
    if (!selectedTeam) return null
    return filteredTeams.find(team => team.id === selectedTeam.id) ?? selectedTeam
  }, [filteredTeams, selectedTeam])
  const canSwitchTeam =
    Boolean(selectedTeamForDisplay) &&
    filteredTeams.length > 0 &&
    Boolean(onTeamChange) &&
    !hasMessages &&
    taskType !== 'image' &&
    taskType !== 'video'
  const showClarificationAction = isChatShell(selectedTeam)
  const showCorrectionAction = isChatShell(selectedTeam) && Boolean(onCorrectionModeToggle)
  const showGuidanceAction = isChatShell(selectedTeam) && Boolean(onSendGuidance)
  const showRepositoryAction =
    showRepositorySelector &&
    teamRequiresWorkspace(selectedTeam) &&
    effectiveRequiresWorkspace !== false
  const showBranchAction = showRepositoryAction && Boolean(selectedRepo)
  const hasSecondaryActions = showAttachmentAction || showChatContexts || showSkillAction

  // Render send button based on state
  const renderSendButton = () => {
    const sendState = getChatSendState({
      isLoading,
      isStreaming,
      isAwaitingResponseStart,
      isStopping,
      isModelSelectionRequired,
      isAttachmentReadyToSend,
      hasNoTeams,
      shouldHideChatInput,
      taskInputMessage,
      selectedTaskStatus: selectedTaskDetail?.status,
      isSubtaskStreaming,
      isGroupChat: selectedTaskDetail?.is_group_chat,
      canQueueMessage,
    })

    const renderStopAction = () => (
      <ActionButton
        onClick={onStopStream}
        title="Stop generating"
        icon={<CircleStop className="h-4 w-4 text-orange-500" />}
        className="hover:bg-orange-100"
      />
    )

    const renderStoppingAction = () => (
      <ActionButton
        variant="loading"
        icon={
          <>
            <div className="absolute inset-0 rounded-full border-2 border-orange-200 border-t-orange-500 animate-spin" />
            <CircleStop className="h-4 w-4 text-orange-500" />
          </>
        }
      />
    )

    if (sendState.primaryAction === 'loading') {
      if (sendState.showStopAction) {
        return renderStoppingAction()
      }

      if (sendState.showPendingAction) {
        return <ActionButton disabled variant="loading" icon={<LoadingDots />} />
      }

      return <ActionButton disabled variant="loading" icon={<LoadingDots />} />
    }

    if (sendState.primaryAction === 'stop') {
      return renderStopAction()
    }

    if (sendState.primaryAction === 'queue') {
      return (
        <div className="flex items-center gap-2">
          {renderStopAction()}
          <SendButton
            onClick={onSendMessage}
            disabled={sendState.isPrimaryDisabled}
            isLoading={isLoading}
            ariaLabel="Queue message"
            compact
          />
        </div>
      )
    }

    return (
      <SendButton
        onClick={onSendMessage}
        disabled={sendState.isPrimaryDisabled}
        isLoading={isLoading}
        compact
      />
    )
  }

  return (
    <div
      className={`flex items-center px-3 gap-2 min-w-0 overflow-visible ${shouldHideChatInput ? 'py-3' : 'pb-2 pt-1'}`}
    >
      {/* Left: secondary actions menu - hidden when hideSelectors is true */}
      <div
        className={`relative flex items-center gap-1 flex-shrink-0 ${hideSelectors ? 'opacity-50 pointer-events-none' : ''}`}
        data-tour="input-controls"
      >
        {/* Secondary actions menu */}
        <Button
          type="button"
          variant="ghost"
          size="sm"
          aria-expanded={moreMenuOpen}
          aria-label="More actions"
          data-testid="mobile-input-more-actions-button"
          title="More actions"
          onClick={() => setMoreMenuOpen(open => !open)}
          className="h-8 w-8 p-0 rounded-full border border-border bg-base text-text-muted hover:text-text-primary hover:bg-hover"
        >
          <Plus className="h-4 w-4" />
        </Button>

        {moreMenuOpen && (
          <div
            data-testid="mobile-input-more-actions-menu"
            className="absolute bottom-full left-0 z-50 mb-2 w-56 rounded-lg border border-border bg-popover p-1 text-popover-foreground shadow-md"
          >
            {hasSecondaryActions && (
              <div className="flex flex-col">
                {showAttachmentAction && (
                  <AttachmentButton
                    onFileSelect={onFileSelect}
                    disabled={isLoading || isStreaming}
                    triggerVariant="menu-item"
                  />
                )}
                {showChatContexts && (
                  <ChatContextInput
                    selectedContexts={selectedContexts}
                    onContextsChange={setSelectedContexts}
                    excludeKnowledgeBaseId={knowledgeBaseId}
                    triggerVariant="menu-item"
                  />
                )}
                {showSkillAction && onToggleSkill && (
                  <SkillSelectorPopover
                    skills={availableSkills}
                    teamSkillNames={teamSkillNames}
                    preloadedSkillNames={preloadedSkillNames}
                    selectedSkillNames={selectedSkillNames}
                    onToggleSkill={onToggleSkill}
                    isChatShell={isChatShell(selectedTeam)}
                    disabled={isLoading || isStreaming}
                    readOnly={hasMessages}
                    triggerVariant="menu-item"
                  />
                )}
              </div>
            )}

            {/* Clarification Toggle - full row clickable */}
            {showClarificationAction && (
              <MobileClarificationToggle
                enabled={enableClarification}
                onToggle={setEnableClarification}
                disabled={isLoading || isStreaming}
              />
            )}

            {/* Correction Mode Toggle - full row clickable */}
            {showCorrectionAction && onCorrectionModeToggle && (
              <MobileCorrectionModeToggle
                enabled={enableCorrectionMode}
                onToggle={onCorrectionModeToggle}
                disabled={isLoading || isStreaming}
                correctionModelName={correctionModelName}
                taskId={selectedTaskDetail?.id ?? null}
              />
            )}

            {showGuidanceAction && onSendGuidance && (
              <Button
                type="button"
                variant="ghost"
                data-testid="send-guidance-button"
                onClick={onSendGuidance}
                disabled={!canSendGuidance || !taskInputMessage.trim()}
                className="flex h-11 w-full items-center justify-start gap-3 px-3 text-sm"
              >
                <Hand className="h-4 w-4 text-primary" />
                <span>{t('guidance.send')}</span>
              </Button>
            )}

            {/* Repository Selector - full row clickable, only show if team requires workspace */}
            {showRepositoryAction && (
              <MobileRepositorySelector
                selectedRepo={selectedRepo}
                handleRepoChange={setSelectedRepo}
                disabled={hasMessages}
                selectedTaskDetail={selectedTaskDetail}
              />
            )}

            {/* Branch Selector - full row clickable, only show if team requires workspace */}
            {showBranchAction && selectedRepo && (
              <MobileBranchSelector
                selectedRepo={selectedRepo}
                selectedBranch={selectedBranch}
                handleBranchChange={setSelectedBranch}
                disabled={hasMessages}
                taskDetail={selectedTaskDetail}
              />
            )}
          </div>
        )}
      </div>

      {/* Right: Agent selector, Model selector, Send button */}
      <div className="ml-auto flex flex-1 items-center justify-end gap-2 min-w-0 overflow-hidden">
        {canSwitchTeam && selectedTeamForDisplay && onTeamChange && (
          <div
            className={`flex-1 min-w-0 overflow-hidden ${hideSelectors ? 'opacity-50 pointer-events-none' : ''}`}
          >
            <MobileTeamSelector
              selectedTeam={selectedTeamForDisplay}
              teams={filteredTeams}
              onTeamSelect={onTeamChange}
              disabled={isLoading || isStreaming}
              isLoading={isLoading}
              hideTriggerIcon={false}
            />
          </div>
        )}
        {selectedTeam && (
          <div
            className={`flex-1 min-w-0 overflow-hidden ${hideSelectors ? 'opacity-50 pointer-events-none' : ''}`}
          >
            <MobileModelSelector
              selectedModel={selectedModel}
              setSelectedModel={setSelectedModel}
              forceOverride={forceOverride}
              setForceOverride={setForceOverride}
              selectedTeam={selectedTeam}
              disabled={isLoading || isStreaming || (hasMessages && !isChatShell(selectedTeam))}
              teamId={teamId}
              taskId={taskId}
              taskModelId={taskModelId}
            />
          </div>
        )}
        <div className="flex-shrink-0">{renderSendButton()}</div>
      </div>
    </div>
  )
}

export default MobileChatInputControls
