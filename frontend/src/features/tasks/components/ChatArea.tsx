// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client';

import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { Send, CircleStop, Upload } from 'lucide-react';
import MessagesArea from './MessagesArea';
import ChatInput from './ChatInput';
import TeamSelector from './TeamSelector';
import ModelSelector, {
  Model,
  DEFAULT_MODEL_NAME,
  allBotsHavePredefinedModel,
} from './ModelSelector';
import RepositorySelector from './RepositorySelector';
import BranchSelector from './BranchSelector';
import LoadingDots from './LoadingDots';
import ExternalApiParamsInput from './ExternalApiParamsInput';
import FileUpload from './FileUpload';
import ExportPdfButton, { type SelectableMessage } from './ExportPdfButton';
import type { Team, GitRepoInfo, GitBranch, Attachment, TaskDetailSubtask } from '@/types/api';
import { sendMessage, isChatShell } from '../service/messageService';
import { useRouter, useSearchParams } from 'next/navigation';
import { useTaskContext } from '../contexts/taskContext';
import { useChatStreamContext } from '../contexts/chatStreamContext';
import { Button } from '@/components/ui/button';
import QuotaUsage from './QuotaUsage';
import { useMediaQuery } from '@/hooks/useMediaQuery';
import { saveLastTeam, getLastTeamId, saveLastRepo } from '@/utils/userPreferences';
import { useToast } from '@/hooks/use-toast';
import { taskApis } from '@/apis/tasks';
import { useAttachment } from '@/hooks/useAttachment';

const SHOULD_HIDE_QUOTA_NAME_LIMIT = 18;
// Threshold for combined team name + model name length to trigger compact quota mode
const COMPACT_QUOTA_NAME_THRESHOLD = 22;

interface ChatAreaProps {
  teams: Team[];
  isTeamsLoading: boolean;
  selectedTeamForNewTask?: Team | null;
  showRepositorySelector?: boolean;
  taskType?: 'chat' | 'code';
  onShareButtonRender?: (button: React.ReactNode) => void;
}

