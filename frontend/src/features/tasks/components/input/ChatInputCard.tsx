// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import React, { useRef, useState, useCallback, useEffect, useMemo } from 'react'
import { ArrowLeftRight, ImagePlus, Loader2, Upload, Sparkles, X, Hand, Pencil } from 'lucide-react'
import ChatInput from './ChatInput'
import InputBadgeDisplay, { useAuthenticatedImageInline } from './InputBadgeDisplay'
import ExternalApiParamsInput from '../params/ExternalApiParamsInput'
import { SelectedTeamBadge } from '../selector/SelectedTeamBadge'
import ChatInputControls, { ChatInputControlsProps } from './ChatInputControls'
import DeviceSelectorTab from './DeviceSelectorTab'
import { QuoteCard } from '../text-selection'
import { ConnectionStatusBanner } from './ConnectionStatusBanner'
import type { Team, ChatTipItem, TaskType } from '@/types/api'
import { useTranslation } from '@/hooks/useTranslation'
import type { SkillSelectorPopoverRef } from '../selector/SkillSelectorPopover'
import type { TeamModeFilter } from '../selector/team-selector-utils'

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
  'taskInputMessage' | 'taskType' | 'teamModeFilter'
> {
  // Input message
  taskInputMessage: string
  setTaskInputMessage: (message: string) => void
  focusInputAtEndSignal?: number

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
  teamModeFilter?: TeamModeFilter
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
  submitBlockedReason?: string | null
  canQueueMessage?: boolean
  queuedMessages?: QueuedInputMessage[]
  onCancelQueuedMessage?: (id: string) => void
  onEditQueuedMessage?: (id: string) => void
  onSendQueuedAsGuidance?: (id: string) => void
  guidanceMessages?: GuidanceInputMessage[]
  expiredGuidanceMessages?: GuidanceInputMessage[]
  onCancelGuidance?: (id: string) => void
  onEditGuidanceMessage?: (id: string) => void
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

  // Project context (for project selector in controls)
  projectId?: number | null

  onSwapAttachments?: (firstAttachmentId: number, secondAttachmentId: number) => void
}

