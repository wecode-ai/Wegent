// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import React from 'react'
import { CircleStop } from 'lucide-react'
import ModelSelector, { Model } from '../selector/ModelSelector'
import UnifiedRepositorySelector from '../selector/UnifiedRepositorySelector'
import ClarificationToggle from '../clarification/ClarificationToggle'
import CorrectionModeToggle from '../CorrectionModeToggle'
import ChatContextInput from '../chat/ChatContextInput'
import AttachmentButton from '../AttachmentButton'
import SendButton from './SendButton'
import LoadingDots from '../message/LoadingDots'
import QuotaUsage from '../params/QuotaUsage'
import { ActionButton } from '@/components/ui/action-button'
import type {
  Team,
  GitRepoInfo,
  GitBranch,
  TaskDetail,
  MultiAttachmentUploadState,
} from '@/types/api'
import type { ContextItem } from '@/types/context'
import { isChatShell } from '../../service/messageService'
import { supportsAttachments } from '../../service/attachmentService'
import { useIsMobile } from '@/features/layout/hooks/useMediaQuery'
import { MobileChatInputControls } from './MobileChatInputControls'

export interface ChatInputControlsProps {
  // Team and Model
  selectedTeam: Team | null
  onTeamChange?: (team: Team) => void
  selectedModel: Model | null
  setSelectedModel: (model: Model | null) => void
  forceOverride: boolean
  setForceOverride: (value: boolean) => void
  /** Current team ID for model preference storage */
  teamId?: number | null
  /** Current task ID for session-level model preference storage (null for new chat) */
  taskId?: number | null
  /** Task's model_id from backend - used as fallback when no session preference exists */
  taskModelId?: string | null
  /** Knowledge base ID to exclude from context selector (used in notebook mode) */
  knowledgeBaseId?: number

  // Repository and Branch
  showRepositorySelector: boolean
  selectedRepo: GitRepoInfo | null
  setSelectedRepo: (repo: GitRepoInfo | null) => void
  selectedBranch: GitBranch | null
  setSelectedBranch: (branch: GitBranch | null) => void
  selectedTaskDetail: TaskDetail | null
  /** Effective requires workspace value (considering user override) */
  effectiveRequiresWorkspace?: boolean
  /** Callback when user toggles the requires workspace switch */
  onRequiresWorkspaceChange?: (value: boolean) => void

  // Deep Thinking and Clarification
  enableDeepThinking: boolean
  setEnableDeepThinking: (value: boolean) => void
  enableClarification: boolean
  setEnableClarification: (value: boolean) => void

  // Correction mode
  enableCorrectionMode?: boolean
  correctionModelName?: string | null
  onCorrectionModeToggle?: (enabled: boolean, modelId?: string, modelName?: string) => void

  // Context selection (knowledge bases)
  selectedContexts: ContextItem[]
  setSelectedContexts: (contexts: ContextItem[]) => void

  // Attachment (multi-attachment)
  attachmentState: MultiAttachmentUploadState
  onFileSelect: (files: File | File[]) => void
  onAttachmentRemove: (attachmentId: number) => void

  // State flags
  isLoading: boolean
  isStreaming: boolean
  isStopping: boolean
  hasMessages: boolean
  shouldCollapseSelectors: boolean
  shouldHideQuotaUsage: boolean
  shouldHideChatInput: boolean
  isModelSelectionRequired: boolean
  isAttachmentReadyToSend: boolean
  taskInputMessage: string
  isSubtaskStreaming: boolean

  // Actions
  onStopStream: () => void
  onSendMessage: () => void

  // Whether there are no available teams (shows disabled state)
  hasNoTeams?: boolean
}

/**
 * ChatInputControls Component
 *
 * Renders the bottom control bar of the chat input area, including:
 * - File upload button
 * - Clarification toggle
 * - Model selector
 * - Repository selector (for code tasks)
 * - Branch selector (for code tasks)
 * - Quota usage display
 * - Deep thinking toggle
 * - Send/Stop button
 *
 * This component is used in both the empty state (no messages) and
 * the messages state (floating input) of ChatArea.
 */
