// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import React, { useMemo, useState, useCallback, type Dispatch, type SetStateAction } from 'react'
import { ChevronRight, CircleStop, Hand, Plus, Zap } from 'lucide-react'
import MobileModelSelector from '../selector/MobileModelSelector'
import type { Model } from '../selector/ModelSelector'
import VideoGenerationModeSelector from '../selector/VideoGenerationModeSelector'
import VideoSettingsPopover from '../selector/VideoSettingsPopover'
import MobileTeamSelector from '../selector/MobileTeamSelector'
import MobileRepositorySelector from '../selector/MobileRepositorySelector'
import MobileClarificationToggle from '../clarification/MobileClarificationToggle'
import MobileCorrectionModeToggle from '../MobileCorrectionModeToggle'
import ChatContextInput from '../chat/ChatContextInput'
import AttachmentButton from '../AttachmentButton'
import SendButton from './SendButton'
import LoadingDots from '../message/LoadingDots'
import { ActionButton } from '@/components/ui/action-button'
import { Button } from '@/components/ui/button'
import { Drawer, DrawerContent } from '@/components/ui/drawer'
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
  canSwitchModelAfterMessages,
  canUseChatContexts,
  isChatShell,
  teamRequiresWorkspace,
} from '../../service/messageService'
import { supportsAttachments } from '../../service/attachmentService'
import MobileSkillSelector from '../selector/MobileSkillSelector'
import { getChatSendState } from './chatSendState'
import { useTranslation } from '@/hooks/useTranslation'
import { filterTeamsByMode, type TeamModeFilter } from '../selector/team-selector-utils'
import type { AspectRatioOption, ResolutionOption, VideoGenerationMode } from '@/apis/models'
import { getVideoParamVisibility } from '../../utils/teamModeSpec'

export interface MobileChatInputControlsProps {
  taskType?: TaskType
  teamModeFilter?: TeamModeFilter
  // Team and Model
  selectedTeam: Team | null
  teams?: Team[]
  onTeamChange?: (team: Team) => void
  onClearTeam?: () => void
  showClearTeamButton?: boolean
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
  setSelectedContexts: Dispatch<SetStateAction<ContextItem[]>>

  // Attachment
  onFileSelect: (files: File | File[]) => void
  attachmentAccept?: string
  videoGenerationModes?: VideoGenerationMode[]
  selectedVideoGenerationMode?: string
  onVideoGenerationModeChange?: (modeId: string) => void
  selectedVideoModel?: Model | null
  onVideoModelChange?: (model: Model) => void
  isVideoModelsLoading?: boolean
  selectedImageModel?: Model | null
  onImageModelChange?: (model: Model) => void
  isImageModelsLoading?: boolean
  showVideoControlsInChat?: boolean
  selectedResolution?: string
  onResolutionChange?: (resolution: string) => void
  availableResolutions?: string[]
  resolutionOptions?: ResolutionOption[]
  selectedRatio?: string
  onRatioChange?: (ratio: string) => void
  availableRatios?: string[]
  ratioOptions?: AspectRatioOption[]
  selectedDuration?: number
  onDurationChange?: (duration: number) => void
  availableDurations?: number[]
  hideDurationSelector?: boolean

  // State flags
  isStreaming: boolean
  isStopping: boolean
  hasMessages: boolean
  shouldHideChatInput: boolean
  isModelSelectionRequired: boolean
  isAttachmentReadyToSend: boolean
  taskInputMessage: string
  submitBlockedReason?: string | null
  hasAttachments?: boolean
  canQueueMessage?: boolean
  canSendGuidance?: boolean
  canCancelTask?: boolean

