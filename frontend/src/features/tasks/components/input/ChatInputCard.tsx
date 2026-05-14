// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import React, { useRef, useState, useCallback } from 'react'
import { Upload, Sparkles, X, Hand } from 'lucide-react'
import ChatInput from './ChatInput'
import InputBadgeDisplay from './InputBadgeDisplay'
import ExternalApiParamsInput from '../params/ExternalApiParamsInput'
import { SelectedTeamBadge } from '../selector/SelectedTeamBadge'
import ChatInputControls, { ChatInputControlsProps } from './ChatInputControls'
import DeviceSelectorTab from './DeviceSelectorTab'
import { QuoteCard } from '../text-selection'
import { ConnectionStatusBanner } from './ConnectionStatusBanner'
import type { Team, ChatTipItem, TaskType } from '@/types/api'
import { useTranslation } from '@/hooks/useTranslation'
import type { SkillSelectorPopoverRef } from '../selector/SkillSelectorPopover'

export interface QueuedInputMessage {
  id: string
  displayMessage: string
  status: 'queued' | 'sending' | 'failed'
  error?: string
}

export interface GuidanceInputMessage {
  id: string
  displayMessage: string
  status: 'pending' | 'queued' | 'sending' | 'failed' | 'applied' | 'expired'
  error?: string
}

export interface ChatInputCardProps extends Omit<
  ChatInputControlsProps,
  'taskInputMessage' | 'taskType'
> {
  // Input message
  taskInputMessage: string
  setTaskInputMessage: (message: string) => void

  // Team and external API
  selectedTeam: Team | null
  /** Available teams for team selector */
  teams?: Team[]
  externalApiParams: Record<string, string>
  onExternalApiParamsChange: (params: Record<string, string>) => void
  onAppModeChange: (mode: string | undefined) => void

  // Restore to default team
  onRestoreDefaultTeam?: () => void

  // Whether the current team is the default team (hide badge when true)
  isUsingDefaultTeam?: boolean

  // Task type
  taskType: TaskType
  autoFocus?: boolean

  // Knowledge base ID to exclude from context selector (used in notebook mode)
  knowledgeBaseId?: number

  // Tips
  tipText: ChatTipItem | null

  // Group chat
  isGroupChat: boolean

  // Drag and drop
  isDragging: boolean
  onDragEnter: (e: React.DragEvent) => void
  onDragLeave: (e: React.DragEvent) => void
  onDragOver: (e: React.DragEvent) => void
  onDrop: (e: React.DragEvent) => void

  // Attachment handlers
  onPasteFile?: (files: File | File[]) => void

  // Submit
  canSubmit: boolean
  canQueueMessage?: boolean
  queuedMessages?: QueuedInputMessage[]
  onCancelQueuedMessage?: (id: string) => void
  onSendQueuedAsGuidance?: (id: string) => void
  guidanceMessages?: GuidanceInputMessage[]
  expiredGuidanceMessages?: GuidanceInputMessage[]
  onCancelGuidance?: (id: string) => void
  onSendExpiredGuidanceAsMessage?: (id: string) => void
  handleSendMessage: (message?: string) => Promise<void>

  // Ref for container width measurement
  inputControlsRef?: React.RefObject<HTMLDivElement | null>

  // Whether there are no available teams (shows disabled state)
  hasNoTeams?: boolean

  // Reason why input is disabled (e.g., device offline). Shows as placeholder text.
  disabledReason?: string

  // Hide all selectors (for OpenClaw devices) - only show text input + send button
  hideSelectors?: boolean

  // Callback to open team edit dialog (shown as pencil icon on badge)
  onEditTeam?: () => void
}

/**
 * ChatInputCard Component
 *
 * A unified chat input card that combines:
 * - File upload preview
 * - Text input area
 * - Control buttons (model selector, repo selector, send button, etc.)
 *
 * Supports drag-and-drop file upload and displays external API parameters
 * for Dify teams.
 *
 * This component is used in both the empty state (no messages) and
 * the messages state (floating input) of ChatArea.
 */
