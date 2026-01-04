// SPDX-FileCopyrightText: 2025 WeCode, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client';

import React, { useEffect, useCallback, useMemo } from 'react';
import { ShieldX } from 'lucide-react';
import MessagesArea from '../message/MessagesArea';
import { QuickAccessCards } from './QuickAccessCards';
import { SloganDisplay } from './SloganDisplay';
import { ChatInputCard } from '../input/ChatInputCard';
import { useChatAreaState } from './useChatAreaState';
import { useChatStreamHandlers } from './useChatStreamHandlers';
import { allBotsHavePredefinedModel } from '../selector/ModelSelector';
import type { Team } from '@/types/api';
import { useTranslation } from '@/hooks/useTranslation';
import { useRouter } from 'next/navigation';
import { useTaskContext } from '../../contexts/taskContext';
import { useChatStreamContext } from '../../contexts/chatStreamContext';
import { Button } from '@/components/ui/button';
import { useScrollManagement } from '../hooks/useScrollManagement';
import { useFloatingInput } from '../hooks/useFloatingInput';
import { useTeamPreferences } from '../hooks/useTeamPreferences';
import { useAttachmentUpload } from '../hooks/useAttachmentUpload';

/**
 * Threshold in pixels for determining when to collapse selectors.
 * When the controls container width is less than this value, selectors will collapse.
 */
const COLLAPSE_SELECTORS_THRESHOLD = 420;

interface ChatAreaProps {
  teams: Team[];
  isTeamsLoading: boolean;
  selectedTeamForNewTask?: Team | null;
  showRepositorySelector?: boolean;
  taskType?: 'chat' | 'code';
  onShareButtonRender?: (button: React.ReactNode) => void;
  onRefreshTeams?: () => Promise<Team[]>;
}