  // Actions
  onStopStream: () => void
  onCancelTask?: () => void
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
  teamModeFilter = taskType ?? 'chat',
  selectedTeam,
  teams = [],
  onTeamChange,
  onClearTeam,
  showClearTeamButton = false,
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
  attachmentAccept,
  videoGenerationModes = [],
  selectedVideoGenerationMode,
  onVideoGenerationModeChange,
  selectedVideoModel,
  onVideoModelChange,
  isVideoModelsLoading = false,
  selectedImageModel,
  onImageModelChange,
  isImageModelsLoading = false,
  showVideoControlsInChat = false,
  selectedResolution = '720p',
  onResolutionChange,
  availableResolutions,
  resolutionOptions,
  selectedRatio = '16:9',
  onRatioChange,
  availableRatios,
  ratioOptions,
  selectedDuration = 5,
  onDurationChange,
  availableDurations,
  hideDurationSelector = false,
  isStreaming,
  isStopping,
  hasMessages,
  shouldHideChatInput,
  isModelSelectionRequired,
  isAttachmentReadyToSend,
  taskInputMessage,
  submitBlockedReason,
  hasAttachments = false,
  canQueueMessage = false,
  canSendGuidance = false,
  canCancelTask,
  onStopStream,
  onCancelTask,
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
  const [resourceDrawerOpen, setResourceDrawerOpen] = useState(false)
  const [nestedSelectorOpen, setNestedSelectorOpen] = useState(false)
  const [skillDrawerOpen, setSkillDrawerOpen] = useState(false)
  const showChatContexts = canUseChatContexts(taskType, selectedTeam)
  const isVideoMode = taskType === 'video' || showVideoControlsInChat
  const hiddenVideoParams = selectedTeam?.mode_spec?.hiddenVideoParams ?? []
  const videoParamVisibility = getVideoParamVisibility(hiddenVideoParams, !hideDurationSelector)
  const isImageMode = taskType === 'image'
  const isGenerationMode = isImageMode || isVideoMode
  const showAttachmentAction = isGenerationMode
    ? selectedVideoGenerationMode !== 'first_last_frame'
    : supportsAttachments(selectedTeam)
  const showSkillAction = availableSkills.length > 0 && Boolean(onToggleSkill)
  const filteredTeams = useMemo(
    () => filterTeamsByMode(teams, teamModeFilter),
    [teams, teamModeFilter]
  )
  const selectedTeamForDisplay = useMemo(() => {
    if (!selectedTeam) return null
    return filteredTeams.find(team => team.id === selectedTeam.id) ?? selectedTeam
  }, [filteredTeams, selectedTeam])
  const canSwitchTeam = filteredTeams.length > 0 && Boolean(onTeamChange) && !hasMessages
  const showClarificationAction = isChatShell(selectedTeam)
  const showCorrectionAction = isChatShell(selectedTeam) && Boolean(onCorrectionModeToggle)
  const showGuidanceAction = isChatShell(selectedTeam) && Boolean(onSendGuidance)
  const showRepositoryAction =
    showRepositorySelector &&
    teamRequiresWorkspace(selectedTeam) &&
    effectiveRequiresWorkspace !== false
  const showVideoSettings = Boolean(
    isVideoMode &&
    videoParamVisibility.showSettings &&
    onResolutionChange &&
    onRatioChange &&
    onDurationChange
  )
  const hasMoreActions =
    showAttachmentAction ||
    showChatContexts ||
    showSkillAction ||
    showRepositoryAction ||
    showClarificationAction ||
    showCorrectionAction ||
    showGuidanceAction ||
    showVideoSettings
  const handleAttachmentFileSelect = useCallback(
    (files: File | File[]) => {
      setResourceDrawerOpen(false)
      onFileSelect(files)
    },
    [onFileSelect]
  )
  const handleNestedSelectorOpenChange = useCallback((open: boolean) => {
    setNestedSelectorOpen(open)
    if (!open) {
      setResourceDrawerOpen(false)
    }
  }, [])
  const enabledSkillCount = new Set([
    ...teamSkillNames,
    ...preloadedSkillNames,
    ...selectedSkillNames,
  ]).size

