// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import React, { useRef } from 'react'
import { Upload, Sparkles } from 'lucide-react'
import ChatInput from './ChatInput'
import InputBadgeDisplay from './InputBadgeDisplay'
import ExternalApiParamsInput from '../params/ExternalApiParamsInput'
import { SelectedTeamBadge } from '../selector/SelectedTeamBadge'
import ChatInputControls, { ChatInputControlsProps } from './ChatInputControls'
import { QuoteCard } from '../text-selection'
import { ConnectionStatusBanner } from './ConnectionStatusBanner'
import type { Team, ChatTipItem, TaskType } from '@/types/api'
import { useTranslation } from '@/hooks/useTranslation'
import type { SkillSelectorPopoverRef } from '../selector/SkillSelectorPopover'

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
  handleSendMessage: (message?: string) => Promise<void>

  // Ref for container width measurement
  inputControlsRef?: React.RefObject<HTMLDivElement | null>

  // Whether there are no available teams (shows disabled state)
  hasNoTeams?: boolean

  // Reason why input is disabled (e.g., device offline). Shows as placeholder text.
  disabledReason?: string

  // Hide all selectors (for OpenClaw devices) - only show text input + send button
  hideSelectors?: boolean
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
  handleSendMessage,
  onPasteFile,
  inputControlsRef,
  hasNoTeams = false,
  disabledReason,
  hideSelectors,
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
  isStopping,
  hasMessages,
  shouldCollapseSelectors,
  shouldHideQuotaUsage,
  shouldHideChatInput,
  isModelSelectionRequired,
  isAttachmentReadyToSend,
  isSubtaskStreaming,
  onStopStream,
  onSendMessage,
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

  // Ref for skill button to enable fly animation from autocomplete
  const skillSelectorRef = useRef<SkillSelectorPopoverRef>(null)

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
        <div className="flex items-center gap-1.5 px-4 py-1.5 mb-1 text-text-muted text-xs">
          <Sparkles className="h-3.5 w-3.5 flex-shrink-0" />
          <span>{t('groupChat.mentionHint')}</span>
        </div>
      )}

      {/* Chat Input Card */}
      <div
        className={`relative w-full max-w-[820px] mx-auto rounded-3xl border bg-base shadow-card-hover transition-colors flex flex-col justify-between ${isDragging ? 'border-primary ring-2 ring-primary/20' : 'border-primary/40'}`}
        onDragEnter={onDragEnter}
        onDragLeave={onDragLeave}
        onDragOver={onDragOver}
        onDrop={onDrop}
        style={{ minHeight: '146px' }}
      >
          {isDragging && (
            <div className="absolute inset-0 z-50 rounded-3xl bg-base/95 backdrop-blur-sm flex flex-col items-center justify-center border-2 border-dashed border-primary transition-all animate-in fade-in duration-200">
              <div className="p-4 rounded-full bg-primary/10 mb-4 animate-bounce">
                <Upload className="h-8 w-8 text-primary" />
              </div>
              <p className="text-lg font-medium text-primary">释放以上传文件</p>
              <p className="text-sm text-text-muted mt-1">支持 PDF, Word, TXT, Markdown 等格式</p>
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
          <div className="px-4 pt-3">
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
            />
          </div>
        )}

        {/* Team Selector and Send Button - always show */}
        <div ref={inputControlsRef}>
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
            isStopping={isStopping}
            hasMessages={hasMessages}
            shouldCollapseSelectors={shouldCollapseSelectors}
            shouldHideQuotaUsage={shouldHideQuotaUsage}
            shouldHideChatInput={shouldHideChatInput}
            isModelSelectionRequired={isModelSelectionRequired}
            isAttachmentReadyToSend={isAttachmentReadyToSend}
            taskInputMessage={taskInputMessage}
            isSubtaskStreaming={isSubtaskStreaming}
            onStopStream={onStopStream}
            onSendMessage={onSendMessage}
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