export default function ChatArea({
  teams,
  isTeamsLoading,
  selectedTeamForNewTask,
  showRepositorySelector = true,
  taskType = 'chat',
  onShareButtonRender,
  onRefreshTeams,
}: ChatAreaProps) {
  const { t } = useTranslation();
  const router = useRouter();

  // Task context
  const { selectedTaskDetail, setSelectedTask, accessDenied, clearAccessDenied } = useTaskContext();

  // Stream context for clearVersion and getStreamState
  // getStreamState is used to access messages (SINGLE SOURCE OF TRUTH per AGENTS.md)
  const { clearVersion, getStreamState } = useChatStreamContext();

  // Get stream state for current task to check messages
  const currentStreamState = selectedTaskDetail?.id
    ? getStreamState(selectedTaskDetail.id)
    : undefined;

  // Chat area state (team, repo, branch, model, input, toggles, etc.)
  const chatState = useChatAreaState({
    teams,
    taskType,
    selectedTeamForNewTask,
  });

  // Compute subtask info for scroll management
  const subtaskList = selectedTaskDetail?.subtasks ?? [];
  const lastSubtask = subtaskList.length ? subtaskList[subtaskList.length - 1] : null;
  const lastSubtaskId = lastSubtask?.id ?? null;
  const lastSubtaskUpdatedAt = lastSubtask?.updated_at || lastSubtask?.completed_at || null;
  // Determine if there are messages to display (computed early for hooks)
  // Uses context messages as the single source of truth, not selectedTaskDetail.subtasks
  const hasMessagesForHooks = useMemo(() => {
    const hasSelectedTask = selectedTaskDetail && selectedTaskDetail.id;
    // Check messages from context (single source of truth)
    const hasContextMessages = currentStreamState?.messages && currentStreamState.messages.size > 0;
    return Boolean(hasSelectedTask || hasContextMessages);
  }, [selectedTaskDetail, currentStreamState?.messages]);

  // Use scroll management hook - consolidates 4 useEffect calls
  const {
    scrollContainerRef,
    isUserNearBottomRef,
    scrollToBottom,
    handleMessagesContentChange: _baseHandleMessagesContentChange,
  } = useScrollManagement({
    hasMessages: hasMessagesForHooks,
    isStreaming: false, // Will be updated after streamHandlers is created
    selectedTaskId: selectedTaskDetail?.id,
    lastSubtaskId,
    lastSubtaskUpdatedAt,
  });

  // Use floating input hook - consolidates 3 useEffect calls
  const {
    chatAreaRef,
    floatingInputRef,
    inputControlsRef,
    floatingMetrics,
    inputHeight,
    controlsContainerWidth,
  } = useFloatingInput({
    hasMessages: hasMessagesForHooks,
  });

  // Stream handlers (send message, retry, cancel, stop)
  const streamHandlers = useChatStreamHandlers({
    selectedTeam: chatState.selectedTeam,
    selectedModel: chatState.selectedModel,
    forceOverride: chatState.forceOverride,
    selectedRepo: chatState.selectedRepo,
    selectedBranch: chatState.selectedBranch,
    showRepositorySelector,
    taskInputMessage: chatState.taskInputMessage,
    setTaskInputMessage: chatState.setTaskInputMessage,
    setIsLoading: chatState.setIsLoading,
    enableDeepThinking: chatState.enableDeepThinking,
    enableClarification: chatState.enableClarification,
    externalApiParams: chatState.externalApiParams,
    attachments: chatState.attachmentState.attachments,
    resetAttachment: chatState.resetAttachment,
    isAttachmentReadyToSend: chatState.isAttachmentReadyToSend,
    taskType,
    shouldHideChatInput: chatState.shouldHideChatInput,
    scrollToBottom,
    selectedContexts: chatState.selectedContexts,
    resetContexts: chatState.resetContexts,
  });

  // Determine if there are messages to display (full computation)
  const hasMessages = useMemo(() => {
    const hasSelectedTask = selectedTaskDetail && selectedTaskDetail.id;
    const hasNewTaskStream =
      !selectedTaskDetail?.id && streamHandlers.pendingTaskId && streamHandlers.isStreaming;
    const hasSubtasks = selectedTaskDetail?.subtasks && selectedTaskDetail.subtasks.length > 0;
    const hasLocalPending = streamHandlers.localPendingMessage !== null;
    const hasUnifiedMessages =
      streamHandlers.currentStreamState?.messages &&
      streamHandlers.currentStreamState.messages.size > 0;

    if (hasSelectedTask && hasSubtasks) {
      return true;
    }

    return Boolean(
      hasSelectedTask ||
      streamHandlers.hasPendingUserMessage ||
      streamHandlers.isStreaming ||
      hasNewTaskStream ||
      hasLocalPending ||
      hasUnifiedMessages
    );
  }, [
    selectedTaskDetail,
    streamHandlers.hasPendingUserMessage,
    streamHandlers.isStreaming,
    streamHandlers.pendingTaskId,
    streamHandlers.localPendingMessage,
    streamHandlers.currentStreamState?.messages,
  ]);

  // Use team preferences hook - consolidates team preference logic
  // Note: Model selection is now handled by useModelSelection hook in ModelSelector
  useTeamPreferences({
    teams,
    hasMessages,
    selectedTaskDetail,
    selectedTeam: chatState.selectedTeam,
    setSelectedTeam: chatState.setSelectedTeam,
    hasRestoredPreferences: chatState.hasRestoredPreferences,
    setHasRestoredPreferences: chatState.setHasRestoredPreferences,
    isTeamCompatibleWithMode: chatState.isTeamCompatibleWithMode,
    initialTeamIdRef: chatState.initialTeamIdRef,
    clearVersion,
  });

  // Check if model selection is required
  const isModelSelectionRequired = useMemo(() => {
    if (!chatState.selectedTeam || chatState.selectedTeam.agent_type === 'dify') return false;
    const hasDefaultOption = allBotsHavePredefinedModel(chatState.selectedTeam);
    if (hasDefaultOption) return false;
    return !chatState.selectedModel;
  }, [chatState.selectedTeam, chatState.selectedModel]);

  // Unified canSubmit flag
  const canSubmit = useMemo(() => {
    return (
      !chatState.isLoading &&
      !streamHandlers.isStreaming &&
      !isModelSelectionRequired &&
      chatState.isAttachmentReadyToSend
    );
  }, [
    chatState.isLoading,
    streamHandlers.isStreaming,
    isModelSelectionRequired,
    chatState.isAttachmentReadyToSend,
  ]);

  // Collapse selectors when space is limited
  const shouldCollapseSelectors =
    controlsContainerWidth > 0 && controlsContainerWidth < COLLAPSE_SELECTORS_THRESHOLD;

  // Load prompt from sessionStorage - single remaining useEffect
  useEffect(() => {
    if (hasMessages) return;

    const pendingPromptData = sessionStorage.getItem('pendingTaskPrompt');
    if (pendingPromptData) {
      try {
        const data = JSON.parse(pendingPromptData);
        const isRecent = Date.now() - data.timestamp < 5 * 60 * 1000;

        if (isRecent && data.prompt) {
          chatState.setTaskInputMessage(data.prompt);
          sessionStorage.removeItem('pendingTaskPrompt');
        }
      } catch (error) {
        console.error('Failed to parse pending prompt data:', error);
        sessionStorage.removeItem('pendingTaskPrompt');
      }
    }
  }, [hasMessages, chatState]);

  // Use attachment upload hook - centralizes all attachment upload logic
  const { handleDragEnter, handleDragLeave, handleDragOver, handleDrop, handlePasteFile } =
    useAttachmentUpload({
      team: chatState.selectedTeam,
      isLoading: chatState.isLoading,
      isStreaming: streamHandlers.isStreaming,
      attachmentState: chatState.attachmentState,
      onFileSelect: chatState.handleFileSelect,
      setIsDragging: chatState.setIsDragging,
    });

  // Callback for MessagesArea content changes - enhanced with streaming check
  const handleMessagesContentChange = useCallback(() => {
    if (streamHandlers.isStreaming || isUserNearBottomRef.current) {
      scrollToBottom();
    }
  }, [streamHandlers.isStreaming, scrollToBottom, isUserNearBottomRef]);

  // Callback for child components to send messages
  const handleSendMessageFromChild = useCallback(
    async (content: string) => {
      const existingInput = chatState.taskInputMessage.trim();
      const combinedMessage = existingInput ? `${content}\n\n---\n\n${existingInput}` : content;
      chatState.setTaskInputMessage('');
      await streamHandlers.handleSendMessage(combinedMessage);
    },
    [chatState, streamHandlers]
  );

  // Handle access denied state
  if (accessDenied) {
    const handleGoHome = () => {
      clearAccessDenied();
      setSelectedTask(null);
      router.push('/chat');
    };

    return (
      <div
        ref={chatAreaRef}
        className="flex-1 flex flex-col min-h-0 w-full relative"
        style={{ height: '100%', boxSizing: 'border-box' }}
      >
        <div className="flex-1 flex items-center justify-center p-6">
          <div className="max-w-lg w-full">
            <div className="flex justify-center mb-6">
              <div className="w-20 h-20 rounded-full bg-destructive/10 flex items-center justify-center">
                <ShieldX className="h-10 w-10 text-destructive" />
              </div>
            </div>
            <h1 className="text-2xl font-semibold text-center mb-3 text-text-primary">
              {t('tasks:access_denied_title')}
            </h1>
            <p className="text-center text-text-muted mb-8 leading-relaxed">
              {t('tasks:access_denied_description')}
            </p>
            <div className="flex justify-center">
              <Button
                onClick={handleGoHome}
                variant="default"
                size="default"
                className="min-w-[160px]"
              >
                {t('tasks:access_denied_go_home')}
              </Button>
            </div>
          </div>
        </div>
      </div>
    );
  }

  // Common input card props
  const inputCardProps = {
    taskInputMessage: chatState.taskInputMessage,
    setTaskInputMessage: chatState.setTaskInputMessage,
    selectedTeam: chatState.selectedTeam,
    externalApiParams: chatState.externalApiParams,
    onExternalApiParamsChange: chatState.handleExternalApiParamsChange,
    onAppModeChange: chatState.handleAppModeChange,
    taskType,
    tipText: chatState.randomTip,
    isGroupChat: selectedTaskDetail?.is_group_chat || false,
    isDragging: chatState.isDragging,
    onDragEnter: handleDragEnter,
    onDragLeave: handleDragLeave,
    onDragOver: handleDragOver,
    onDrop: handleDrop,
    canSubmit,
    handleSendMessage: streamHandlers.handleSendMessage,
    onPasteFile: handlePasteFile,
    // ChatInputControls props
    selectedModel: chatState.selectedModel,
    setSelectedModel: chatState.setSelectedModel,
    forceOverride: chatState.forceOverride,
    setForceOverride: chatState.setForceOverride,
    teamId: chatState.selectedTeam?.id,
    taskId: selectedTaskDetail?.id,
    showRepositorySelector,
    selectedRepo: chatState.selectedRepo,
    setSelectedRepo: chatState.setSelectedRepo,
    selectedBranch: chatState.selectedBranch,
    setSelectedBranch: chatState.setSelectedBranch,
    selectedTaskDetail,
    enableDeepThinking: chatState.enableDeepThinking,
    setEnableDeepThinking: chatState.setEnableDeepThinking,
    enableClarification: chatState.enableClarification,
    setEnableClarification: chatState.setEnableClarification,
    enableCorrectionMode: chatState.enableCorrectionMode,
    correctionModelName: chatState.correctionModelName,
    onCorrectionModeToggle: chatState.handleCorrectionModeToggle,
    selectedContexts: chatState.selectedContexts,
    setSelectedContexts: chatState.setSelectedContexts,
    attachmentState: chatState.attachmentState,
    onFileSelect: chatState.handleFileSelect,
    onAttachmentRemove: chatState.handleAttachmentRemove,
    isLoading: chatState.isLoading,
    isStreaming: streamHandlers.isStreaming,
    isStopping: streamHandlers.isStopping,
    hasMessages,
    shouldCollapseSelectors,
    shouldHideQuotaUsage: chatState.shouldHideQuotaUsage,
    shouldHideChatInput: chatState.shouldHideChatInput,
    isModelSelectionRequired,
    isAttachmentReadyToSend: chatState.isAttachmentReadyToSend,
    isSubtaskStreaming: streamHandlers.isSubtaskStreaming,
    onStopStream: streamHandlers.stopStream,
    onSendMessage: () => streamHandlers.handleSendMessage(),
  };

  return (
    <div
      ref={chatAreaRef}
      className="flex-1 flex flex-col min-h-0 w-full relative"
      style={{ height: '100%', boxSizing: 'border-box' }}
    >
      {/* Messages Area: always mounted to keep scroll container stable */}
      <div className={hasMessages ? 'relative flex-1 min-h-0' : 'relative'}>
        {/* Top gradient fade effect */}
        {hasMessages && (
          <div
            className="absolute top-0 left-0 right-0 h-12 z-10 pointer-events-none"
            style={{
              background:
                'linear-gradient(to bottom, rgb(var(--color-bg-base)) 0%, rgb(var(--color-bg-base) / 0.8) 40%, rgb(var(--color-bg-base) / 0) 100%)',
            }}
          />
        )}
        <div
          ref={scrollContainerRef}
          className={
            (hasMessages ? 'h-full overflow-y-auto custom-scrollbar' : 'overflow-y-hidden') +
            ' transition-opacity duration-200 ' +
            (hasMessages ? 'opacity-100' : 'opacity-0 pointer-events-none h-0')
          }
          aria-hidden={!hasMessages}
          style={{ paddingBottom: hasMessages ? `${inputHeight + 16}px` : '0' }}
        >
          <div className="w-full max-w-5xl mx-auto px-4 sm:px-6 pt-12">
            <MessagesArea
              selectedTeam={chatState.selectedTeam}
              selectedRepo={chatState.selectedRepo}
              selectedBranch={chatState.selectedBranch}
              onContentChange={handleMessagesContentChange}
              onShareButtonRender={onShareButtonRender}
              onSendMessage={handleSendMessageFromChild}
              isGroupChat={selectedTaskDetail?.is_group_chat || false}
              onRetry={streamHandlers.handleRetry}
              enableCorrectionMode={chatState.enableCorrectionMode}
              correctionModelId={chatState.correctionModelId}
              enableCorrectionWebSearch={chatState.enableCorrectionWebSearch}
              hasMessages={hasMessages}
              pendingTaskId={streamHandlers.pendingTaskId}
            />
          </div>
        </div>
      </div>

      {/* Main Content Area */}
      <div className={hasMessages ? 'w-full' : 'flex-1 flex flex-col w-full'}>
        {/* Center area for input when no messages */}
        {!hasMessages && (
          <div
            className="flex-1 flex items-center justify-center w-full"
            style={{ marginBottom: '20vh' }}
          >
            <div ref={floatingInputRef} className="w-full max-w-4xl mx-auto px-4 sm:px-6">
              <SloganDisplay slogan={chatState.randomSlogan} />
              <ChatInputCard
                {...inputCardProps}
                autoFocus={!hasMessages}
                inputControlsRef={inputControlsRef}
              />
              <QuickAccessCards
                teams={teams}
                selectedTeam={chatState.selectedTeam}
                onTeamSelect={chatState.handleTeamChange}
                currentMode={taskType}
                isLoading={isTeamsLoading}
                isTeamsLoading={isTeamsLoading}
                hideSelected={true}
                onRefreshTeams={onRefreshTeams}
                showWizardButton={taskType === 'chat'}
              />
            </div>
          </div>
        )}

        {/* Floating Input Area for messages view */}
        {hasMessages && (
          <div
            ref={floatingInputRef}
            className="fixed bottom-0 z-50"
            style={{
              left: floatingMetrics.left,
              width: floatingMetrics.width,
            }}
          >
            {/* Gradient background - contained within the floating input bounds */}
            <div className="absolute inset-0 bg-gradient-to-t from-base via-base/95 to-base/0 pointer-events-none" />
            <div className="relative z-10 w-full max-w-4xl mx-auto px-4 sm:px-6 py-4">
              <ChatInputCard {...inputCardProps} />
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