export function ChatInputCard({
  taskInputMessage,
  setTaskInputMessage,
  selectedTeam,
  teams = [],
  onTeamChange,
  externalApiParams,
  onExternalApiParamsChange,
  onAppModeChange,
  onRestoreDefaultTeam,
  isUsingDefaultTeam = false,
  taskType,
  autoFocus = false,
  knowledgeBaseId,
  tipText,
  isGroupChat,
  isDragging,
  onDragEnter,
  onDragLeave,
  onDragOver,
  onDrop,
  canSubmit,
  canQueueMessage = false,
  queuedMessages = [],
  onCancelQueuedMessage,
  onSendQueuedAsGuidance,
  guidanceMessages = [],
  expiredGuidanceMessages = [],
  onCancelGuidance,
  onSendExpiredGuidanceAsMessage,
  handleSendMessage,
  onPasteFile,
  inputControlsRef,
  hasNoTeams = false,
  disabledReason,
  hideSelectors,
  onEditTeam,
  // ChatInputControls props
  selectedModel,
  setSelectedModel,
  forceOverride,
  setForceOverride,
  teamId,
  taskId,
  showRepositorySelector,
  selectedRepo,
  setSelectedRepo,
  selectedBranch,
  setSelectedBranch,
  selectedTaskDetail,
  effectiveRequiresWorkspace,
  onRequiresWorkspaceChange,
  enableDeepThinking,
  setEnableDeepThinking,
  enableClarification,
  setEnableClarification,
  enableCorrectionMode,
  correctionModelName,
  onCorrectionModeToggle,
  selectedContexts,
  setSelectedContexts,
  attachmentState,
  onFileSelect,
  onAttachmentRemove,
  isLoading,
  isStreaming,
  isAwaitingResponseStart,
  isStopping,
  hasMessages,
  shouldCollapseSelectors,
  shouldHideQuotaUsage,
  shouldHideChatInput,
  isModelSelectionRequired,
  isAttachmentReadyToSend,
  isSubtaskStreaming,
  canSendGuidance,
  onStopStream,
  onSendMessage,
  onSendGuidance,
  // Skill selector props
  availableSkills,
  teamSkillNames,
  preloadedSkillNames,
  selectedSkillNames,
  onToggleSkill,
  // Video mode props
  videoModels,
  selectedVideoModel,
  onVideoModelChange,
  isVideoModelsLoading,
  selectedResolution,
  onResolutionChange,
  availableResolutions,
  selectedRatio,
  onRatioChange,
  availableRatios,
  selectedDuration,
  onDurationChange,
  availableDurations,
  // Image mode props
  selectedImageModel,
  onImageModelChange,
  isImageModelsLoading,
  selectedImageSize,
  onImageSizeChange,
  // Generate mode switch props
  onGenerateModeChange,
}: ChatInputCardProps) {
  const { t } = useTranslation('chat')

  // State for expanded input mode (2x height for easier large text editing)
  const [isInputExpanded, setIsInputExpanded] = useState(false)

  // Toggle expand/collapse state
  const handleExpandToggle = useCallback(() => {
    setIsInputExpanded(prev => !prev)
  }, [])

  // Ref for skill button to enable fly animation from autocomplete
  const skillSelectorRef = useRef<SkillSelectorPopoverRef>(null)

  const shouldUseCompactQueueSpacing =
    !hasMessages &&
    !taskInputMessage.trim() &&
    selectedContexts.some(context => context.type === 'queue_message')

  const getQueuedMessageStatusLabel = (status: QueuedInputMessage['status']) => {
    if (status === 'sending') return t('messages.status_sending')
    if (status === 'failed') return t('messages.queue_failed')
    return t('messages.status_queued')
  }

  const getGuidanceStatusLabel = (status: GuidanceInputMessage['status']) => {
    if (status === 'sending') return t('guidance.status_sending')
    if (status === 'failed') return t('guidance.status_failed')
    if (status === 'expired') return t('guidance.status_expired')
    return t('guidance.status_queued')
  }

  // Get skill button element for fly animation
  const getSkillButtonElement = () => {
    return skillSelectorRef.current?.getButtonElement() ?? null
  }

  return (
    <div className="w-full">
      {/* External API Parameters Input - only show for Dify teams */}
      {selectedTeam && selectedTeam.agent_type === 'dify' && (
        <ExternalApiParamsInput
          teamId={selectedTeam.id}
          onParamsChange={onExternalApiParamsChange}
          onAppModeChange={onAppModeChange}
          initialParams={externalApiParams}
        />
      )}

      {/* Group Chat Mention Hint - only show in group chat mode */}
      {isGroupChat && (
        <div className="flex items-center gap-1.5 pl-28 pr-4 py-1.5 mb-1 text-text-muted text-xs">
          <Sparkles className="h-3.5 w-3.5 flex-shrink-0" />
          <span>{t('groupChat.mentionHint')}</span>
        </div>
      )}

      {(queuedMessages.length > 0 ||
        guidanceMessages.length > 0 ||
        expiredGuidanceMessages.length > 0) &&
        !shouldHideChatInput && (
          <div className="mx-auto mb-9 w-full max-w-[820px] px-1">
            <div
              data-testid="queued-message-list"
              className="space-y-0 rounded-xl border border-border bg-surface/90 px-3 py-2 shadow-sm"
            >
              {/* Queue items */}
              {queuedMessages.map((message, index) => (
                <div
                  key={message.id}
                  data-testid="queued-message-item"
                  className={`flex min-w-0 items-start gap-2 py-2 ${
                    index < queuedMessages.length - 1 ||
                    guidanceMessages.length > 0 ||
                    expiredGuidanceMessages.length > 0
                      ? 'border-b border-border/60'
                      : ''
                  }`}
                >
                  <div className="min-w-0 flex-1">
                    <div className="mb-1 flex items-center gap-2">
                      <span
                        className={`inline-flex shrink-0 items-center rounded-full px-2 py-0.5 text-xs ${
                          message.status === 'failed'
                            ? 'bg-destructive/10 text-destructive'
                            : 'bg-primary/10 text-primary'
                        }`}
                      >
                        {getQueuedMessageStatusLabel(message.status)}
                      </span>
                    </div>
                    <p className="line-clamp-2 whitespace-pre-wrap break-words text-sm text-text-secondary">
                      {message.displayMessage}
                    </p>
                  </div>
                  {message.status !== 'sending' && (
                    <div className="flex shrink-0 items-center gap-1">
                      {canSendGuidance && onSendQueuedAsGuidance && (
                        <button
                          type="button"
                          data-testid="send-queued-as-guidance-button"
                          title={t('guidance.send')}
                          onClick={() => onSendQueuedAsGuidance(message.id)}
                          className="inline-flex h-7 items-center gap-1 rounded-lg border border-primary/30 bg-primary/8 px-2.5 text-xs font-medium text-primary transition-colors hover:bg-primary/15"
                        >
                          <Hand className="h-3 w-3" />
                          {t('guidance.send')}
                        </button>
                      )}
                      {onCancelQueuedMessage && (
                        <button
                          type="button"
                          data-testid="cancel-queued-message-button"
                          aria-label={t('messages.cancel_queued')}
                          title={t('messages.cancel_queued')}
                          onClick={() => onCancelQueuedMessage(message.id)}
                          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-text-muted transition-colors hover:bg-base hover:text-text-primary"
                        >
                          <X className="h-4 w-4" />
                        </button>
                      )}
                    </div>
                  )}
                </div>
              ))}

              {/* Guidance items */}
              {guidanceMessages.map((message, index) => (
                <div
                  key={message.id}
                  data-testid="pending-guidance-card"
                  className={`flex min-w-0 items-start gap-2 py-2 ${
                    index < guidanceMessages.length - 1 || expiredGuidanceMessages.length > 0
                      ? 'border-b border-border/60'
                      : ''
                  }`}
                >
                  <div className="min-w-0 flex-1">
                    <div className="mb-1 flex items-center gap-2">
                      <span
                        className={`inline-flex shrink-0 items-center rounded-full px-2 py-0.5 text-xs ${
                          message.status === 'failed'
                            ? 'bg-destructive/10 text-destructive'
                            : 'bg-primary/10 text-primary'
                        }`}
                      >
                        {getGuidanceStatusLabel(message.status)}
                      </span>
                    </div>
                    <p className="line-clamp-2 whitespace-pre-wrap break-words text-sm text-text-secondary">
                      {message.displayMessage}
                    </p>
                  </div>
                  {message.status !== 'sending' && onCancelGuidance && (
                    <button
                      type="button"
                      data-testid="cancel-guidance-button"
                      aria-label={t('guidance.cancel')}
                      title={t('guidance.cancel')}
                      onClick={() => onCancelGuidance(message.id)}
                      className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-text-muted transition-colors hover:bg-base hover:text-text-primary"
                    >
                      <X className="h-4 w-4" />
                    </button>
                  )}
                </div>
              ))}

              {/* Expired guidance items */}
              {expiredGuidanceMessages.map((message, index) => (
                <div
                  key={message.id}
                  data-testid="expired-guidance-card"
                  className={`flex min-w-0 items-start gap-2 py-2 ${
                    index < expiredGuidanceMessages.length - 1 ? 'border-b border-border/60' : ''
                  }`}
                >
                  <div className="min-w-0 flex-1">
                    <div className="mb-1 flex items-center gap-2">
                      <span className="inline-flex shrink-0 items-center rounded-full bg-surface px-2 py-0.5 text-xs text-text-muted">
                        {getGuidanceStatusLabel(message.status)}
                      </span>
                    </div>
                    <p className="line-clamp-2 whitespace-pre-wrap break-words text-sm text-text-secondary">
                      {message.displayMessage}
                    </p>
                  </div>
                  <div className="flex shrink-0 items-center gap-1">
                    {onSendExpiredGuidanceAsMessage && (
                      <button
                        type="button"
                        data-testid="send-expired-guidance-as-message-button"
                        onClick={() => onSendExpiredGuidanceAsMessage(message.id)}
                        className="h-8 shrink-0 rounded-lg px-3 text-xs font-medium text-primary transition-colors hover:bg-base"
                      >
                        {t('guidance.send_as_message')}
                      </button>
                    )}
                    {onCancelGuidance && (
                      <button
                        type="button"
                        data-testid="cancel-expired-guidance-button"
                        aria-label={t('guidance.cancel')}
                        title={t('guidance.cancel')}
                        onClick={() => onCancelGuidance(message.id)}
                        className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-text-muted transition-colors hover:bg-base hover:text-text-primary"
                      >
                        <X className="h-4 w-4" />
                      </button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

      {/* Chat Input Card */}
      <div
        data-testid="chat-input-card"
        className={`relative w-full max-w-[820px] mx-auto rounded-3xl border bg-base shadow-card-hover transition-colors flex flex-col justify-start ${isDragging ? 'border-primary ring-2 ring-primary/20' : 'border-primary/40'}`}
        onDragEnter={onDragEnter}
        onDragLeave={onDragLeave}
        onDragOver={onDragOver}
        onDrop={onDrop}
        style={{ minHeight: '146px' }}
      >
        {/* Device Selector Tab - positioned at top left inside card, connected to border */}
        {!shouldHideChatInput && (
          <div className="absolute -top-[29px] left-4 z-10">
            <DeviceSelectorTab
              disabled={isLoading || isStreaming}
              hasMessages={hasMessages}
              taskDeviceId={selectedTaskDetail?.device_id}
              className="rounded-t-lg"
            />
          </div>
        )}

        {/* Drag Overlay */}
        {isDragging && (
          <div className="absolute inset-0 z-50 rounded-3xl bg-base/95 backdrop-blur-sm flex flex-col items-center justify-center border-2 border-dashed border-primary transition-all animate-in fade-in duration-200">
            <div className="p-4 rounded-full bg-primary/10 mb-4 animate-bounce">
              <Upload className="h-8 w-8 text-primary" />
            </div>
            <p className="text-lg font-medium text-primary">释放以上传文件</p>
            <p className="text-sm text-text-muted mt-1">
              支持 PDF, Word, XMind, TXT, Markdown 等格式
            </p>
          </div>
        )}

        {/* Unified Badge Display - Knowledge bases and attachments */}
        <InputBadgeDisplay
          contexts={selectedContexts}
          attachmentState={attachmentState}
          onRemoveContext={contextId => {
            setSelectedContexts(selectedContexts.filter(ctx => ctx.id !== contextId))
          }}
          onRemoveAttachment={onAttachmentRemove}
          disabled={isLoading || isStreaming}
        />

        {/* Quote Card - shows quoted text from text selection */}
        {!shouldHideChatInput && <QuoteCard />}

        {/* Connection Status Banner - shows WebSocket connection status */}
        {!shouldHideChatInput && <ConnectionStatusBanner />}

        {/* Chat Input with inline badge */}
        {!shouldHideChatInput && (
          <div className={`px-4 ${shouldUseCompactQueueSpacing ? 'pt-1.5' : 'pt-3'}`}>
            <ChatInput
              message={taskInputMessage}
              setMessage={setTaskInputMessage}
              handleSendMessage={handleSendMessage}
              isLoading={isLoading}
              taskType={taskType}
              autoFocus={autoFocus}
              canSubmit={canSubmit}
              tipText={tipText}
              badge={
                selectedTeam && !isUsingDefaultTeam ? (
                  <SelectedTeamBadge
                    team={selectedTeam}
                    showClearButton={true}
                    onClear={onRestoreDefaultTeam}
                    onEdit={onEditTeam}
                  />
                ) : undefined
              }
              isGroupChat={isGroupChat}
              team={selectedTeam}
              onPasteFile={onPasteFile}
              hasNoTeams={hasNoTeams}
              disabledReason={disabledReason}
              // Skill selector props for slash command
              showSkillSelector={availableSkills && availableSkills.length > 0}
              availableSkills={availableSkills}
              teamSkillNames={teamSkillNames}
              preloadedSkillNames={preloadedSkillNames}
              selectedSkillNames={selectedSkillNames}
              onSkillSelect={onToggleSkill}
              isChatShell={selectedTeam?.agent_type === 'chat'}
              // Skill selection is read-only after task creation (hasMessages)
              skillSelectorReadOnly={hasMessages}
              // Pass skill button ref for fly animation
              skillButtonRef={
                { current: getSkillButtonElement() } as React.RefObject<HTMLElement | null>
              }
              // Expand/collapse props for input height toggle
              isExpanded={isInputExpanded}
              onExpandToggle={handleExpandToggle}
              compactSpacing={shouldUseCompactQueueSpacing}
            />
          </div>
        )}

        {/* Selected Team Badge only - show when chat input is hidden (workflow mode) and not using default team */}
        {shouldHideChatInput && selectedTeam && !isUsingDefaultTeam && (
          <div className="px-4 pt-3">
            <SelectedTeamBadge
              team={selectedTeam}
              showClearButton={true}
              onClear={onRestoreDefaultTeam}
              onEdit={onEditTeam}
            />
          </div>
        )}

        {/* Team Selector and Send Button - always show */}
        <div ref={inputControlsRef} className="mt-auto">
          <ChatInputControls
            selectedTeam={selectedTeam}
            teams={teams}
            onTeamChange={onTeamChange}
            selectedModel={selectedModel}
            setSelectedModel={setSelectedModel}
            forceOverride={forceOverride}
            setForceOverride={setForceOverride}
            teamId={teamId}
            taskId={taskId}
            taskModelId={selectedTaskDetail?.model_id}
            showRepositorySelector={showRepositorySelector}
            selectedRepo={selectedRepo}
            setSelectedRepo={setSelectedRepo}
            selectedBranch={selectedBranch}
            setSelectedBranch={setSelectedBranch}
            selectedTaskDetail={selectedTaskDetail}
            effectiveRequiresWorkspace={effectiveRequiresWorkspace}
            onRequiresWorkspaceChange={onRequiresWorkspaceChange}
            enableDeepThinking={enableDeepThinking}
            setEnableDeepThinking={setEnableDeepThinking}
            enableClarification={enableClarification}
            setEnableClarification={setEnableClarification}
            enableCorrectionMode={enableCorrectionMode}
            correctionModelName={correctionModelName}
            onCorrectionModeToggle={onCorrectionModeToggle}
            selectedContexts={selectedContexts}
            setSelectedContexts={setSelectedContexts}
            attachmentState={attachmentState}
            onFileSelect={onFileSelect}
            onAttachmentRemove={onAttachmentRemove}
            isLoading={isLoading}
            isStreaming={isStreaming}
            isAwaitingResponseStart={isAwaitingResponseStart}
            isStopping={isStopping}
            hasMessages={hasMessages}
            shouldCollapseSelectors={shouldCollapseSelectors}
            shouldHideQuotaUsage={shouldHideQuotaUsage}
            shouldHideChatInput={shouldHideChatInput}
            isModelSelectionRequired={isModelSelectionRequired}
            isAttachmentReadyToSend={isAttachmentReadyToSend}
            taskInputMessage={taskInputMessage}
            isSubtaskStreaming={isSubtaskStreaming}
            canQueueMessage={canQueueMessage}
            canSendGuidance={canSendGuidance}
            onStopStream={onStopStream}
            onSendMessage={onSendMessage}
            onSendGuidance={onSendGuidance}
            hasNoTeams={hasNoTeams}
            knowledgeBaseId={knowledgeBaseId}
            availableSkills={availableSkills}
            teamSkillNames={teamSkillNames}
            preloadedSkillNames={preloadedSkillNames}
            selectedSkillNames={selectedSkillNames}
            onToggleSkill={onToggleSkill}
            skillSelectorRef={skillSelectorRef}
            // Video mode props
            taskType={taskType}
            videoModels={videoModels}
            selectedVideoModel={selectedVideoModel}
            onVideoModelChange={onVideoModelChange}
            isVideoModelsLoading={isVideoModelsLoading}
            selectedResolution={selectedResolution}
            onResolutionChange={onResolutionChange}
            availableResolutions={availableResolutions}
            selectedRatio={selectedRatio}
            onRatioChange={onRatioChange}
            availableRatios={availableRatios}
            selectedDuration={selectedDuration}
            onDurationChange={onDurationChange}
            availableDurations={availableDurations}
            // Image mode props
            selectedImageModel={selectedImageModel}
            onImageModelChange={onImageModelChange}
            isImageModelsLoading={isImageModelsLoading}
            selectedImageSize={selectedImageSize}
            onImageSizeChange={onImageSizeChange}
            // Generate mode switch props
            onGenerateModeChange={onGenerateModeChange}
            // Hide all selectors (for OpenClaw devices)
            hideSelectors={hideSelectors}
          />
        </div>
      </div>
    </div>
  )
}

export default ChatInputCard
