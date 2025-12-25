// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client';

import React from 'react';
import { CircleStop } from 'lucide-react';
import ModelSelector, { Model } from '../selector/ModelSelector';
import RepositorySelector from '../selector/RepositorySelector';
import BranchSelector from '../selector/BranchSelector';
import DeepThinkingToggle from './DeepThinkingToggle';
import ClarificationToggle from '../clarification/ClarificationToggle';
import ChatContextInput from '../chat/ChatContextInput';
import AttachmentButton from '../AttachmentButton';
import SendButton from './SendButton';
import LoadingDots from '../message/LoadingDots';
import QuotaUsage from '../params/QuotaUsage';
import { Button } from '@/components/ui/button';
import type {
  Team,
  GitRepoInfo,
  GitBranch,
  TaskDetail,
  MultiAttachmentUploadState,
} from '@/types/api';
import type { ContextItem } from '@/types/context';
import { isChatShell } from '../../service/messageService';

export interface ChatInputControlsProps {
  // Team and Model
  selectedTeam: Team | null;
  selectedModel: Model | null;
  setSelectedModel: (model: Model | null) => void;
  forceOverride: boolean;
  setForceOverride: (value: boolean) => void;

  // Repository and Branch
  showRepositorySelector: boolean;
  selectedRepo: GitRepoInfo | null;
  setSelectedRepo: (repo: GitRepoInfo | null) => void;
  selectedBranch: GitBranch | null;
  setSelectedBranch: (branch: GitBranch | null) => void;
  selectedTaskDetail: TaskDetail | null;

  // Deep Thinking and Clarification
  enableDeepThinking: boolean;
  setEnableDeepThinking: (value: boolean) => void;
  enableClarification: boolean;
  setEnableClarification: (value: boolean) => void;

  // Context selection (knowledge bases)
  selectedContexts: ContextItem[];
  setSelectedContexts: (contexts: ContextItem[]) => void;

  // Attachment (multi-attachment)
  attachmentState: MultiAttachmentUploadState;
  onFileSelect: (files: File | File[]) => void;
  onAttachmentRemove: (attachmentId: number) => void;

  // State flags
  isLoading: boolean;
  isStreaming: boolean;
  isStopping: boolean;
  hasMessages: boolean;
  shouldCollapseSelectors: boolean;
  shouldHideQuotaUsage: boolean;
  shouldHideChatInput: boolean;
  isModelSelectionRequired: boolean;
  isAttachmentReadyToSend: boolean;
  taskInputMessage: string;
  isSubtaskStreaming: boolean;

  // Actions
  onStopStream: () => void;
  onSendMessage: () => void;
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
  selectedModel,
  setSelectedModel,
  forceOverride,
  setForceOverride,
  showRepositorySelector,
  selectedRepo,
  setSelectedRepo,
  selectedBranch,
  setSelectedBranch,
  selectedTaskDetail,
  enableDeepThinking,
  setEnableDeepThinking,
  enableClarification,
  setEnableClarification,
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
}: ChatInputControlsProps) {
  // Always use compact mode (icon only) to save space
  const shouldUseCompactQuota = true;

  // Determine the send button state
  const renderSendButton = () => {
    const isDisabled =
      isLoading ||
      isStreaming ||
      isModelSelectionRequired ||
      !isAttachmentReadyToSend ||
      (shouldHideChatInput ? false : !taskInputMessage.trim());

    if (isStreaming || isStopping) {
      if (isStopping) {
        return (
          <div className="relative h-6 w-6 flex items-center justify-center flex-shrink-0 translate-y-0.5">
            <div className="absolute inset-0 rounded-full border-2 border-orange-200 border-t-orange-500 animate-spin" />
            <CircleStop className="h-4 w-4 text-orange-500" />
          </div>
        );
      }
      return (
        <Button
          variant="ghost"
          size="icon"
          onClick={onStopStream}
          className="h-6 w-6 rounded-full hover:bg-orange-100 flex-shrink-0 translate-y-0.5"
          title="Stop generating"
        >
          <CircleStop className="h-5 w-5 text-orange-500" />
        </Button>
      );
    }

    // For group chat: if task status is PENDING but no AI subtask is running,
    // show normal send button instead of loading animation.
    if (
      selectedTaskDetail?.status === 'PENDING' &&
      !isSubtaskStreaming &&
      selectedTaskDetail?.is_group_chat
    ) {
      return <SendButton onClick={onSendMessage} disabled={isDisabled} isLoading={isLoading} />;
    }

    // For non-group-chat tasks with PENDING status, show loading animation
    if (selectedTaskDetail?.status === 'PENDING') {
      return (
        <Button
          variant="ghost"
          size="icon"
          disabled
          className="h-6 w-6 rounded-full flex-shrink-0 translate-y-0.5"
        >
          <LoadingDots />
        </Button>
      );
    }

    // CANCELLING status
    if (selectedTaskDetail?.status === 'CANCELLING') {
      return (
        <div className="relative h-6 w-6 flex items-center justify-center flex-shrink-0 translate-y-0.5">
          <div className="absolute inset-0 rounded-full border-2 border-orange-200 border-t-orange-500 animate-spin" />
          <CircleStop className="h-5 w-5 text-orange-500" />
        </div>
      );
    }

    // Default send button
    return <SendButton onClick={onSendMessage} disabled={isDisabled} isLoading={isLoading} />;
  };

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
          />
        )}

        {/* File Upload Button - always show for chat shell */}
        {isChatShell(selectedTeam) && (
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
          />
        )}

        {/* Repository and Branch Selectors - inside input box */}
        {showRepositorySelector && (
          <>
            <RepositorySelector
              selectedRepo={selectedRepo}
              handleRepoChange={setSelectedRepo}
              disabled={hasMessages}
              selectedTaskDetail={selectedTaskDetail}
              compact={shouldCollapseSelectors}
            />

            {selectedRepo && (
              <BranchSelector
                selectedRepo={selectedRepo}
                selectedBranch={selectedBranch}
                handleBranchChange={setSelectedBranch}
                disabled={hasMessages}
                compact={shouldCollapseSelectors}
              />
            )}
          </>
        )}
      </div>

      <div className="ml-auto flex items-center gap-2 flex-shrink-0">
        {/* Quota Usage */}
        {!shouldHideQuotaUsage && (
          <QuotaUsage className="flex-shrink-0" compact={shouldUseCompactQuota} />
        )}

        {/* Deep Thinking Toggle Button - only show for chat shell */}
        {isChatShell(selectedTeam) && (
          <DeepThinkingToggle
            enabled={enableDeepThinking}
            onToggle={setEnableDeepThinking}
            disabled={isLoading || isStreaming}
          />
        )}

        {/* Send/Stop Button */}
        {renderSendButton()}
      </div>
    </div>
  );
}

export default ChatInputControls;