function FrameImageSlot({
  attachment,
  label,
  disabled,
  onUpload,
  onRemove,
  testId,
}: {
  attachment?: ChatInputCardProps['attachmentState']['attachments'][number]
  label: string
  disabled: boolean
  onUpload: () => void
  onRemove: () => void
  testId: string
}) {
  const { t } = useTranslation('chat')
  const { blobUrl, isLoading } = useAuthenticatedImageInline(
    attachment?.id ?? 0,
    Boolean(attachment)
  )

  if (!attachment) {
    return (
      <button
        type="button"
        data-testid={testId}
        disabled={disabled}
        onClick={onUpload}
        className="group flex h-16 w-16 shrink-0 flex-col items-center justify-center gap-1 rounded-xl border border-dashed border-border bg-muted/60 text-text-muted transition-colors hover:border-primary/50 hover:text-primary disabled:cursor-not-allowed disabled:opacity-50"
      >
        <ImagePlus className="h-5 w-5" />
        <span className="text-[11px]">{label}</span>
      </button>
    )
  }

  return (
    <div
      className="group relative h-16 w-16 shrink-0 overflow-hidden rounded-xl border border-border bg-muted"
      data-testid={testId}
    >
      {isLoading || !blobUrl ? (
        <div className="flex h-full w-full items-center justify-center">
          <Loader2 className="h-4 w-4 animate-spin text-text-muted" />
        </div>
      ) : (
        <img src={blobUrl} alt={label} className="h-full w-full object-cover" />
      )}
      <div className="absolute inset-x-0 bottom-0 bg-black/55 px-1 py-0.5 text-center text-[10px] text-white">
        {label}
      </div>
      {!disabled && (
        <button
          type="button"
          onClick={onRemove}
          aria-label={t('video.remove_frame', { frame: label })}
          data-testid={`${testId}-remove`}
          className="absolute -right-2 -top-2 flex h-11 w-11 items-center justify-center text-white opacity-100 transition-opacity sm:opacity-0 sm:group-hover:opacity-100 sm:focus:opacity-100"
        >
          <span className="flex h-5 w-5 items-center justify-center rounded-full bg-black/55 hover:bg-black/75">
            <X className="h-3 w-3" />
          </span>
        </button>
      )}
    </div>
  )
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
  focusInputAtEndSignal,
  selectedTeam,
  teams = [],
  onTeamChange,
  onTeamsRefresh,
  externalApiParams,
  onExternalApiParamsChange,
  onAppModeChange,
  onRestoreDefaultTeam,
  isUsingDefaultTeam = false,
  taskType,
  teamModeFilter,
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
  submitBlockedReason,
  canQueueMessage = false,
  queuedMessages = [],
  onCancelQueuedMessage,
  onEditQueuedMessage,
  onSendQueuedAsGuidance,
  guidanceMessages = [],
  expiredGuidanceMessages = [],
  onCancelGuidance,
  onEditGuidanceMessage,
  onSendExpiredGuidanceAsMessage,
  handleSendMessage,
  onPasteFile,
  inputControlsRef,
  hasNoTeams = false,
  disabledReason,
  hideSelectors,
  onEditTeam,
  projectId,
  onSwapAttachments,
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
  isStreaming,
  isStopping,
  hasMessages,
  shouldCollapseSelectors,
  shouldHideToolbarStatus,
  shouldHideChatInput,
  isModelSelectionRequired,
  isAttachmentReadyToSend,
  canSendGuidance,
  canCancelTask,
  onStopStream,
  onCancelTask,
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
  resolutionOptions,
  selectedRatio,
  onRatioChange,
  availableRatios,
  ratioOptions,
  selectedDuration,
  onDurationChange,
  availableDurations,
  videoGenerationModes,
  selectedVideoGenerationMode,
  onVideoGenerationModeChange,
  materialAccept,
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
  const frameInputRef = useRef<HTMLInputElement>(null)
  const pendingFrameSlotRef = useRef<0 | 1 | null>(null)
  const [frameAttachmentIds, setFrameAttachmentIds] = useState<[number | null, number | null]>([
    null,
    null,
  ])

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
  const imageAttachments = useMemo(
    () =>
      attachmentState.attachments.filter(attachment => attachment.mime_type.startsWith('image/')),
    [attachmentState.attachments]
  )
  const firstLastFrameImages = frameAttachmentIds.map(attachmentId =>
    imageAttachments.find(attachment => attachment.id === attachmentId)
  )

  useEffect(() => {
    if (selectedVideoGenerationMode !== 'first_last_frame') {
      pendingFrameSlotRef.current = null
      setFrameAttachmentIds(previousIds =>
        previousIds[0] === null && previousIds[1] === null ? previousIds : [null, null]
      )
      return
    }

    const availableIds = new Set(imageAttachments.map(attachment => attachment.id))
    setFrameAttachmentIds(previousIds => {
      const nextIds: [number | null, number | null] = [
        previousIds[0] && availableIds.has(previousIds[0]) ? previousIds[0] : null,
        previousIds[1] && availableIds.has(previousIds[1]) ? previousIds[1] : null,
      ]
      const assignedIds = new Set(nextIds.filter((id): id is number => id !== null))
      const unassignedIds = imageAttachments
        .map(attachment => attachment.id)
        .filter(id => !assignedIds.has(id))

      for (const attachmentId of unassignedIds) {
        const pendingSlot = pendingFrameSlotRef.current
        const targetSlot =
          pendingSlot !== null && nextIds[pendingSlot] === null
            ? pendingSlot
            : nextIds[0] === null
              ? 0
              : nextIds[1] === null
                ? 1
                : null
        if (targetSlot === null) break
        nextIds[targetSlot] = attachmentId
        if (pendingSlot === targetSlot) pendingFrameSlotRef.current = null
      }

      return nextIds[0] === previousIds[0] && nextIds[1] === previousIds[1] ? previousIds : nextIds
    })
  }, [imageAttachments, selectedVideoGenerationMode])

  useEffect(() => {
    const [firstFrameId, lastFrameId] = frameAttachmentIds
    if (
      selectedVideoGenerationMode !== 'first_last_frame' ||
      !firstFrameId ||
      !lastFrameId ||
      !onSwapAttachments
    ) {
      return
    }

    const orderedImageIds = imageAttachments.map(attachment => attachment.id)
    if (orderedImageIds[0] === lastFrameId && orderedImageIds[1] === firstFrameId) {
      onSwapAttachments(firstFrameId, lastFrameId)
    }
  }, [frameAttachmentIds, imageAttachments, onSwapAttachments, selectedVideoGenerationMode])

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
                      {onEditQueuedMessage && (
                        <button
                          type="button"
                          data-testid="edit-queued-message-button"
                          title={t('actions.edit')}
                          onClick={() => onEditQueuedMessage(message.id)}
                          className="inline-flex h-7 items-center gap-1 rounded-lg px-2.5 text-xs font-medium text-text-secondary transition-colors hover:bg-base hover:text-text-primary"
                        >
                          <Pencil className="h-3 w-3" />
                          {t('actions.edit')}
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
                  {message.status !== 'sending' && (onCancelGuidance || onEditGuidanceMessage) && (
                    <div className="flex shrink-0 items-center gap-1">
                      {onEditGuidanceMessage && (
                        <button
                          type="button"
                          data-testid="edit-guidance-message-button"
                          title={t('actions.edit')}
                          onClick={() => onEditGuidanceMessage(message.id)}
                          className="inline-flex h-7 items-center gap-1 rounded-lg px-2.5 text-xs font-medium text-text-secondary transition-colors hover:bg-base hover:text-text-primary"
                        >
                          <Pencil className="h-3 w-3" />
                          {t('actions.edit')}
                        </button>
                      )}
                      {onCancelGuidance && (
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
              disabled={isStreaming || !!projectId}
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
        {selectedVideoGenerationMode === 'first_last_frame' && (
          <div
            className="flex items-center gap-2 px-4 pt-3"
            data-testid="first-last-frame-uploader"
          >
            <input
              ref={frameInputRef}
              data-testid="first-last-frame-file-input"
              type="file"
              accept={materialAccept ?? 'image/*'}
              className="hidden"
              onChange={event => {
                const file = event.target.files?.[0]
                if (file) onFileSelect(file)
                event.target.value = ''
              }}
            />
            <FrameImageSlot
              attachment={firstLastFrameImages[0]}
              label={t('video.first_frame')}
              disabled={isStreaming}
              onUpload={() => {
                pendingFrameSlotRef.current = 0
                frameInputRef.current?.click()
              }}
              onRemove={() => {
                const attachment = firstLastFrameImages[0]
                if (attachment) onAttachmentRemove(attachment.id)
              }}
              testId="first-frame-upload"
            />
            <button
              type="button"
              data-testid="swap-first-last-frames"
              aria-label={t('video.swap_frames')}
              disabled={
                isStreaming ||
                !firstLastFrameImages[0] ||
                !firstLastFrameImages[1] ||
                !onSwapAttachments
              }
              onClick={() => {
                const [firstFrame, lastFrame] = firstLastFrameImages
                if (firstFrame && lastFrame) {
                  setFrameAttachmentIds([lastFrame.id, firstFrame.id])
                  onSwapAttachments?.(firstFrame.id, lastFrame.id)
                }
              }}
              className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-text-muted transition-colors hover:bg-hover hover:text-primary disabled:cursor-not-allowed disabled:opacity-35"
            >
              <ArrowLeftRight className="h-4 w-4" />
            </button>
            <FrameImageSlot
              attachment={firstLastFrameImages[1]}
              label={t('video.last_frame')}
              disabled={isStreaming || !firstLastFrameImages[0]}
              onUpload={() => {
                pendingFrameSlotRef.current = 1
                frameInputRef.current?.click()
              }}
              onRemove={() => {
                const attachment = firstLastFrameImages[1]
                if (attachment) onAttachmentRemove(attachment.id)
              }}
              testId="last-frame-upload"
            />
          </div>
        )}

        <InputBadgeDisplay
          contexts={selectedContexts}
          attachmentState={attachmentState}
          onRemoveContexts={contextIds => {
            const contextIdSet = new Set(contextIds)
            setSelectedContexts(selectedContexts.filter(ctx => !contextIdSet.has(ctx.id)))
          }}
          onRemoveAttachment={onAttachmentRemove}
          disabled={isStreaming}
          hideAttachments={selectedVideoGenerationMode === 'first_last_frame'}
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
              isLoading={false}
              taskType={taskType}
              autoFocus={autoFocus}
              canSubmit={canSubmit}
              submitBlockedReason={submitBlockedReason}
              tipText={tipText}
              badge={
                selectedTeam && !isUsingDefaultTeam ? (
                  <SelectedTeamBadge
                    team={selectedTeam}
                    showClearButton={!hasMessages}
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
              focusAtEndSignal={focusInputAtEndSignal}
            />
          </div>
        )}

        {/* Selected Team Badge only - show when chat input is hidden (workflow mode) and not using default team */}
        {shouldHideChatInput && selectedTeam && !isUsingDefaultTeam && (
          <div className="px-4 pt-3">
            <SelectedTeamBadge
              team={selectedTeam}
              showClearButton={!hasMessages}
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
            onTeamsRefresh={onTeamsRefresh}
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
            isStreaming={isStreaming}
            isStopping={isStopping}
            hasMessages={hasMessages}
            shouldCollapseSelectors={shouldCollapseSelectors}
            shouldHideToolbarStatus={shouldHideToolbarStatus}
            shouldHideChatInput={shouldHideChatInput}
            isModelSelectionRequired={isModelSelectionRequired}
            isAttachmentReadyToSend={isAttachmentReadyToSend}
            taskInputMessage={taskInputMessage}
            submitBlockedReason={submitBlockedReason}
            canQueueMessage={canQueueMessage}
            canSendGuidance={canSendGuidance}
            canCancelTask={canCancelTask}
            onStopStream={onStopStream}
            onCancelTask={onCancelTask}
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
            teamModeFilter={teamModeFilter}
            videoModels={videoModels}
            selectedVideoModel={selectedVideoModel}
            onVideoModelChange={onVideoModelChange}
            isVideoModelsLoading={isVideoModelsLoading}
            selectedResolution={selectedResolution}
            onResolutionChange={onResolutionChange}
            availableResolutions={availableResolutions}
            resolutionOptions={resolutionOptions}
            selectedRatio={selectedRatio}
            onRatioChange={onRatioChange}
            availableRatios={availableRatios}
            ratioOptions={ratioOptions}
            selectedDuration={selectedDuration}
            onDurationChange={onDurationChange}
            availableDurations={availableDurations}
            videoGenerationModes={videoGenerationModes}
            selectedVideoGenerationMode={selectedVideoGenerationMode}
            onVideoGenerationModeChange={onVideoGenerationModeChange}
            materialAccept={materialAccept}
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
            // Project context
            projectId={projectId}
          />
        </div>
      </div>
    </div>
  )
}

export default ChatInputCard
