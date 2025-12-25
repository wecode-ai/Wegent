// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { useState, useCallback, useEffect, useRef, useMemo } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useTaskContext } from '../../contexts/taskContext';
import { useChatStreamContext, computeIsStreaming } from '../../contexts/chatStreamContext';
import { useSocket } from '@/contexts/SocketContext';
import { useToast } from '@/hooks/use-toast';
import { useTranslation } from '@/hooks/useTranslation';
import { useUser } from '@/features/common/UserContext';
import { useTraceAction } from '@/hooks/useTraceAction';
import { parseError } from '@/utils/errorParser';
import { taskApis } from '@/apis/tasks';
import { isChatShell } from '../../service/messageService';
import { Button } from '@/components/ui/button';
import { DEFAULT_MODEL_NAME } from '../selector/ModelSelector';
import type { Model } from '../selector/ModelSelector';
import type { Team, GitRepoInfo, GitBranch, Attachment } from '@/types/api';
import type { ContextItem } from '@/types/context';

export interface UseChatStreamHandlersOptions {
  // Team and model
  selectedTeam: Team | null;
  selectedModel: Model | null;
  forceOverride: boolean;

  // Repository
  selectedRepo: GitRepoInfo | null;
  selectedBranch: GitBranch | null;
  showRepositorySelector: boolean;

  // Input
  taskInputMessage: string;
  setTaskInputMessage: (message: string) => void;

  // Loading
  setIsLoading: (value: boolean) => void;

  // Toggles
  enableDeepThinking: boolean;
  enableClarification: boolean;

  // External API
  externalApiParams: Record<string, string>;

  // Attachment (multi-attachment)
  attachments: Attachment[];
  resetAttachment: () => void;
  isAttachmentReadyToSend: boolean;

  // Task type
  taskType: 'chat' | 'code';

  // UI flags
  shouldHideChatInput: boolean;

  // Scroll helper
  scrollToBottom: (force?: boolean) => void;

  // Context selection (knowledge bases)
  selectedContexts?: ContextItem[];
}

export interface ChatStreamHandlers {
  // Stream state
  streamingTaskId: number | null;
  currentStreamState: ReturnType<typeof useChatStreamContext>['getStreamState'] extends (
    id: number
  ) => infer R
    ? R
    : never;
  isStreaming: boolean;
  isSubtaskStreaming: boolean;
  isStopping: boolean;
  hasPendingUserMessage: boolean;
  localPendingMessage: string | null;

  // Actions
  handleSendMessage: (overrideMessage?: string) => Promise<void>;
  handleRetry: (message: {
    content: string;
    type: string;
    error?: string;
    subtaskId?: number;
  }) => Promise<void>;
  handleCancelTask: () => Promise<void>;
  stopStream: () => Promise<void>;
  resetStreamingState: () => void;

  // Group chat handlers
  handleNewMessages: (messages: unknown[]) => void;
  handleStreamComplete: (subtaskId: number, result?: Record<string, unknown>) => void;

  // State
  isCancelling: boolean;
}

/**
 * useChatStreamHandlers Hook
 *
 * Manages all streaming-related logic for the ChatArea component, including:
 * - Sending messages (via WebSocket)
 * - Stopping streams
 * - Retrying failed messages
 * - Cancelling tasks
 * - Tracking streaming state
 * - Group chat message handling
 *
 * This hook extracts all the complex streaming logic from ChatArea
 * to reduce the component size and improve maintainability.
 */