export function ChatInputControls({
  selectedTeam,
  onTeamChange: _onTeamChange,
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
  onRequiresWorkspaceChange,
  enableClarification,
  setEnableClarification,
  enableCorrectionMode = false,
  correctionModelName,
  onCorrectionModeToggle,
  selectedContexts,
  setSelectedContexts,
  attachmentState: _attachmentState,
  onFileSelect,
  onAttachmentRemove: _onAttachmentRemove,
  isLoading,
  isStreaming,
  isStopping,
  hasMessages,
  shouldCollapseSelectors,
  shouldHideQuotaUsage,
  shouldHideChatInput,
  isModelSelectionRequired,
  isAttachmentReadyToSend,
  taskInputMessage,
  isSubtaskStreaming,
  onStopStream,
  onSendMessage,
  hasNoTeams = false,
}: ChatInputControlsProps) {
  // Always use compact mode (icon only) to save space
  const shouldUseCompactQuota = true
  const isMobile = useIsMobile()

  // Determine the send button state
  const renderSendButton = () => {
    const isDisabled =
      isLoading ||
      isStreaming ||
      isModelSelectionRequired ||
      !isAttachmentReadyToSend ||
      hasNoTeams ||
      (shouldHideChatInput ? false : !taskInputMessage.trim())

    if (isStreaming || isStopping) {
      if (isStopping) {
        return (
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
      }
      return (
        <ActionButton
          onClick={onStopStream}
          title="Stop generating"
          icon={<CircleStop className="h-4 w-4 text-orange-500" />}
          className="hover:bg-orange-100"
        />
      )
    }

    // For group chat: if task status is PENDING but no AI subtask is running,
    // show normal send button instead of loading animation.
    if (
      selectedTaskDetail?.status === 'PENDING' &&
      !isSubtaskStreaming &&
      selectedTaskDetail?.is_group_chat
    ) {
      return <SendButton onClick={onSendMessage} disabled={isDisabled} isLoading={isLoading} />
    }

    // For non-group-chat tasks with PENDING status, show loading animation
    if (selectedTaskDetail?.status === 'PENDING') {
      return <ActionButton disabled variant="loading" icon={<LoadingDots />} />
    }

    // CANCELLING status
    if (selectedTaskDetail?.status === 'CANCELLING') {
      return (
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
    }

    // Default send button
    return <SendButton onClick={onSendMessage} disabled={isDisabled} isLoading={isLoading} />
  }

  // Mobile: delegate to MobileChatInputControls
  if (isMobile) {
    return (
      <MobileChatInputControls
        selectedTeam={selectedTeam}
        selectedModel={selectedModel}
        setSelectedModel={setSelectedModel}
        forceOverride={forceOverride}
        setForceOverride={setForceOverride}
        teamId={teamId}
        taskId={taskId}
        taskModelId={taskModelId}
        knowledgeBaseId={knowledgeBaseId}
        showRepositorySelector={showRepositorySelector}
        selectedRepo={selectedRepo}
        setSelectedRepo={setSelectedRepo}
        selectedBranch={selectedBranch}
        setSelectedBranch={setSelectedBranch}
        selectedTaskDetail={selectedTaskDetail}
        effectiveRequiresWorkspace={effectiveRequiresWorkspace}
        onRequiresWorkspaceChange={hasMessages ? undefined : onRequiresWorkspaceChange}
        enableClarification={enableClarification}
        setEnableClarification={setEnableClarification}
        enableCorrectionMode={enableCorrectionMode}
        correctionModelName={correctionModelName}
        onCorrectionModeToggle={onCorrectionModeToggle}
        selectedContexts={selectedContexts}
        setSelectedContexts={setSelectedContexts}
        onFileSelect={onFileSelect}
        isLoading={isLoading}
        isStreaming={isStreaming}
        isStopping={isStopping}
        hasMessages={hasMessages}
        shouldHideChatInput={shouldHideChatInput}
        isModelSelectionRequired={isModelSelectionRequired}
        isAttachmentReadyToSend={isAttachmentReadyToSend}
        taskInputMessage={taskInputMessage}
        isSubtaskStreaming={isSubtaskStreaming}
        onStopStream={onStopStream}
        onSendMessage={onSendMessage}
        hasNoTeams={hasNoTeams}
      />
    )
  }

  // Desktop layout: original full layout
  return (
    <div
      className={`flex items-center justify-between px-3 gap-2 ${shouldHideChatInput ? 'py-3' : 'pb-2 pt-1'}`}
    >
      <div
        className="flex-1 min-w-0 overflow-hidden flex items-center gap-3"
        data-tour="input-controls"
      >
        {/* Context Selection - only show for chat shell */}
        {isChatShell(selectedTeam) && (
          <ChatContextInput
            selectedContexts={selectedContexts}
            onContextsChange={setSelectedContexts}
            excludeKnowledgeBaseId={knowledgeBaseId}
          />
        )}

        {/* File Upload Button - show for shells that support attachments (Chat, ClaudeCode) */}
        {supportsAttachments(selectedTeam) && (
          <AttachmentButton onFileSelect={onFileSelect} disabled={isLoading || isStreaming} />
        )}

        {/* Clarification Toggle Button - only show for chat shell */}
        {isChatShell(selectedTeam) && (
          <ClarificationToggle
            enabled={enableClarification}
            onToggle={setEnableClarification}
            disabled={isLoading || isStreaming}
          />
        )}

        {/* Correction Mode Toggle Button - only show for chat shell */}
        {isChatShell(selectedTeam) && onCorrectionModeToggle && (
          <CorrectionModeToggle
            enabled={enableCorrectionMode}
            onToggle={onCorrectionModeToggle}
            disabled={isLoading || isStreaming}
            correctionModelName={correctionModelName}
            taskId={selectedTaskDetail?.id ?? null}
          />
        )}

        {/* Repository and Branch Unified Selector - show when repository selector is enabled */}
        {/* Always show when showRepositorySelector is true, let component handle the display */}
        {showRepositorySelector && (
          <UnifiedRepositorySelector
            selectedRepo={selectedRepo}
            selectedBranch={selectedBranch}
            onRepoChange={setSelectedRepo}
            onBranchChange={setSelectedBranch}
            disabled={hasMessages}
            taskDetail={selectedTaskDetail}
            compact={shouldCollapseSelectors}
            requiresWorkspace={effectiveRequiresWorkspace}
            onRequiresWorkspaceChange={hasMessages ? undefined : onRequiresWorkspaceChange}
          />
        )}

        {/* Model Selector */}
        {selectedTeam && (
          <ModelSelector
            selectedModel={selectedModel}
            setSelectedModel={setSelectedModel}
            forceOverride={forceOverride}
            setForceOverride={setForceOverride}
            selectedTeam={selectedTeam}
            disabled={isLoading || isStreaming || (hasMessages && !isChatShell(selectedTeam))}
            compact={shouldCollapseSelectors}
            teamId={teamId}
            taskId={taskId}
            taskModelId={taskModelId}
          />
        )}
      </div>

      <div className="ml-auto flex items-center gap-2 flex-shrink-0">
        {/* Quota Usage */}
        {!shouldHideQuotaUsage && (
          <QuotaUsage className="flex-shrink-0" compact={shouldUseCompactQuota} />
        )}

        {/* Deep Thinking Toggle Button - hidden for now */}
        {/* {isChatShell(selectedTeam) && (
          <DeepThinkingToggle
            enabled={enableDeepThinking}
            onToggle={setEnableDeepThinking}
            disabled={isLoading || isStreaming}
          />
        )} */}

        {/* Send/Stop Button */}
        {renderSendButton()}
      </div>
    </div>
  )
}

export default ChatInputControls