  // Render send button based on state
  const renderSendButton = () => {
    const sendState = getChatSendState({
      isStreaming,
      isStopping,
      isModelSelectionRequired,
      isAttachmentReadyToSend,
      hasNoTeams,
      shouldHideChatInput,
      taskInputMessage,
      hasAttachments,
      canQueueMessage,
      canCancelTask,
    })

    const renderStopAction = () => (
      <ActionButton
        onClick={onStopStream}
        title="Stop generating"
        icon={<CircleStop className="h-4 w-4 text-orange-500" />}
        className="hover:bg-orange-100"
        data-testid="stop-stream-button"
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

    const renderCancelTaskAction = () => {
      return (
        <ActionButton
          onClick={onCancelTask}
          title="Cancel task"
          icon={<CircleStop className="h-4 w-4 text-orange-500" />}
          className="hover:bg-orange-100"
          data-testid="cancel-task-button"
        />
      )
    }

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

    if (sendState.primaryAction === 'cancel') {
      return renderCancelTaskAction()
    }

    if (sendState.primaryAction === 'queue') {
      return (
        <div className="flex items-center gap-2">
          {renderStopAction()}
          <SendButton
            onClick={onSendMessage}
            disabled={sendState.isPrimaryDisabled}
            isLoading={false}
            ariaLabel="Queue message"
            compact
            disabledReason={submitBlockedReason}
          />
        </div>
      )
    }

    return (
      <SendButton
        onClick={onSendMessage}
        disabled={sendState.isPrimaryDisabled}
        isLoading={false}
        compact
        disabledReason={submitBlockedReason}
      />
    )
  }

  return (
    <>
      <div
        className={`flex min-w-0 items-center gap-2 px-3 ${shouldHideChatInput ? 'py-3' : 'pb-2 pt-1'}`}
        data-tour="input-controls"
      >
        {hasMoreActions && (
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-expanded={resourceDrawerOpen}
            aria-label={t('mobile_composer.more')}
            data-testid="mobile-input-more-actions-button"
            title={t('mobile_composer.more')}
            onClick={() => {
              setNestedSelectorOpen(false)
              setResourceDrawerOpen(true)
            }}
            disabled={hideSelectors}
            className="h-11 w-11 shrink-0 rounded-xl border border-border bg-base text-text-muted hover:bg-hover hover:text-text-primary"
          >
            <Plus className="h-5 w-5" />
          </Button>
        )}

        {onTeamChange && filteredTeams.length > 0 && (
          <div className="min-w-0 flex-1 overflow-hidden" data-testid="mobile-team-selector-slot">
            <MobileTeamSelector
              selectedTeam={selectedTeamForDisplay}
              teams={filteredTeams}
              onTeamSelect={onTeamChange}
              disabled={!canSwitchTeam || isStreaming || Boolean(hideSelectors)}
              isLoading={false}
              currentMode={teamModeFilter}
              triggerVariant="compact"
              onClear={onClearTeam}
              showClearButton={showClearTeamButton}
            />
          </div>
        )}

        {!isGenerationMode && selectedTeam && (
          <div className="min-w-0 flex-1 overflow-hidden" data-testid="mobile-model-selector-slot">
            <MobileModelSelector
              selectedModel={selectedModel}
              setSelectedModel={setSelectedModel}
              forceOverride={forceOverride}
              setForceOverride={setForceOverride}
              selectedTeam={selectedTeam}
              disabled={
                Boolean(hideSelectors) ||
                isStreaming ||
                (hasMessages && !canSwitchModelAfterMessages(selectedTeam))
              }
              teamId={teamId}
              taskId={taskId}
              taskModelId={taskModelId}
              triggerVariant="compact"
            />
          </div>
        )}

        {isVideoMode && onVideoGenerationModeChange && (
          <VideoGenerationModeSelector
            modes={videoGenerationModes}
            value={selectedVideoGenerationMode}
            onChange={onVideoGenerationModeChange}
            disabled={isStreaming}
          />
        )}
        {isVideoMode && videoParamVisibility.showModel && onVideoModelChange && (
          <div className="min-w-0 flex-1 overflow-hidden">
            <MobileModelSelector
              selectedModel={selectedVideoModel ?? null}
              setSelectedModel={model => model && onVideoModelChange(model)}
              forceOverride={false}
              setForceOverride={() => {}}
              selectedTeam={selectedTeam}
              disabled={isStreaming}
              isLoading={isVideoModelsLoading}
              modelCategoryType="video"
            />
          </div>
        )}
        {isImageMode && onImageModelChange && (
          <div
            className="min-w-0 flex-1 overflow-hidden"
            data-testid="mobile-image-model-selector-slot"
          >
            <MobileModelSelector
              selectedModel={selectedImageModel ?? null}
              setSelectedModel={model => model && onImageModelChange(model)}
              forceOverride={false}
              setForceOverride={() => {}}
              selectedTeam={selectedTeam}
              disabled={isStreaming}
              isLoading={isImageModelsLoading}
              modelCategoryType="image"
              triggerVariant="compact"
            />
          </div>
        )}
        <div className="shrink-0">{renderSendButton()}</div>
      </div>

      <Drawer open={resourceDrawerOpen} onOpenChange={setResourceDrawerOpen}>
        {resourceDrawerOpen && (
          <DrawerContent
            className={`max-h-[85vh] bg-[#f2f2f7] dark:bg-[#1c1c1e] ${
              nestedSelectorOpen ? 'invisible pointer-events-none' : ''
            }`}
            showHandle={false}
            data-testid="mobile-input-more-actions-menu"
          >
            <div className="flex justify-center pb-3 pt-2">
              <div className="h-1 w-9 rounded-full bg-[#3c3c43]/30 dark:bg-[#5c5c5e]" />
            </div>
            <div
              className="max-h-[65vh] min-h-0 flex-1 overflow-y-auto px-4 pb-4"
              style={{ paddingBottom: 'max(12px, env(safe-area-inset-bottom))' }}
            >
              <div className="px-1 pb-2 text-xs font-medium text-[#8e8e93]">
                {t('mobile_composer.more')}
              </div>
              {(showAttachmentAction || showChatContexts || showSkillAction) && (
                <div className="overflow-hidden rounded-xl bg-white dark:bg-[#2c2c2e]">
                  {showAttachmentAction && (
                    <AttachmentButton
                      onFileSelect={handleAttachmentFileSelect}
                      disabled={isStreaming}
                      accept={attachmentAccept}
                      triggerVariant="menu-item"
                    />
                  )}
                  {showChatContexts && (
                    <ChatContextInput
                      selectedContexts={selectedContexts}
                      onContextsChange={setSelectedContexts}
                      excludeKnowledgeBaseId={knowledgeBaseId}
                      triggerVariant="menu-item"
                      onSelectorOpenChange={handleNestedSelectorOpenChange}
                    />
                  )}
                  {showSkillAction && onToggleSkill && (
                    <button
                      type="button"
                      data-testid="mobile-more-skills-button"
                      onClick={() => {
                        setResourceDrawerOpen(false)
                        setSkillDrawerOpen(true)
                      }}
                      disabled={isStreaming}
                      className="flex min-h-14 w-full items-center gap-3 px-3 py-2.5 text-left transition-colors hover:bg-hover active:bg-hover disabled:opacity-60"
                    >
                      <Zap className="h-4 w-4 shrink-0 text-text-muted" aria-hidden="true" />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm font-medium text-text-primary">
                          {t('common:skillSelector.skill_button_label')}
                        </span>
                        <span className="mt-0.5 block truncate text-xs text-text-muted">
                          {t('mobile_composer.skill_count', { count: enabledSkillCount })}
                        </span>
                      </span>
                      <ChevronRight
                        className="h-4 w-4 shrink-0 text-text-muted"
                        aria-hidden="true"
                      />
                    </button>
                  )}
                </div>
              )}

              {(showRepositoryAction || showClarificationAction || showCorrectionAction) && (
                <div className="mt-3 overflow-hidden rounded-xl bg-white dark:bg-[#2c2c2e]">
                  {showRepositoryAction && (
                    <MobileRepositorySelector
                      selectedRepo={selectedRepo}
                      handleRepoChange={setSelectedRepo}
                      selectedBranch={selectedBranch}
                      handleBranchChange={setSelectedBranch}
                      disabled={hasMessages}
                      selectedTaskDetail={selectedTaskDetail}
                      onSelectorOpenChange={handleNestedSelectorOpenChange}
                    />
                  )}
                  {showClarificationAction && (
                    <MobileClarificationToggle
                      enabled={enableClarification}
                      onToggle={setEnableClarification}
                      disabled={isStreaming}
                    />
                  )}
                  {showCorrectionAction && onCorrectionModeToggle && (
                    <MobileCorrectionModeToggle
                      enabled={enableCorrectionMode}
                      onToggle={onCorrectionModeToggle}
                      disabled={isStreaming}
                      correctionModelName={correctionModelName}
                      taskId={selectedTaskDetail?.id ?? null}
                      onSelectorOpenChange={handleNestedSelectorOpenChange}
                    />
                  )}
                </div>
              )}
              {showVideoSettings && onResolutionChange && onRatioChange && onDurationChange && (
                <div className="mt-3 overflow-hidden rounded-xl bg-white dark:bg-[#2c2c2e]">
                  <VideoSettingsPopover
                    selectedRatio={selectedRatio}
                    onRatioChange={onRatioChange}
                    availableRatios={availableRatios ?? ['16:9', '9:16', '1:1']}
                    ratioOptions={ratioOptions}
                    selectedDuration={selectedDuration}
                    onDurationChange={onDurationChange}
                    availableDurations={availableDurations ?? [5, 10]}
                    selectedResolution={selectedResolution}
                    onResolutionChange={onResolutionChange}
                    availableResolutions={availableResolutions ?? ['480p', '720p', '1080p']}
                    resolutionOptions={resolutionOptions}
                    disabled={isStreaming}
                    showDuration={!hideDurationSelector}
                    hiddenVideoParams={hiddenVideoParams}
                    triggerVariant="menu-item"
                  />
                </div>
              )}

              {showGuidanceAction && onSendGuidance && (
                <div className="mt-3 overflow-hidden rounded-xl bg-white dark:bg-[#2c2c2e]">
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
                </div>
              )}
            </div>
          </DrawerContent>
        )}
      </Drawer>

      {showSkillAction && onToggleSkill && (
        <MobileSkillSelector
          skills={availableSkills}
          teamSkillNames={teamSkillNames}
          preloadedSkillNames={preloadedSkillNames}
          selectedSkillNames={selectedSkillNames}
          onToggleSkill={onToggleSkill}
          disabled={isStreaming}
          readOnly={hasMessages}
          open={skillDrawerOpen}
          onOpenChange={setSkillDrawerOpen}
          hideTrigger
        />
      )}
    </>
  )
}

export default MobileChatInputControls