export default function ChatArea({
  teams,
  isTeamsLoading,
  selectedTeamForNewTask,
  showRepositorySelector = true,
  taskType = 'chat',
  onShareButtonRender,
}: ChatAreaProps) {
  const { toast } = useToast();

  // Pre-load team preference from localStorage to use as initial value
  const initialTeamIdRef = useRef<number | null>(null);
  if (initialTeamIdRef.current === null && typeof window !== 'undefined') {
    initialTeamIdRef.current = getLastTeamId();
    console.log('[ChatArea] Pre-loaded team ID from localStorage:', initialTeamIdRef.current);
  }

  const [selectedTeam, setSelectedTeam] = useState<Team | null>(null);
  const [selectedRepo, setSelectedRepo] = useState<GitRepoInfo | null>(null);
  const [selectedBranch, setSelectedBranch] = useState<GitBranch | null>(null);
  const [selectedModel, setSelectedModel] = useState<Model | null>(null);
  const [forceOverride, setForceOverride] = useState(false);
  const [hasRestoredPreferences, setHasRestoredPreferences] = useState(false);
  const isMobile = useMediaQuery('(max-width: 640px)');

  const [taskInputMessage, setTaskInputMessage] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  // Unified error prompt using antd message.error, no local error state needed
  const [_error, setError] = useState('');

  // External API parameters state
  const [externalApiParams, setExternalApiParams] = useState<Record<string, string>>({});
  const [appMode, setAppMode] = useState<string | undefined>(undefined);

  // File attachment state
  const {
    state: attachmentState,
    handleFileSelect,
    handleRemove: handleAttachmentRemove,
    reset: resetAttachment,
    isReadyToSend: isAttachmentReadyToSend,
  } = useAttachment();

  // Memoize the params change handler to prevent infinite re-renders
  const handleExternalApiParamsChange = useCallback((params: Record<string, string>) => {
    setExternalApiParams(params);
  }, []);

  // Handle app mode change from ExternalApiParamsInput
  const handleAppModeChange = useCallback((mode: string | undefined) => {
    setAppMode(mode);
  }, []);

  const chatAreaRef = useRef<HTMLDivElement>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const isUserNearBottomRef = useRef(true);
  const floatingInputRef = useRef<HTMLDivElement>(null);
  const AUTO_SCROLL_THRESHOLD = 32;
  const router = useRouter();
  const searchParams = useSearchParams();
  const [floatingMetrics, setFloatingMetrics] = useState({ width: 0, left: 0 });
  const [inputHeight, setInputHeight] = useState(0);
  const [isDragging, setIsDragging] = useState(false);

  // New: Get selectedTask to determine if there are messages
  const { selectedTaskDetail, refreshTasks, refreshSelectedTaskDetail, setSelectedTask } =
    useTaskContext();

  // Global Chat Stream Context - streams persist across task switches
  const {
    getStreamState,
    isTaskStreaming,
    startStream: contextStartStream,
    stopStream: contextStopStream,
    resetStream: contextResetStream,
  } = useChatStreamContext();

  // Track the task ID that is currently being streamed (for new tasks before they have a real ID)
  // This is separate from selectedTaskDetail?.id to allow switching tasks while streaming continues
  const [streamingTaskId, setStreamingTaskId] = useState<number | null>(null);

  // Determine which task ID to use for stream state display
  // Priority:
  // 1. If viewing a task that has an active stream, show that stream
  // 2. If we started a new stream (streamingTaskId is set) and haven't switched away, show that
  const currentDisplayTaskId = selectedTaskDetail?.id;

  // Get stream state for the currently displayed task
  const currentStreamState = useMemo(() => {
    if (!currentDisplayTaskId) {
      // No task selected - check if we have an active new stream
      if (streamingTaskId) {
        return getStreamState(streamingTaskId);
      }
      return undefined;
    }
    return getStreamState(currentDisplayTaskId);
  }, [currentDisplayTaskId, streamingTaskId, getStreamState]);

  // Check if the currently displayed task is streaming
  const isCurrentTaskStreaming = currentStreamState?.isStreaming || false;

  // Check if there's any active stream (for the streaming task we started)
  const isStreamingTaskActive = streamingTaskId ? isTaskStreaming(streamingTaskId) : false;

  // Extract stream state values for the current display
  const isStreaming = isCurrentTaskStreaming;
  const isStopping = currentStreamState?.isStopping || false;
  const streamingContent = currentStreamState?.streamingContent || '';
  const pendingUserMessage = currentStreamState?.pendingUserMessage || null;
  const pendingAttachment = currentStreamState?.pendingAttachment as Attachment | null;
  const streamingSubtaskId = currentStreamState?.subtaskId || null;

  // Wrapper for stopStream that uses the current display task ID
  const stopStream = useCallback(async () => {
    const taskIdToStop = currentDisplayTaskId || streamingTaskId;
    if (taskIdToStop) {
      await contextStopStream(taskIdToStop);
    }
  }, [currentDisplayTaskId, streamingTaskId, contextStopStream]);

  // Wrapper for resetStream that uses the current display task ID
  // Note: This function is kept for potential future use but currently
  // the stream is reset via contextResetStream in onComplete callback
  const _resetStream = useCallback(() => {
    const taskIdToReset = currentDisplayTaskId || streamingTaskId;
    if (taskIdToReset) {
      contextResetStream(taskIdToReset);
    }
    setStreamingTaskId(null);
  }, [currentDisplayTaskId, streamingTaskId, contextResetStream]);

  // Clear streamingTaskId when the streaming task completes or when we switch to a different task
  useEffect(() => {
    if (streamingTaskId && selectedTaskDetail?.id && selectedTaskDetail.id !== streamingTaskId) {
      // User switched to a different task, clear the streaming task ID
      // The stream will continue in the background
      setStreamingTaskId(null);
    }
  }, [selectedTaskDetail?.id, streamingTaskId]);

  // Clear streamingTaskId when the stream completes
  useEffect(() => {
    if (streamingTaskId && !isStreamingTaskActive) {
      setStreamingTaskId(null);
    }
  }, [streamingTaskId, isStreamingTaskActive]);

  const subtaskList = selectedTaskDetail?.subtasks ?? [];
  const lastSubtask = subtaskList.length ? subtaskList[subtaskList.length - 1] : null;
  const lastSubtaskId = lastSubtask?.id;
  const lastSubtaskUpdatedAt = lastSubtask?.updated_at || lastSubtask?.completed_at;

  // Determine if there are messages to display
  // We consider it has messages if:
  // 1. There is a selected task with ID (existing chat)
  // 2. There is a pending user message for the current task (optimistic UI for new chat)
  // 3. The current task is streaming
  // 4. We're creating a new task (no selected task) and have an active stream
  const hasMessages = React.useMemo(() => {
    const hasSelectedTask = selectedTaskDetail && selectedTaskDetail.id;
    const hasNewTaskStream = !selectedTaskDetail?.id && streamingTaskId && isStreamingTaskActive;
    return Boolean(hasSelectedTask || pendingUserMessage || isStreaming || hasNewTaskStream);
  }, [selectedTaskDetail, pendingUserMessage, isStreaming, streamingTaskId, isStreamingTaskActive]);

  // Determine if chat input should be hidden (workflow mode always hides chat input)
  const shouldHideChatInput = React.useMemo(() => {
    return appMode === 'workflow';
  }, [appMode]);

  // Generate messages for PDF export from task detail subtasks
  const exportableMessages = useMemo<SelectableMessage[]>(() => {
    if (!selectedTaskDetail?.subtasks) return [];

    return selectedTaskDetail.subtasks
      .map((sub: TaskDetailSubtask) => {
        const isUser = sub.role === 'USER';
        let content = sub.prompt || '';

        // For AI messages, extract the result value
        if (!isUser && sub.result) {
          if (typeof sub.result === 'object' && 'value' in sub.result) {
            const value = sub.result.value;
            if (typeof value === 'string') {
              content = value;
            } else if (value !== null && value !== undefined) {
              content = JSON.stringify(value);
            }
          } else if (typeof sub.result === 'string') {
            content = sub.result;
          }
        }

        // Extract attachments for user messages
        const attachments = sub.attachments?.map(att => ({
          id: att.id,
          filename: att.filename,
          file_size: att.file_size,
          file_extension: att.file_extension,
        }));

        return {
          id: sub.id,
          type: isUser ? ('user' as const) : ('ai' as const),
          content,
          timestamp: new Date(sub.updated_at).getTime(),
          botName: sub.bots?.[0]?.name || 'Bot',
          userName: selectedTaskDetail?.user?.user_name,
          teamName: selectedTaskDetail?.team?.name,
          attachments,
        };
      })
      .filter(msg => msg.content.trim() !== '');
  }, [
    selectedTaskDetail?.subtasks,
    selectedTaskDetail?.team?.name,
    selectedTaskDetail?.user?.user_name,
  ]);

  // Restore user preferences from localStorage when teams load
  // Only runs for new tasks (no messages), not when switching to existing tasks
  useEffect(() => {
    // Skip if already restored, no teams, or viewing existing task (has messages)
    if (hasRestoredPreferences || !teams.length || hasMessages) return;

    const lastTeamId = initialTeamIdRef.current;
    console.log('[ChatArea] Trying to restore team with ID:', lastTeamId);

    if (lastTeamId) {
      const lastTeam = teams.find(team => team.id === lastTeamId);
      if (lastTeam) {
        console.log('[ChatArea] âœ… Restoring team from localStorage:', lastTeam.name, lastTeam.id);
        setSelectedTeam(lastTeam);
        setHasRestoredPreferences(true);
        return;
      } else {
        console.log(
          '[ChatArea] â�Œ Team from localStorage not found in teams list, ID:',
          lastTeamId
        );
      }
    }

    // No valid preference, use first team as default
    if (teams.length > 0) {
      console.log(
        '[ChatArea] No valid preference, using first team as default:',
        teams[0].name,
        teams[0].id
      );
      setSelectedTeam(teams[0]);
    }
    setHasRestoredPreferences(true);
  }, [teams, hasRestoredPreferences, hasMessages]);

  // Handle external team selection for new tasks (from team sharing)
  useEffect(() => {
    if (selectedTeamForNewTask && !hasMessages) {
      setSelectedTeam(selectedTeamForNewTask);
    }
  }, [selectedTeamForNewTask, hasMessages]);

  // Set model from task detail when viewing existing task
  useEffect(() => {
    // Only apply when viewing an existing task (has messages) and task has a model_id
    if (hasMessages && selectedTaskDetail?.model_id && selectedTaskDetail?.id) {
      const taskModelId = selectedTaskDetail.model_id;

      // If current model already matches, skip
      if (selectedModel?.name === taskModelId) {
        return;
      }

      // Check if it's the default model
      if (taskModelId === DEFAULT_MODEL_NAME) {
        setSelectedModel({ name: DEFAULT_MODEL_NAME, provider: '', modelId: '' });
      } else {
        // For non-default models, create a minimal model object
        // The type field is intentionally undefined so ModelSelector won't try to validate it
        setSelectedModel({
          name: taskModelId,
          provider: '',
          modelId: taskModelId,
          displayName: null,
          type: undefined, // Explicitly set to undefined to skip compatibility checks
        });
      }
    }
  }, [
    hasMessages,
    selectedTaskDetail?.model_id,
    selectedTaskDetail?.id,
    selectedModel?.name,
    setSelectedModel,
  ]);

  const shouldHideQuotaUsage = React.useMemo(() => {
    if (!isMobile || !selectedTeam?.name) return false;

    if (selectedTeam.share_status === 2 && selectedTeam.user?.user_name) {
      return selectedTeam.name.trim().length > 12;
    }

    return selectedTeam.name.trim().length > SHOULD_HIDE_QUOTA_NAME_LIMIT;
  }, [selectedTeam, isMobile]);

  // Determine if compact quota mode should be used (icon only)
  // On mobile, when combined team + model name exceeds threshold, use compact mode
  const shouldUseCompactQuota = React.useMemo(() => {
    if (!isMobile) return false;
    const teamNameLength = selectedTeam?.name?.trim().length || 0;
    const modelNameLength = selectedModel?.name?.trim().length || 0;
    return teamNameLength + modelNameLength > COMPACT_QUOTA_NAME_THRESHOLD;
  }, [isMobile, selectedTeam?.name, selectedModel?.name]);

  // Check if model selection is required but not fulfilled
  // For legacy teams without predefined models, user MUST select a model before sending
  const isModelSelectionRequired = React.useMemo(() => {
    // Skip check if team is not selected, or if team type is 'dify' (external API)
    if (!selectedTeam || selectedTeam.agent_type === 'dify') return false;
    // If team's bots have predefined models, "Default" option is available, no need to force selection
    const hasDefaultOption = allBotsHavePredefinedModel(selectedTeam);
    if (hasDefaultOption) return false;
    // Model selection is required when no model is selected
    return !selectedModel;
  }, [selectedTeam, selectedModel]);

  const handleTeamChange = (team: Team | null) => {
    console.log('[ChatArea] handleTeamChange called:', team?.name || 'null', team?.id || 'null');
    setSelectedTeam(team);

    // Reset external API params when team changes
    setExternalApiParams({});
    setAppMode(undefined);

    // Save team preference to localStorage
    if (team && team.id) {
      console.log('[ChatArea] Saving team to localStorage:', team.id);
      saveLastTeam(team.id);
    }
  };

  // Save repository preference when it changes
  useEffect(() => {
    if (selectedRepo) {
      saveLastRepo(selectedRepo.git_repo_id, selectedRepo.git_repo);
    }
  }, [selectedRepo]);

  // Load prompt from sessionStorage (from FinalPromptMessage)
  useEffect(() => {
    if (hasMessages) return; // Only load for new tasks

    const pendingPromptData = sessionStorage.getItem('pendingTaskPrompt');
    if (pendingPromptData) {
      try {
        const data = JSON.parse(pendingPromptData);

        // Check if data is recent (within 5 minutes)
        const isRecent = Date.now() - data.timestamp < 5 * 60 * 1000;

        if (isRecent && data.prompt) {
          // Set the prompt in the input
          setTaskInputMessage(data.prompt);

          // Clear the sessionStorage after loading
          sessionStorage.removeItem('pendingTaskPrompt');
        }
      } catch (error) {
        console.error('Failed to parse pending prompt data:', error);
        sessionStorage.removeItem('pendingTaskPrompt');
      }
    }
  }, [hasMessages]);

  // Drag and drop handlers
  const handleDragEnter = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      e.stopPropagation();

      // Only allow if Chat Shell
      if (!selectedTeam || !isChatShell(selectedTeam)) return;

      if (isLoading || isStreaming || attachmentState.attachment) return;
      setIsDragging(true);
    },
    [isLoading, isStreaming, attachmentState.attachment, selectedTeam]
  );

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    // Check if we're actually leaving the container (and not just entering a child)
    if (e.currentTarget.contains(e.relatedTarget as Node)) return;
    setIsDragging(false);
  }, []);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
  }, []);

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      setIsDragging(false);

      // Only allow if Chat Shell
      if (!selectedTeam || !isChatShell(selectedTeam)) return;

      if (isLoading || isStreaming || attachmentState.attachment) return;

      const file = e.dataTransfer.files?.[0];
      if (file) {
        handleFileSelect(file);
      }
    },
    [isLoading, isStreaming, attachmentState.attachment, handleFileSelect, selectedTeam]
  );

  const handleSendMessage = async () => {
    const message = taskInputMessage.trim();
    if (!message && !shouldHideChatInput) return;

    // Check if attachment is ready
    if (!isAttachmentReadyToSend) {
      toast({
        variant: 'destructive',
        title: '请等待文件上传完成',
      });
      return;
    }

    setIsLoading(true);
    setError('');

    // Check if this is a Chat Shell - use streaming mode
    console.log('[ChatArea] handleSendMessage - checking isChatShell:', {
      selectedTeam: selectedTeam?.name,
      selectedTeamId: selectedTeam?.id,
      agentType: selectedTeam?.agent_type,
      isChatShellResult: isChatShell(selectedTeam),
      attachmentId: attachmentState.attachment?.id,
    });

    if (isChatShell(selectedTeam)) {
      console.log('[ChatArea] Using Chat Shell streaming mode');
      setTaskInputMessage('');
      // Reset attachment immediately after sending (clear from input area)
      resetAttachment();

      // When default model is selected, don't pass model_id (use bot's predefined model)
      const modelId = selectedModel?.name === DEFAULT_MODEL_NAME ? undefined : selectedModel?.name;

      try {
        // Use the global context to start stream with callbacks
        const tempTaskId = await contextStartStream(
          {
            message,
            team_id: selectedTeam?.id ?? 0,
            task_id: selectedTaskDetail?.id,
            model_id: modelId,
            force_override_bot_model: forceOverride,
            attachment_id: attachmentState.attachment?.id,
          },
          {
            pendingUserMessage: message,
            pendingAttachment: attachmentState.attachment,
            onTaskIdResolved: realTaskId => {
              // Update streaming task ID when real task ID is resolved
              setStreamingTaskId(realTaskId);

              // Refresh task list immediately when task ID is resolved
              // This ensures the new task appears in the sidebar while streaming
              refreshTasks();

              // Note: We don't update URL here to avoid triggering TaskParamSync
              // which would call setSelectedTask and trigger refreshSelectedTaskDetail.
              // URL will be updated when stream completes.
            },
            onComplete: async (completedTaskId, _subtaskId) => {
              // Refresh task list after stream ends
              refreshTasks();

              // If this was a new task (first message), update URL
              if (completedTaskId && !selectedTaskDetail?.id) {
                const params = new URLSearchParams(Array.from(searchParams.entries()));
                params.set('taskId', String(completedTaskId));
                router.push(`?${params.toString()}`);

                // For new tasks, we immediately clear stream as navigation happens
                contextResetStream(completedTaskId);
                setStreamingTaskId(null);
              } else if (selectedTaskDetail?.id) {
                // If this was a follow-up message (second+ message), refresh task detail
                // to show the new subtasks (user message + AI response)
                // Wait for the refresh to complete BEFORE clearing the stream to prevent flashing
                try {
                  await refreshSelectedTaskDetail(false);
                } catch (error) {
                  console.error('Failed to refresh task detail after stream:', error);
                } finally {
                  // Only clear stream content after data is refreshed (or failed)
                  contextResetStream(completedTaskId);
                  setStreamingTaskId(null);
                }
              }
            },
            onError: error => {
              toast({
                variant: 'destructive',
                title: error.message,
              });
            },
          }
        );

        // Track the streaming task ID (may be temporary ID for new tasks)
        setStreamingTaskId(tempTaskId);

        // Note: For new tasks, the selected task is now set in onTaskIdResolved callback
        // when the real task ID is received from the backend

        // Manually trigger scroll to bottom after sending message
        setTimeout(() => scrollToBottom(true), 0);
      } catch (err) {
        toast({
          variant: 'destructive',
          title: (err as Error)?.message || 'Failed to start chat stream',
        });
      }

      setIsLoading(false);
      return;
    }

    // Non-Chat Shell: use existing task creation flow
    // Prepare message with embedded external API parameters if applicable
    let finalMessage = message;
    if (Object.keys(externalApiParams).length > 0) {
      // Embed parameters using special marker format
      // Backend will extract these parameters for external API calls
      const paramsJson = JSON.stringify(externalApiParams);
      finalMessage = `[EXTERNAL_API_PARAMS]${paramsJson}[/EXTERNAL_API_PARAMS]\n${message}`;
    }

    // When default model is selected, don't pass model_id (use bot's predefined model)
    const modelId = selectedModel?.name === DEFAULT_MODEL_NAME ? undefined : selectedModel?.name;
    const { error, newTask } = await sendMessage({
      message: finalMessage,
      team: selectedTeam,
      repo: showRepositorySelector ? selectedRepo : null,
      branch: showRepositorySelector ? selectedBranch : null,
      task_id: selectedTaskDetail?.id,
      taskType: taskType,
      model_id: modelId,
      force_override_bot_model: forceOverride,
    });
    if (error) {
      toast({
        variant: 'destructive',
        title: error,
      });
    } else {
      setTaskInputMessage('');
      // Reset attachment after successful send
      resetAttachment();
      // Redirect to task URL after successfully creating a task
      if (newTask && newTask.task_id) {
        const params = new URLSearchParams(Array.from(searchParams.entries()));
        params.set('taskId', String(newTask.task_id));
        router.push(`?${params.toString()}`);
        // Actively refresh task list and task details
        refreshTasks();
        // Create a minimal Task object with required fields
        setSelectedTask({
          id: newTask.task_id,
          title: message.substring(0, 100),
          team_id: selectedTeam?.id || 0,
          git_url: selectedRepo?.git_url || '',
          git_repo: selectedRepo?.git_repo || '',
          git_repo_id: selectedRepo?.git_repo_id || 0,
          git_domain: selectedRepo?.git_domain || '',
          branch_name: selectedBranch?.name || '',
          prompt: message,
          status: 'PENDING',
          task_type: taskType,
          progress: 0,
          batch: 1,
          result: {} as Record<string, unknown>,
          error_message: '',
          user_id: 0,
          user_name: '',
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
          completed_at: '',
        });
      } else if (selectedTaskDetail?.id) {
        // If appending message to existing task, also refresh task details
        refreshTasks();
        // Actively refresh task details to ensure latest status and messages
        refreshSelectedTaskDetail(false); // false means not auto-refresh, allow fetching completed task details
      }
      // Manually trigger scroll to bottom after sending message
      setTimeout(() => scrollToBottom(true), 0);
    }
    setIsLoading(false);
  };

  const [isCancelling, setIsCancelling] = useState(false);

  const handleCancelTask = async () => {
    if (!selectedTaskDetail?.id || isCancelling) return;

    setIsCancelling(true);

    try {
      // Create a 60-second timeout promise
      const timeoutPromise = new Promise((_, reject) => {
        setTimeout(() => reject(new Error('Cancel operation timed out')), 60000);
      });

      // Race between cancel API call and timeout
      await Promise.race([taskApis.cancelTask(selectedTaskDetail.id), timeoutPromise]);

      toast({
        title: 'Task cancelled successfully',
        description: 'The task has been cancelled.',
      });

      // Refresh to update status
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

      // Still refresh status even on timeout
      if (err instanceof Error && err.message === 'Cancel operation timed out') {
        refreshTasks();
        refreshSelectedTaskDetail(false);
      }
    } finally {
      setIsCancelling(false);
    }
  };
  const scrollToBottom = useCallback((force = false) => {
    const container = scrollContainerRef.current;
    if (!container) return;

    if (force || isUserNearBottomRef.current) {
      // Use requestAnimationFrame to ensure DOM is fully rendered before scrolling
      requestAnimationFrame(() => {
        if (container) {
          container.scrollTop = container.scrollHeight;
          // Force means user initiated action, treat as pinned to bottom
          if (force) {
            isUserNearBottomRef.current = true;
          }
        }
      });
    }
  }, []);

  // Callback for MessagesArea to notify content changes (for auto-scroll during streaming)
  const handleMessagesContentChange = useCallback(() => {
    // During streaming or when user is near bottom, auto-scroll to bottom
    if (isStreaming || isUserNearBottomRef.current) {
      scrollToBottom();
    }
  }, [isStreaming, scrollToBottom]);

  useEffect(() => {
    const container = scrollContainerRef.current;
    if (!container) return;

    const handleScroll = () => {
      const distanceFromBottom =
        container.scrollHeight - container.scrollTop - container.clientHeight;
      isUserNearBottomRef.current = distanceFromBottom <= AUTO_SCROLL_THRESHOLD;
    };

    container.addEventListener('scroll', handleScroll);
    // Initialize state based on current position
    handleScroll();

    return () => {
      container.removeEventListener('scroll', handleScroll);
    };
  }, [hasMessages]);

  useEffect(() => {
    if (hasMessages) {
      // Use timeout to ensure DOM is updated before scrolling
      // Force scroll to bottom when opening a historical task
      setTimeout(() => scrollToBottom(true), 100);
    }
  }, [selectedTaskDetail?.id, hasMessages, scrollToBottom]);

  useEffect(() => {
    if (!hasMessages || !lastSubtaskId) return;

    const timer = setTimeout(() => {
      // Auto scroll when new subtasks/messages are appended
      scrollToBottom();
    }, 60);

    return () => clearTimeout(timer);
  }, [hasMessages, lastSubtaskId, lastSubtaskUpdatedAt, scrollToBottom]);

  // Keep floating input aligned with the chat area width to avoid overflow
  useEffect(() => {
    if (!hasMessages) {
      setFloatingMetrics({ width: 0, left: 0 });
      return;
    }

    const updateFloatingMetrics = () => {
      if (!chatAreaRef.current) return;
      const rect = chatAreaRef.current.getBoundingClientRect();
      setFloatingMetrics({
        width: rect.width,
        left: rect.left,
      });
    };

    updateFloatingMetrics();
    window.addEventListener('resize', updateFloatingMetrics);

    let observer: ResizeObserver | null = null;
    if (chatAreaRef.current && typeof ResizeObserver !== 'undefined') {
      observer = new ResizeObserver(updateFloatingMetrics);
      observer.observe(chatAreaRef.current);
    }

    return () => {
      window.removeEventListener('resize', updateFloatingMetrics);
      observer?.disconnect();
    };
  }, [hasMessages]);

  // Measure floating input height to pad the scroll area so content is not hidden under it
  useEffect(() => {
    if (!hasMessages || !floatingInputRef.current) {
      setInputHeight(0);
      return;
    }

    const element = floatingInputRef.current;
    const updateHeight = () => setInputHeight(element.offsetHeight);

    updateHeight();

    if (typeof ResizeObserver !== 'undefined') {
      const resizeObserver = new ResizeObserver(updateHeight);
      resizeObserver.observe(element);
      return () => resizeObserver.disconnect();
    }

    window.addEventListener('resize', updateHeight);
    return () => window.removeEventListener('resize', updateHeight);
  }, [hasMessages]);

  // Style reference: TaskParamWrapper.tsx
  return (
    <div
      ref={chatAreaRef}
      className="flex-1 flex flex-col min-h-0 w-full relative"
      style={{ height: '100%', boxSizing: 'border-box' }}
    >
      {/* Messages Area: always mounted to keep scroll container stable */}
      <div
        ref={scrollContainerRef}
        className={
          (hasMessages ? 'flex-1 overflow-y-auto custom-scrollbar' : 'overflow-y-hidden') +
          ' transition-opacity duration-200 ' +
          (hasMessages ? 'opacity-100' : 'opacity-0 pointer-events-none h-0')
        }
        aria-hidden={!hasMessages}
        style={{ paddingBottom: hasMessages ? `${inputHeight + 16}px` : '0' }}
      >
        <div className="w-full max-w-5xl mx-auto px-4 sm:px-6">
          <MessagesArea
            selectedTeam={selectedTeam}
            selectedRepo={selectedRepo}
            selectedBranch={selectedBranch}
            streamingContent={streamingContent}
            isStreaming={isStreaming}
            pendingUserMessage={pendingUserMessage}
            pendingAttachment={pendingAttachment}
            onContentChange={handleMessagesContentChange}
            streamingSubtaskId={streamingSubtaskId}
            onShareButtonRender={onShareButtonRender}
          />
        </div>
      </div>

      {/* Main Content Area */}
      <div className={hasMessages ? 'w-full' : 'flex-1 flex flex-col w-full'}>
        {/* Center area for input when no messages */}
        {!hasMessages && (
          <div className="flex-1 flex items-center justify-center w-full">
            {/* Floating Input Area */}
            <div ref={floatingInputRef} className="w-full max-w-4xl mx-auto px-4 sm:px-6">
              <div className="w-full">
                {/* External API Parameters Input - only show for Dify teams */}
                {selectedTeam && selectedTeam.agent_type === 'dify' && (
                  <ExternalApiParamsInput
                    teamId={selectedTeam.id}
                    onParamsChange={handleExternalApiParamsChange}
                    onAppModeChange={handleAppModeChange}
                    initialParams={externalApiParams}
                  />
                )}

                {/* Chat Input Card */}
                <div
                  className={`relative w-full flex flex-col rounded-2xl border border-border bg-base shadow-md transition-colors ${isDragging ? 'border-primary ring-2 ring-primary/20' : ''}`}
                  onDragEnter={handleDragEnter}
                  onDragLeave={handleDragLeave}
                  onDragOver={handleDragOver}
                  onDrop={handleDrop}
                >
                  {/* Drag Overlay */}
                  {isDragging && (
                    <div className="absolute inset-0 z-50 rounded-2xl bg-base/95 backdrop-blur-sm flex flex-col items-center justify-center border-2 border-dashed border-primary transition-all animate-in fade-in duration-200">
                      <div className="p-4 rounded-full bg-primary/10 mb-4 animate-bounce">
                        <Upload className="h-8 w-8 text-primary" />
                      </div>
                      <p className="text-lg font-medium text-primary">释放以上传文件</p>
                      <p className="text-sm text-text-muted mt-1">
                        支持 PDF, Word, TXT, Markdown 等格式
                      </p>
                    </div>
                  )}

                  {/* File Upload Preview - show above input when file is selected */}
                  {(attachmentState.attachment ||
                    attachmentState.isUploading ||
                    attachmentState.error) && (
                    <div className="px-3 pt-2">
                      <FileUpload
                        attachment={attachmentState.attachment}
                        isUploading={attachmentState.isUploading}
                        uploadProgress={attachmentState.uploadProgress}
                        error={attachmentState.error}
                        disabled={hasMessages || isLoading || isStreaming}
                        onFileSelect={handleFileSelect}
                        onRemove={handleAttachmentRemove}
                      />
                    </div>
                  )}
                  {/* Chat Input - hide for workflow mode when no messages */}
                  {!shouldHideChatInput && (
                    <ChatInput
                      message={taskInputMessage}
                      setMessage={setTaskInputMessage}
                      handleSendMessage={handleSendMessage}
                      isLoading={isLoading}
                      taskType={taskType}
                    />
                  )}
                  {/* Team Selector and Send Button - always show */}
                  <div
                    className={`flex items-center justify-between px-3 gap-2 ${shouldHideChatInput ? 'py-3' : 'pb-0.5'}`}
                  >
                    <div
                      className="flex-1 min-w-0 overflow-hidden flex items-center gap-3"
                      data-tour="input-controls"
                    >
                      {/* File Upload Button - only show when no file is selected */}
                      {!attachmentState.attachment &&
                        !attachmentState.isUploading &&
                        isChatShell(selectedTeam) && (
                          <FileUpload
                            attachment={null}
                            isUploading={false}
                            uploadProgress={0}
                            error={attachmentState.error}
                            disabled={hasMessages || isLoading || isStreaming}
                            onFileSelect={handleFileSelect}
                            onRemove={handleAttachmentRemove}
                          />
                        )}
                      {teams.length > 0 && (
                        <TeamSelector
                          selectedTeam={selectedTeam}
                          setSelectedTeam={handleTeamChange}
                          teams={teams}
                          disabled={hasMessages}
                          isLoading={isTeamsLoading}
                        />
                      )}
                      {selectedTeam && (
                        <ModelSelector
                          selectedModel={selectedModel}
                          setSelectedModel={setSelectedModel}
                          forceOverride={forceOverride}
                          setForceOverride={setForceOverride}
                          selectedTeam={selectedTeam}
                          disabled={hasMessages || isLoading}
                        />
                      )}
                    </div>
                    <div className="ml-auto flex items-center gap-2 flex-shrink-0">
                      {!shouldHideQuotaUsage && (
                        <QuotaUsage className="flex-shrink-0" compact={shouldUseCompactQuota} />
                      )}
                      {isStreaming || isStopping ? (
                        isStopping ? (
                          <div className="relative h-6 w-6 flex items-center justify-center flex-shrink-0 translate-y-0.5">
                            <div className="absolute inset-0 rounded-full border-2 border-orange-200 border-t-orange-500 animate-spin" />
                            <CircleStop className="h-4 w-4 text-orange-500" />
                          </div>
                        ) : (
                          <Button
                            variant="ghost"
                            size="icon"
                            onClick={stopStream}
                            className="h-6 w-6 rounded-full hover:bg-orange-100 flex-shrink-0 translate-y-0.5"
                            title="Stop generating"
                          >
                            <CircleStop className="h-5 w-5 text-orange-500" />
                          </Button>
                        )
                      ) : selectedTaskDetail?.status === 'PENDING' ? (
                        <Button
                          variant="ghost"
                          size="icon"
                          disabled
                          className="h-6 w-6 rounded-full flex-shrink-0 translate-y-0.5"
                        >
                          <LoadingDots />
                        </Button>
                      ) : selectedTaskDetail?.status === 'RUNNING' ? (
                        isCancelling ? (
                          <div className="relative h-6 w-6 flex items-center justify-center flex-shrink-0 translate-y-0.5">
                            <div className="absolute inset-0 rounded-full border-2 border-orange-200 border-t-orange-500 animate-spin" />
                            <CircleStop className="h-5 w-5 text-orange-500" />
                          </div>
                        ) : (
                          <Button
                            variant="ghost"
                            size="icon"
                            onClick={handleCancelTask}
                            className="h-6 w-6 rounded-full hover:bg-orange-100 flex-shrink-0 translate-y-0.5"
                            title="Cancel task"
                          >
                            <CircleStop className="h-5 w-5 text-orange-500" />
                          </Button>
                        )
                      ) : selectedTaskDetail?.status === 'CANCELLING' ? (
                        <div className="relative h-6 w-6 flex items-center justify-center flex-shrink-0 translate-y-0.5">
                          <div className="absolute inset-0 rounded-full border-2 border-orange-200 border-t-orange-500 animate-spin" />
                          <CircleStop className="h-5 w-5 text-orange-500" />
                        </div>
                      ) : (
                        <Button
                          variant="ghost"
                          size="icon"
                          onClick={handleSendMessage}
                          disabled={
                            isLoading ||
                            isStreaming ||
                            isModelSelectionRequired ||
                            !isAttachmentReadyToSend ||
                            (shouldHideChatInput ? false : !taskInputMessage.trim())
                          }
                          className="h-6 w-6 rounded-full hover:bg-primary/10 flex-shrink-0 translate-y-0.5"
                          data-tour="send-button"
                        >
                          {isLoading ? (
                            <LoadingDots />
                          ) : (
                            <Send className="h-5 w-5 text-text-muted" />
                          )}
                        </Button>
                      )}
                    </div>
                  </div>
                </div>

                {/* Bottom Controls */}
                <div className="flex flex-row gap-3 mb-2 ml-3 mt-3 items-center flex-wrap">
                  {showRepositorySelector && (
                    <>
                      <RepositorySelector
                        selectedRepo={selectedRepo}
                        handleRepoChange={setSelectedRepo}
                        disabled={hasMessages}
                        selectedTaskDetail={selectedTaskDetail}
                      />

                      {selectedRepo && (
                        <BranchSelector
                          selectedRepo={selectedRepo}
                          selectedBranch={selectedBranch}
                          handleBranchChange={setSelectedBranch}
                          disabled={hasMessages}
                        />
                      )}
                    </>
                  )}
                </div>
              </div>
            </div>
          </div>
        )}

        {/* Floating Input Area for messages view */}
        {hasMessages && (
          <div
            ref={floatingInputRef}
            className="fixed bottom-0 z-50 bg-gradient-to-t from-base via-base/95 to-base/0"
            style={{
              left: floatingMetrics.width ? floatingMetrics.left : 0,
              width: floatingMetrics.width || '100%',
              right: floatingMetrics.width ? undefined : 0,
            }}
          >
            <div className="w-full max-w-4xl mx-auto px-4 sm:px-6 py-4">
              {/* External API Parameters Input - only show for Dify teams */}
              {selectedTeam && selectedTeam.agent_type === 'dify' && (
                <ExternalApiParamsInput
                  teamId={selectedTeam.id}
                  onParamsChange={handleExternalApiParamsChange}
                  onAppModeChange={handleAppModeChange}
                  initialParams={externalApiParams}
                />
              )}

              {/* Chat Input Card */}
              <div
                className={`relative w-full flex flex-col rounded-2xl border border-border bg-base shadow-md transition-colors ${isDragging ? 'border-primary ring-2 ring-primary/20' : ''}`}
                onDragEnter={handleDragEnter}
                onDragLeave={handleDragLeave}
                onDragOver={handleDragOver}
                onDrop={handleDrop}
              >
                {/* Drag Overlay */}
                {isDragging && (
                  <div className="absolute inset-0 z-50 rounded-2xl bg-base/95 backdrop-blur-sm flex flex-col items-center justify-center border-2 border-dashed border-primary transition-all animate-in fade-in duration-200">
                    <div className="p-4 rounded-full bg-primary/10 mb-4 animate-bounce">
                      <Upload className="h-8 w-8 text-primary" />
                    </div>
                    <p className="text-lg font-medium text-primary">释放以上传文件</p>
                    <p className="text-sm text-text-muted mt-1">
                      支持 PDF, Word, TXT, Markdown 等格式
                    </p>
                  </div>
                )}

                {/* File Upload Preview - show above input when file is selected */}
                {(attachmentState.attachment ||
                  attachmentState.isUploading ||
                  attachmentState.error) && (
                  <div className="px-3 pt-2">
                    <FileUpload
                      attachment={attachmentState.attachment}
                      isUploading={attachmentState.isUploading}
                      uploadProgress={attachmentState.uploadProgress}
                      error={attachmentState.error}
                      disabled={isLoading || isStreaming}
                      onFileSelect={handleFileSelect}
                      onRemove={handleAttachmentRemove}
                    />
                  </div>
                )}
                {/* Chat Input - hide for workflow mode */}
                {!shouldHideChatInput && (
                  <ChatInput
                    message={taskInputMessage}
                    setMessage={setTaskInputMessage}
                    handleSendMessage={handleSendMessage}
                    isLoading={isLoading}
                    taskType={taskType}
                  />
                )}
                {/* Team Selector and Send Button - always show */}
                <div
                  className={`flex items-center justify-between px-3 gap-2 ${shouldHideChatInput ? 'py-3' : 'pb-0.5'}`}
                >
                  <div className="flex-1 min-w-0 overflow-hidden flex items-center gap-3">
                    {/* File Upload Button - only show when no file is selected */}
                    {!attachmentState.attachment &&
                      !attachmentState.isUploading &&
                      isChatShell(selectedTeam) && (
                        <FileUpload
                          attachment={null}
                          isUploading={false}
                          uploadProgress={0}
                          error={attachmentState.error}
                          disabled={isLoading || isStreaming}
                          onFileSelect={handleFileSelect}
                          onRemove={handleAttachmentRemove}
                        />
                      )}
                    {teams.length > 0 && (
                      <TeamSelector
                        selectedTeam={selectedTeam}
                        setSelectedTeam={handleTeamChange}
                        teams={teams}
                        disabled={hasMessages}
                        isLoading={isTeamsLoading}
                      />
                    )}
                    {selectedTeam && (
                      <ModelSelector
                        selectedModel={selectedModel}
                        setSelectedModel={setSelectedModel}
                        forceOverride={forceOverride}
                        setForceOverride={setForceOverride}
                        selectedTeam={selectedTeam}
                        disabled={hasMessages || isLoading}
                      />
                    )}
                  </div>
                  <div className="ml-auto flex items-center gap-2 flex-shrink-0">
                    {!shouldHideQuotaUsage && (
                      <QuotaUsage className="flex-shrink-0" compact={shouldUseCompactQuota} />
                    )}
                    {isStreaming || isStopping ? (
                      isStopping ? (
                        <div className="relative h-6 w-6 flex items-center justify-center flex-shrink-0 translate-y-0.5">
                          <div className="absolute inset-0 rounded-full border-2 border-orange-200 border-t-orange-500 animate-spin" />
                          <CircleStop className="h-4 w-4 text-orange-500" />
                        </div>
                      ) : (
                        <Button
                          variant="ghost"
                          size="icon"
                          onClick={stopStream}
                          className="h-6 w-6 rounded-full hover:bg-orange-100 flex-shrink-0 translate-y-0.5"
                          title="Stop generating"
                        >
                          <CircleStop className="h-5 w-5 text-orange-500" />
                        </Button>
                      )
                    ) : selectedTaskDetail?.status === 'PENDING' ? (
                      <Button
                        variant="ghost"
                        size="icon"
                        disabled
                        className="h-6 w-6 rounded-full flex-shrink-0 translate-y-0.5"
                      >
                        <LoadingDots />
                      </Button>
                    ) : selectedTaskDetail?.status === 'RUNNING' ? (
                      isCancelling ? (
                        <div className="relative h-6 w-6 flex items-center justify-center flex-shrink-0 translate-y-0.5">
                          <div className="absolute inset-0 rounded-full border-2 border-orange-200 border-t-orange-500 animate-spin" />
                          <CircleStop className="h-5 w-5 text-orange-500" />
                        </div>
                      ) : (
                        <Button
                          variant="ghost"
                          size="icon"
                          onClick={handleCancelTask}
                          className="h-6 w-6 rounded-full hover:bg-orange-100 flex-shrink-0 translate-y-0.5"
                          title="Cancel task"
                        >
                          <CircleStop className="h-5 w-5 text-orange-500" />
                        </Button>
                      )
                    ) : selectedTaskDetail?.status === 'CANCELLING' ? (
                      <div className="relative h-6 w-6 flex items-center justify-center flex-shrink-0 translate-y-0.5">
                        <div className="absolute inset-0 rounded-full border-2 border-orange-200 border-t-orange-500 animate-spin" />
                        <CircleStop className="h-5 w-5 text-orange-500" />
                      </div>
                    ) : (
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={handleSendMessage}
                        disabled={
                          isLoading ||
                          isStreaming ||
                          isModelSelectionRequired ||
                          !isAttachmentReadyToSend ||
                          (shouldHideChatInput ? false : !taskInputMessage.trim())
                        }
                        className="h-6 w-6 rounded-full hover:bg-primary/10 flex-shrink-0 translate-y-0.5"
                      >
                        {isLoading ? <LoadingDots /> : <Send className="h-5 w-5 text-text-muted" />}
                      </Button>
                    )}
                  </div>
                </div>
              </div>

              {/* Bottom Controls */}
              <div className="flex flex-row gap-3 ml-3 mt-3 items-center flex-wrap justify-between">
                <div className="flex flex-row gap-3 items-center flex-wrap">
                  {showRepositorySelector && (
                    <>
                      <RepositorySelector
                        selectedRepo={selectedRepo}
                        handleRepoChange={setSelectedRepo}
                        disabled={hasMessages}
                        selectedTaskDetail={selectedTaskDetail}
                      />

                      {selectedRepo && (
                        <BranchSelector
                          selectedRepo={selectedRepo}
                          selectedBranch={selectedBranch}
                          handleBranchChange={setSelectedBranch}
                          disabled={hasMessages}
                        />
                      )}
                    </>
                  )}
                </div>
                {/* Export PDF Button - only show when has messages and not streaming */}
                {exportableMessages.length > 0 && !isStreaming && (
                  <ExportPdfButton
                    messages={exportableMessages}
                    taskName={
                      selectedTaskDetail?.title ||
                      selectedTaskDetail?.prompt?.slice(0, 50) ||
                      'Chat'
                    }
                  />
                )}
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