export function useChatStreamHandlers({
  selectedTeam,
  selectedModel,
  forceOverride,
  selectedRepo,
  selectedBranch,
  showRepositorySelector,
  taskInputMessage,
  setTaskInputMessage,
  setIsLoading,
  enableDeepThinking,
  enableClarification,
  externalApiParams,
  attachments,
  resetAttachment,
  isAttachmentReadyToSend,
  taskType,
  shouldHideChatInput,
  scrollToBottom,
  selectedContexts = [],
}: UseChatStreamHandlersOptions): ChatStreamHandlers {
  const { toast } = useToast();
  const { t } = useTranslation('chat');
  const { user } = useUser();
  const { traceAction } = useTraceAction();
  const router = useRouter();
  const searchParams = useSearchParams();

  const { selectedTaskDetail, refreshTasks, refreshSelectedTaskDetail, markTaskAsViewed } =
    useTaskContext();

  const {
    getStreamState,
    isTaskStreaming,
    sendMessage: contextSendMessage,
    stopStream: contextStopStream,
    resumeStream: contextResumeStream,
    clearVersion,
  } = useChatStreamContext();

  const { retryMessage } = useSocket();

  // Local state
  const [streamingTaskId, setStreamingTaskId] = useState<number | null>(null);
  const [localPendingMessage, setLocalPendingMessage] = useState<string | null>(null);
  const [isCancelling, setIsCancelling] = useState(false);

  // Refs
  const lastFailedMessageRef = useRef<string | null>(null);
  const handleSendMessageRef = useRef<((message?: string) => Promise<void>) | null>(null);
  const previousTaskIdRef = useRef<number | null | undefined>(undefined);
  const prevTaskIdForModelRef = useRef<number | null | undefined>(undefined);
  const prevClearVersionRef = useRef(clearVersion);

  // Unified function to reset streaming-related state
  const resetStreamingState = useCallback(() => {
    setLocalPendingMessage(null);
    setStreamingTaskId(null);
  }, []);

  // Get current display task ID
  const currentDisplayTaskId = selectedTaskDetail?.id;

  // Get stream state for the currently displayed task
  const currentStreamState = useMemo(() => {
    if (!currentDisplayTaskId) {
      if (streamingTaskId) {
        return getStreamState(streamingTaskId);
      }
      return undefined;
    }
    return getStreamState(currentDisplayTaskId);
  }, [currentDisplayTaskId, streamingTaskId, getStreamState]);

  // Check streaming states
  const _isStreamingTaskActive = streamingTaskId ? isTaskStreaming(streamingTaskId) : false;
  const isContextStreaming = computeIsStreaming(currentStreamState?.messages);

  const isSubtaskStreaming = useMemo(() => {
    if (!selectedTaskDetail?.subtasks) return false;
    return selectedTaskDetail.subtasks.some(
      subtask => subtask.role === 'assistant' && subtask.status === 'RUNNING'
    );
  }, [selectedTaskDetail?.subtasks]);

  const isStreaming = isSubtaskStreaming || isContextStreaming;
  const isStopping = currentStreamState?.isStopping || false;

  // Check for pending user messages
  const hasPendingUserMessage = useMemo(() => {
    if (localPendingMessage) return true;
    if (!currentStreamState?.messages) return false;
    for (const msg of currentStreamState.messages.values()) {
      if (msg.type === 'user' && msg.status === 'pending') return true;
    }
    return false;
  }, [localPendingMessage, currentStreamState?.messages]);

  // Stop stream wrapper
  const stopStream = useCallback(async () => {
    const taskIdToStop = currentDisplayTaskId || streamingTaskId;

    if (taskIdToStop && taskIdToStop > 0) {
      const team =
        typeof selectedTaskDetail?.team === 'object' ? selectedTaskDetail.team : undefined;
      await contextStopStream(taskIdToStop, selectedTaskDetail?.subtasks, team);
    }
  }, [
    currentDisplayTaskId,
    streamingTaskId,
    contextStopStream,
    selectedTaskDetail?.subtasks,
    selectedTaskDetail?.team,
  ]);

  // Group chat handlers
  const handleNewMessages = useCallback(
    (messages: unknown[]) => {
      if (Array.isArray(messages) && messages.length > 0) {
        refreshSelectedTaskDetail();
      }
    },
    [refreshSelectedTaskDetail]
  );

  const handleStreamComplete = useCallback(
    (_subtaskId: number, _result?: Record<string, unknown>) => {
      refreshSelectedTaskDetail();
    },
    [refreshSelectedTaskDetail]
  );

  // Reset state when clearVersion changes (e.g., "New Chat")
  useEffect(() => {
    if (clearVersion !== prevClearVersionRef.current) {
      console.log('[ChatStreamHandlers] clearVersion changed, resetting state', {
        prev: prevClearVersionRef.current,
        current: clearVersion,
      });
      prevClearVersionRef.current = clearVersion;

      setIsLoading(false);
      setLocalPendingMessage(null);
      setStreamingTaskId(null);
      previousTaskIdRef.current = undefined;
      prevTaskIdForModelRef.current = undefined;
      setIsCancelling(false);
    }
  }, [clearVersion, setIsLoading]);

  // Clear streamingTaskId when switching to a different task
  useEffect(() => {
    if (streamingTaskId && selectedTaskDetail?.id && selectedTaskDetail.id !== streamingTaskId) {
      setStreamingTaskId(null);
    }
  }, [selectedTaskDetail?.id, streamingTaskId]);

  // Reset when navigating to fresh new task state
  useEffect(() => {
    if (!selectedTaskDetail?.id && !streamingTaskId) {
      resetStreamingState();
      setIsLoading(false);
    }
  }, [selectedTaskDetail?.id, streamingTaskId, resetStreamingState, setIsLoading]);

  // Reset when switching to a DIFFERENT task
  useEffect(() => {
    const currentTaskId = selectedTaskDetail?.id;
    const previousTaskId = previousTaskIdRef.current;

    if (
      previousTaskId !== undefined &&
      currentTaskId !== previousTaskId &&
      previousTaskId !== null
    ) {
      resetStreamingState();
    }

    previousTaskIdRef.current = currentTaskId;
  }, [selectedTaskDetail?.id, resetStreamingState]);

  // Try to resume streaming on task change
  useEffect(() => {
    const taskId = selectedTaskDetail?.id;
    if (!taskId) return;
    if (isStreaming) return;
    if (!selectedTeam || !isChatShell(selectedTeam)) return;

    const tryResumeStream = async () => {
      console.log('[ChatStreamHandlers] Trying to resume stream for task', taskId);
      const resumed = await contextResumeStream(taskId, {
        onComplete: (completedTaskId, subtaskId) => {
          console.log('[ChatStreamHandlers] Resumed stream completed', {
            completedTaskId,
            subtaskId,
          });
          refreshSelectedTaskDetail(false);
        },
        onError: error => {
          console.error('[ChatStreamHandlers] Resumed stream error', error);
        },
      });

      if (resumed) {
        console.log('[ChatStreamHandlers] Stream resumed successfully for task', taskId);
        setStreamingTaskId(taskId);
      }
    };

    tryResumeStream();
  }, [
    selectedTaskDetail?.id,
    selectedTeam,
    isStreaming,
    contextResumeStream,
    refreshSelectedTaskDetail,
  ]);

  // Helper: create retry button
  const createRetryButton = useCallback(
    (onRetryClick: () => void) => (
      <Button variant="outline" size="sm" onClick={onRetryClick}>
        {t('actions.retry') || '重试'}
      </Button>
    ),
    [t]
  );

  // Helper: handle send errors
  const handleSendError = useCallback(
    (error: Error, message: string) => {
      resetStreamingState();
      const parsedError = parseError(error);
      lastFailedMessageRef.current = message;

      toast({
        variant: 'destructive',
        title: parsedError.retryable
          ? t('errors.request_failed_retry')
          : t('errors.model_unsupported'),
        action: parsedError.retryable
          ? createRetryButton(() => {
              if (lastFailedMessageRef.current && handleSendMessageRef.current) {
                handleSendMessageRef.current(lastFailedMessageRef.current);
              }
            })
          : undefined,
      });
    },
    [resetStreamingState, toast, t, createRetryButton]
  );

  // Core message sending logic
  const handleSendMessage = useCallback(
    async (overrideMessage?: string) => {
      const message = overrideMessage?.trim() || taskInputMessage.trim();
      if (!message && !shouldHideChatInput) return;

      if (!isAttachmentReadyToSend) {
        toast({
          variant: 'destructive',
          title: '请等待文件上传完成',
        });
        return;
      }

      // For code type tasks, repository is required
      const effectiveRepo =
        selectedRepo ||
        (selectedTaskDetail
          ? {
              git_url: selectedTaskDetail.git_url,
              git_repo: selectedTaskDetail.git_repo,
              git_repo_id: selectedTaskDetail.git_repo_id,
              git_domain: selectedTaskDetail.git_domain,
            }
          : null);

      if (taskType === 'code' && showRepositorySelector && !effectiveRepo?.git_repo) {
        toast({
          variant: 'destructive',
          title: 'Please select a repository for code tasks',
        });
        return;
      }

      setIsLoading(true);

      console.log('[ChatStreamHandlers] handleSendMessage - using unified WebSocket mode:', {
        selectedTeam: selectedTeam?.name,
        selectedTeamId: selectedTeam?.id,
        agentType: selectedTeam?.agent_type,
        taskType: taskType,
        attachmentIds: attachments.map(a => a.id),
      });

      // Set local pending state immediately
      setLocalPendingMessage(message);
      setTaskInputMessage('');
      resetAttachment();

      // Model ID handling
      const modelId = selectedModel?.name === DEFAULT_MODEL_NAME ? undefined : selectedModel?.name;

      // Prepare message with external API parameters
      let finalMessage = message;
      if (Object.keys(externalApiParams).length > 0) {
        const paramsJson = JSON.stringify(externalApiParams);
        finalMessage = `[EXTERNAL_API_PARAMS]${paramsJson}[/EXTERNAL_API_PARAMS]\n${message}`;
      }

      try {
        const immediateTaskId = selectedTaskDetail?.id || -Date.now();

        // Convert selected contexts to backend format
        // Each context item contains type and data fields
        const contextItems = selectedContexts.map(ctx => {
          if (ctx.type === 'knowledge_base') {
            // Type assertion for knowledge base context with retriever info
            const kbContext = ctx as ContextItem & {
              retriever_name?: string;
              retriever_namespace?: string;
            };
            return {
              type: 'knowledge_base',
              data: {
                knowledge_id: ctx.id,
                retriever_name: kbContext.retriever_name || '',
                retriever_namespace: kbContext.retriever_namespace || 'default',
              },
            };
          }
          // Future: handle other context types here
          return {
            type: ctx.type,
            data: { id: ctx.id, name: ctx.name },
          };
        });

        const tempTaskId = await contextSendMessage(
          {
            message: finalMessage,
            team_id: selectedTeam?.id ?? 0,
            task_id: selectedTaskDetail?.id,
            model_id: modelId,
            force_override_bot_model: forceOverride,
            attachment_ids: attachments.map(a => a.id),
            enable_deep_thinking: enableDeepThinking,
            enable_clarification: enableClarification,
            is_group_chat: selectedTaskDetail?.is_group_chat || false,
            git_url: showRepositorySelector ? effectiveRepo?.git_url : undefined,
            git_repo: showRepositorySelector ? effectiveRepo?.git_repo : undefined,
            git_repo_id: showRepositorySelector ? effectiveRepo?.git_repo_id : undefined,
            git_domain: showRepositorySelector ? effectiveRepo?.git_domain : undefined,
            branch_name: showRepositorySelector
              ? selectedBranch?.name || selectedTaskDetail?.branch_name
              : undefined,
            task_type: taskType,
            contexts: contextItems.length > 0 ? contextItems : undefined,
          },
          {
            pendingUserMessage: message,
            pendingAttachments: attachments,
            immediateTaskId: immediateTaskId,
            currentUserId: user?.id,
            currentUserName: user?.user_name,
            onMessageSent: (
              _localMessageId: string,
              completedTaskId: number,
              _subtaskId: number
            ) => {
              if (completedTaskId > 0) {
                setStreamingTaskId(completedTaskId);
              }

              if (completedTaskId && !selectedTaskDetail?.id) {
                const params = new URLSearchParams(Array.from(searchParams.entries()));
                params.set('taskId', String(completedTaskId));
                router.push(`?${params.toString()}`);
                refreshTasks();
              }

              if (selectedTaskDetail?.is_group_chat && completedTaskId) {
                markTaskAsViewed(
                  completedTaskId,
                  selectedTaskDetail.status,
                  new Date().toISOString()
                );
              }
            },
            onError: (error: Error) => {
              handleSendError(error, message);
            },
          }
        );

        if (tempTaskId !== immediateTaskId && tempTaskId > 0) {
          setStreamingTaskId(tempTaskId);
        }

        setTimeout(() => scrollToBottom(true), 0);
      } catch (err) {
        handleSendError(err as Error, message);
      }

      setIsLoading(false);
    },
    [
      taskInputMessage,
      shouldHideChatInput,
      isAttachmentReadyToSend,
      toast,
      selectedTeam,
      attachments,
      resetAttachment,
      selectedModel?.name,
      selectedTaskDetail,
      contextSendMessage,
      forceOverride,
      enableDeepThinking,
      enableClarification,
      refreshTasks,
      searchParams,
      router,
      showRepositorySelector,
      selectedRepo,
      selectedBranch,
      taskType,
      markTaskAsViewed,
      user?.id,
      user?.user_name,
      handleSendError,
      scrollToBottom,
      setIsLoading,
      setTaskInputMessage,
      externalApiParams,
    ]
  );

  // Update ref when handleSendMessage changes
  useEffect(() => {
    handleSendMessageRef.current = handleSendMessage;
  }, [handleSendMessage]);

  // Handle retry for failed messages
  const handleRetry = useCallback(
    async (message: { content: string; type: string; error?: string; subtaskId?: number }) => {
      if (!message.subtaskId) {
        toast({
          variant: 'destructive',
          title: t('errors.request_failed_retry'),
          description: 'Subtask ID not found',
        });
        return;
      }

      if (!selectedTaskDetail?.id) {
        toast({
          variant: 'destructive',
          title: t('errors.request_failed_retry'),
          description: 'Task ID not found',
        });
        return;
      }

      await traceAction(
        'chat-retry-message',
        {
          'action.type': 'retry',
          'task.id': selectedTaskDetail.id.toString(),
          'subtask.id': message.subtaskId.toString(),
          ...(selectedModel && { 'model.id': selectedModel.name }),
        },
        async () => {
          try {
            const modelId =
              selectedModel?.name === DEFAULT_MODEL_NAME ? undefined : selectedModel?.name;
            const modelType = modelId ? selectedModel?.type : undefined;

            const result = await retryMessage(
              selectedTaskDetail.id,
              message.subtaskId!,
              modelId,
              modelType,
              forceOverride
            );

            if (result.error) {
              toast({
                variant: 'destructive',
                title: t('errors.request_failed_retry'),
              });
            }
          } catch (error) {
            console.error('[ChatStreamHandlers] Retry failed:', error);
            toast({
              variant: 'destructive',
              title: t('errors.request_failed_retry'),
            });
            throw error;
          }
        }
      );
    },
    [retryMessage, selectedTaskDetail?.id, selectedModel, forceOverride, t, toast, traceAction]
  );

  // Handle cancel task
  const handleCancelTask = useCallback(async () => {
    if (!selectedTaskDetail?.id || isCancelling) return;

    setIsCancelling(true);

    try {
      const timeoutPromise = new Promise((_, reject) => {
        setTimeout(() => reject(new Error('Cancel operation timed out')), 60000);
      });

      await Promise.race([taskApis.cancelTask(selectedTaskDetail.id), timeoutPromise]);

      toast({
        title: 'Task cancelled successfully',
        description: 'The task has been cancelled.',
      });

      refreshTasks();
      refreshSelectedTaskDetail(false);
    } catch (err: unknown) {
      const errorMessage =
        err instanceof Error && err.message === 'Cancel operation timed out'
          ? 'Cancel operation timed out, please check task status later'
          : 'Failed to cancel task';

      toast({
        variant: 'destructive',
        title: errorMessage,
        action: (
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              setIsCancelling(false);
              handleCancelTask();
            }}
          >
            Retry
          </Button>
        ),
      });

      console.error('Cancel task failed:', err);

      if (err instanceof Error && err.message === 'Cancel operation timed out') {
        refreshTasks();
        refreshSelectedTaskDetail(false);
      }
    } finally {
      setIsCancelling(false);
    }
  }, [selectedTaskDetail?.id, isCancelling, toast, refreshTasks, refreshSelectedTaskDetail]);

  return {
    // Stream state
    streamingTaskId,
    currentStreamState,
    isStreaming,
    isSubtaskStreaming,
    isStopping,
    hasPendingUserMessage,
    localPendingMessage,

    // Actions
    handleSendMessage,
    handleRetry,
    handleCancelTask,
    stopStream,
    resetStreamingState,

    // Group chat handlers
    handleNewMessages,
    handleStreamComplete,

    // State
    isCancelling,
  };
}

export default useChatStreamHandlers;
