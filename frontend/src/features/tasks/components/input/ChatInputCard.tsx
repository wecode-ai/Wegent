// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client';

import React from 'react';
import { Upload } from 'lucide-react';
import ChatInput from './ChatInput';
import InputBadgeDisplay from './InputBadgeDisplay';
import ExternalApiParamsInput from '../params/ExternalApiParamsInput';
import { SelectedTeamBadge } from '../selector/SelectedTeamBadge';
import ChatInputControls, { ChatInputControlsProps } from './ChatInputControls';
import type { Team, ChatTipItem } from '@/types/api';
import { isChatShell } from '../../service/messageService';

export interface ChatInputCardProps extends Omit<ChatInputControlsProps, 'taskInputMessage'> {
  // Input message
  taskInputMessage: string;
  setTaskInputMessage: (message: string) => void;

  // Team and external API
  selectedTeam: Team | null;
  externalApiParams: Record<string, string>;
  onExternalApiParamsChange: (params: Record<string, string>) => void;
  onAppModeChange: (mode: string | undefined) => void;

  // Task type
  taskType: 'chat' | 'code';
  autoFocus?: boolean;

  // Tips
  tipText: ChatTipItem | null;

  // Group chat
  isGroupChat: boolean;

  // Drag and drop
  isDragging: boolean;
  onDragEnter: (e: React.DragEvent) => void;
  onDragLeave: (e: React.DragEvent) => void;
  onDragOver: (e: React.DragEvent) => void;
  onDrop: (e: React.DragEvent) => void;

  // Attachment handlers
  onPasteFile?: (files: File | File[]) => void;

  // Submit
  canSubmit: boolean;
  handleSendMessage: (message?: string) => Promise<void>;

  // Ref for container width measurement
  inputControlsRef?: React.RefObject<HTMLDivElement | null>;
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
  externalApiParams,
  onExternalApiParamsChange,
  onAppModeChange,
  taskType,
  autoFocus = false,
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
  // ChatInputControls props
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
}: ChatInputCardProps) {
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

      {/* Chat Input Card */}
      <div
        className={`relative w-full flex flex-col rounded-3xl border border-border bg-base shadow-[0px_4px_24px_0px_rgba(111,79,191,0.06)] transition-colors ${isDragging ? 'border-primary ring-2 ring-primary/20' : ''}`}
        onDragEnter={onDragEnter}
        onDragLeave={onDragLeave}
        onDragOver={onDragOver}
        onDrop={onDrop}
      >
        {/* Drag Overlay */}
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
            setSelectedContexts(selectedContexts.filter(ctx => ctx.id !== contextId));
          }}
          onRemoveAttachment={onAttachmentRemove}
          disabled={isLoading || isStreaming}
        />

        {/* Chat Input with inline badge */}
        {!shouldHideChatInput && (
          <div className="px-4 pt-2">
            <ChatInput
              message={taskInputMessage}
              setMessage={setTaskInputMessage}
              handleSendMessage={handleSendMessage}
              isLoading={isLoading}
              taskType={taskType}
              autoFocus={autoFocus}
              canSubmit={canSubmit}
              tipText={tipText}
              badge={selectedTeam ? <SelectedTeamBadge team={selectedTeam} /> : undefined}
              isGroupChat={isGroupChat}
              team={selectedTeam}
              onPasteFile={isChatShell(selectedTeam) ? onPasteFile : undefined}
            />
          </div>
        )}

        {/* Selected Team Badge only - show when chat input is hidden (workflow mode) */}
        {shouldHideChatInput && selectedTeam && (
          <div className="px-4 pt-3">
            <SelectedTeamBadge team={selectedTeam} />
          </div>
        )}

        {/* Team Selector and Send Button - always show */}
        <div ref={inputControlsRef}>
          <ChatInputControls
            selectedTeam={selectedTeam}
            selectedModel={selectedModel}
            setSelectedModel={setSelectedModel}
            forceOverride={forceOverride}
            setForceOverride={setForceOverride}
            showRepositorySelector={showRepositorySelector}
            selectedRepo={selectedRepo}
            setSelectedRepo={setSelectedRepo}
            selectedBranch={selectedBranch}
            setSelectedBranch={setSelectedBranch}
            selectedTaskDetail={selectedTaskDetail}
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
          />
        </div>
      </div>
    </div>
  );
}

export default ChatInputCard;
