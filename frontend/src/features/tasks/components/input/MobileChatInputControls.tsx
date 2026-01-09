// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import React, { useState } from 'react'
import { CircleStop, Settings2 } from 'lucide-react'
import MobileModelSelector from '../selector/MobileModelSelector'
import type { Model } from '../selector/ModelSelector'
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
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
  DropdownMenuSeparator,
} from '@/components/ui/dropdown'
import type { Team, GitRepoInfo, GitBranch as GitBranchType, TaskDetail } from '@/types/api'
import type { ContextItem } from '@/types/context'
import { isChatShell } from '../../service/messageService'
import { supportsAttachments } from '../../service/attachmentService'

export interface MobileChatInputControlsProps {
  // Team and Model
  selectedTeam: Team | null
  selectedModel: Model | null
  setSelectedModel: (model: Model | null) => void
  forceOverride: boolean
  setForceOverride: (value: boolean) => void
  teamId?: number | null
  taskId?: number | null
  taskModelId?: string | null

  // Repository and Branch
  showRepositorySelector: boolean
  selectedRepo: GitRepoInfo | null
  setSelectedRepo: (repo: GitRepoInfo | null) => void
  selectedBranch: GitBranchType | null
  setSelectedBranch: (branch: GitBranchType | null) => void
  selectedTaskDetail: TaskDetail | null

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
  isStopping: boolean
  hasMessages: boolean
  shouldHideChatInput: boolean
  isModelSelectionRequired: boolean
  isAttachmentReadyToSend: boolean
  taskInputMessage: string
  isSubtaskStreaming: boolean

  // Actions
  onStopStream: () => void
  onSendMessage: () => void
}

/**
 * Mobile-specific Chat Input Controls
 * Optimized layout for mobile devices with dropdown menu
 */
export function MobileChatInputControls({
  selectedTeam,
  selectedModel,
  setSelectedModel,
  forceOverride,
  setForceOverride,
  teamId,
  taskId,
  taskModelId,
  showRepositorySelector,
  selectedRepo,
  setSelectedRepo,
  selectedBranch,
  setSelectedBranch,
  selectedTaskDetail,
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
  isStopping,
  hasMessages,
  shouldHideChatInput,
  isModelSelectionRequired,
  isAttachmentReadyToSend,
  taskInputMessage,
  isSubtaskStreaming,
  onStopStream,
  onSendMessage,
}: MobileChatInputControlsProps) {
  const [moreMenuOpen, setMoreMenuOpen] = useState(false)

  // Render send button based on state
  const renderSendButton = () => {
    const isDisabled =
      isLoading ||
      isStreaming ||
      isModelSelectionRequired ||
      !isAttachmentReadyToSend ||
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

    if (
      selectedTaskDetail?.status === 'PENDING' &&
      !isSubtaskStreaming &&
      selectedTaskDetail?.is_group_chat
    ) {
      return (
        <SendButton onClick={onSendMessage} disabled={isDisabled} isLoading={isLoading} compact />
      )
    }

    if (selectedTaskDetail?.status === 'PENDING') {
      return <ActionButton disabled variant="loading" icon={<LoadingDots />} />
    }

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

    return (
      <SendButton onClick={onSendMessage} disabled={isDisabled} isLoading={isLoading} compact />
    )
  }

  return (
    <div
      className={`flex items-center justify-between px-3 gap-2 ${shouldHideChatInput ? 'py-3' : 'pb-2 pt-1'}`}
    >
      {/* Left: Attachment, Context, Settings menu */}
      <div className="flex items-center gap-1 flex-shrink-0" data-tour="input-controls">
        {/* Attachment */}
        {supportsAttachments(selectedTeam) && (
          <AttachmentButton onFileSelect={onFileSelect} disabled={isLoading || isStreaming} />
        )}

        {/* Context (Knowledge base) */}
        {isChatShell(selectedTeam) && (
          <ChatContextInput
            selectedContexts={selectedContexts}
            onContextsChange={setSelectedContexts}
          />
        )}

        {/* Settings dropdown */}
        <DropdownMenu open={moreMenuOpen} onOpenChange={setMoreMenuOpen}>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="sm"
              className="h-8 w-8 p-0 rounded-full text-text-muted hover:text-text-primary"
            >
              <Settings2 className="h-4 w-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" side="top" className="w-64 mb-2">
            {/* Clarification Toggle - full row clickable */}
            {isChatShell(selectedTeam) && (
              <MobileClarificationToggle
                enabled={enableClarification}
                onToggle={setEnableClarification}
                disabled={isLoading || isStreaming}
              />
            )}

            {/* Correction Mode Toggle - full row clickable */}
            {isChatShell(selectedTeam) && onCorrectionModeToggle && (
              <MobileCorrectionModeToggle
                enabled={enableCorrectionMode}
                onToggle={onCorrectionModeToggle}
                disabled={isLoading || isStreaming}
                correctionModelName={correctionModelName}
                taskId={selectedTaskDetail?.id ?? null}
              />
            )}

            {/* Repository Selector - full row clickable */}
            {showRepositorySelector && (
              <>
                {/* Only show separator if there's content above (chat shell features) */}
                {isChatShell(selectedTeam) && <DropdownMenuSeparator />}
                <MobileRepositorySelector
                  selectedRepo={selectedRepo}
                  handleRepoChange={setSelectedRepo}
                  disabled={hasMessages}
                  selectedTaskDetail={selectedTaskDetail}
                />
              </>
            )}

            {/* Branch Selector - full row clickable */}
            {showRepositorySelector && selectedRepo && (
              <MobileBranchSelector
                selectedRepo={selectedRepo}
                selectedBranch={selectedBranch}
                handleBranchChange={setSelectedBranch}
                disabled={hasMessages}
                taskDetail={selectedTaskDetail}
              />
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      {/* Right: Model selector, Send button */}
      <div className="flex items-center gap-2 min-w-0 overflow-hidden">
        {selectedTeam && (
          <div className="min-w-0 overflow-hidden">
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
