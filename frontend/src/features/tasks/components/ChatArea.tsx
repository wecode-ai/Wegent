// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client';

import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { CircleStop, Upload, ShieldX } from 'lucide-react';
import MessagesArea from './MessagesArea';
import ChatInput from './ChatInput';
import SendButton from './SendButton';
import DeepThinkingToggle from './DeepThinkingToggle';
import ClarificationToggle from './ClarificationToggle';
import ChatContextInput from './chat/ChatContextInput';
import ModelSelector, {
  Model,
  DEFAULT_MODEL_NAME,
  allBotsHavePredefinedModel,
} from './ModelSelector';
import RepositorySelector from './RepositorySelector';
import BranchSelector from './BranchSelector';
import LoadingDots from './LoadingDots';
import ExternalApiParamsInput from './ExternalApiParamsInput';
import AttachmentButton from './AttachmentButton';
import AttachmentUploadPreview from './AttachmentUploadPreview';
import { QuickAccessCards } from './QuickAccessCards';
import { SelectedTeamBadge } from './SelectedTeamBadge';
import type { Team, GitRepoInfo, GitBranch, ChatTipItem, ChatSloganItem } from '@/types/api';
import type { ContextItem } from '@/types/context';
import type { WelcomeConfigResponse } from '@/types/api';
import { userApis } from '@/apis/user';
import { useTranslation } from '@/hooks/useTranslation';
import { parseError } from '@/utils/errorParser';
import { isChatShell } from '../service/messageService';
import { useUser } from '@/features/common/UserContext';
import { useRouter, useSearchParams } from 'next/navigation';
import { useTaskContext } from '../contexts/taskContext';
import { useChatStreamContext, computeIsStreaming } from '../contexts/chatStreamContext';
import { useSocket } from '@/contexts/SocketContext';
import { Button } from '@/components/ui/button';
import QuotaUsage from './QuotaUsage';
import { useMediaQuery } from '@/hooks/useMediaQuery';
import { saveLastTeamByMode, getLastTeamIdByMode, saveLastRepo } from '@/utils/userPreferences';
import { useToast } from '@/hooks/use-toast';
import { taskApis } from '@/apis/tasks';
import { useMultiAttachment } from '@/hooks/useMultiAttachment';
import { GroupChatSyncManager } from './group-chat';
import type { SubtaskWithSender } from '@/apis/group-chat';
import { useTraceAction } from '@/hooks/useTraceAction';

const SHOULD_HIDE_QUOTA_NAME_LIMIT = 18;

// Responsive collapse thresholds based on container width
// Collapse selectors with text to icon-only mode
const COLLAPSE_SELECTORS_THRESHOLD = 420;

// Slogan Display Component - shows above input when no messages
// Always renders a container with fixed height to prevent layout shift when switching tabs
function SloganDisplay({ slogan }: { slogan: ChatSloganItem | null }) {
  const { i18n } = useTranslation();
  const currentLang = i18n.language?.startsWith('zh') ? 'zh' : 'en';
  const sloganText = slogan ? (currentLang === 'zh' ? slogan.zh : slogan.en) : '';

  // Always render the container to maintain consistent layout height
  // This prevents the chat input from "jumping" when switching between /chat and /code tabs
  return (
    <div className="text-center mb-8 min-h-[2.5rem] sm:min-h-[3rem]">
      {sloganText && (
        <h1 className="text-2xl sm:text-3xl md:text-4xl font-bold text-text-primary tracking-tight">
          {sloganText}
        </h1>
      )}
    </div>
  );
}

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
  const { toast } = useToast();
  const { user } = useUser();
  const { t } = useTranslation('chat');
  const { traceAction } = useTraceAction();

  // Pre-load team preference from localStorage to use as initial value
  const initialTeamIdRef = useRef<number | null>(null);
  if (initialTeamIdRef.current === null && typeof window !== 'undefined') {
    // Use mode-specific preference, with fallback to generic preference
    initialTeamIdRef.current = getLastTeamIdByMode(taskType);
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

  // Store last failed message for retry
  const lastFailedMessageRef = useRef<string | null>(null);

  // Store handleSendMessage reference to avoid circular dependency in handleSendError
  const handleSendMessageRef = useRef<((message?: string) => Promise<void>) | null>(null);

  // Local pending state for immediate UI feedback (before context state is updated)
  const [localPendingMessage, setLocalPendingMessage] = useState<string | null>(null);

  // Unified function to reset streaming-related state
  // This is called in multiple scenarios: task switch, stream complete, stream error, etc.
  const resetStreamingState = useCallback(() => {
    setLocalPendingMessage(null);
    setStreamingTaskId(null);
  }, []);

  // Deep thinking toggle state (session-level, not persisted)
  const [enableDeepThinking, setEnableDeepThinking] = useState(true);

  // Clarification toggle state (session-level, not persisted)
  const [enableClarification, setEnableClarification] = useState(false);

  // Context selection state (currently only knowledge bases)
  const [selectedContexts, setSelectedContexts] = useState<ContextItem[]>([]);

  // Welcome config state for dynamic placeholder
  const [welcomeConfig, setWelcomeConfig] = useState<WelcomeConfigResponse | null>(null);

  // Fetch welcome config for dynamic placeholder
  useEffect(() => {
    const fetchWelcomeConfig = async () => {
      try {
        const response = await userApis.getWelcomeConfig();
        setWelcomeConfig(response);
      } catch (error) {
        console.error('Failed to fetch welcome config:', error);
      }
    };

    fetchWelcomeConfig();
  }, []);

  // Use refs to store the random indices, ensuring they stay stable across taskType changes
  // This prevents the "jitter" effect when switching between /chat and /code tabs
  const sloganRandomIndexRef = useRef<number | null>(null);
  const tipRandomIndexRef = useRef<number | null>(null);

  // Get random slogan for display - memoized to prevent re-randomization on re-renders
  // Filter slogans by taskType: show slogans that match the current mode or are for 'both' modes
  const randomSlogan = useMemo<ChatSloganItem | null>(() => {
    if (!welcomeConfig?.slogans || welcomeConfig.slogans.length === 0) {
      return null;
    }
    // Filter slogans by mode: include slogans that match current taskType or are for 'both'
    const filteredSlogans = welcomeConfig.slogans.filter(slogan => {
      const sloganMode = slogan.mode || 'both'; // Default to 'both' if mode is not specified
      return sloganMode === taskType || sloganMode === 'both';
    });

    if (filteredSlogans.length === 0) {
      return null;
    }

    // Use stable random index: only generate once per session
    if (sloganRandomIndexRef.current === null) {
      sloganRandomIndexRef.current = Math.floor(Math.random() * filteredSlogans.length);
    }
    // Ensure index is within bounds (in case filtered list changed)
    const index = sloganRandomIndexRef.current % filteredSlogans.length;
    return filteredSlogans[index];
  }, [welcomeConfig?.slogans, taskType]);

  // Get random tip for placeholder - memoized to prevent re-randomization on re-renders
  // Filter tips by taskType: show tips that match the current mode or are for 'both' modes
  const randomTip = useMemo<ChatTipItem | null>(() => {
    if (!welcomeConfig?.tips || welcomeConfig.tips.length === 0) {
      return null;
    }
    // Filter tips by mode: include tips that match current taskType or are for 'both'
    const filteredTips = welcomeConfig.tips.filter(tip => {
      const tipMode = tip.mode || 'both'; // Default to 'both' if mode is not specified
      return tipMode === taskType || tipMode === 'both';
    });

    if (filteredTips.length === 0) {
      return null;
    }

    // Use stable random index: only generate once per session
    if (tipRandomIndexRef.current === null) {
      tipRandomIndexRef.current = Math.floor(Math.random() * filteredTips.length);
    }
    // Ensure index is within bounds (in case filtered list changed)
    const index = tipRandomIndexRef.current % filteredTips.length;
    return filteredTips[index];
  }, [welcomeConfig?.tips, taskType]);

  // External API parameters state
  const [externalApiParams, setExternalApiParams] = useState<Record<string, string>>({});
  const [appMode, setAppMode] = useState<string | undefined>(undefined);

  // File attachment state - using multi-attachment hook
  const {
    state: attachmentState,
    handleFileSelect,
    handleRemove: handleAttachmentRemove,
    reset: resetAttachment,
    isReadyToSend: isAttachmentReadyToSend,
  } = useMultiAttachment();

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

  // Responsive collapse state for input controls
  // Track container width to determine collapse level
  const inputControlsRef = useRef<HTMLDivElement>(null);
  const [controlsContainerWidth, setControlsContainerWidth] = useState<number>(0);

  // Observe container width changes for responsive collapse
  useEffect(() => {
    const element = inputControlsRef.current;
    if (!element) return;

    const resizeObserver = new ResizeObserver(entries => {
      for (const entry of entries) {
        setControlsContainerWidth(entry.contentRect.width);
      }
    });

    resizeObserver.observe(element);
    // Initial measurement
    setControlsContainerWidth(element.clientWidth);

    return () => resizeObserver.disconnect();
  }, []);

  // Determine collapse levels based on container width
  // Collapse selectors to icon-only mode when space is limited
  const shouldCollapseSelectors =
    controlsContainerWidth > 0 && controlsContainerWidth < COLLAPSE_SELECTORS_THRESHOLD;

  // New: Get selectedTask to determine if there are messages
  const {
    selectedTaskDetail,
    refreshTasks,
    refreshSelectedTaskDetail,
    setSelectedTask,
    markTaskAsViewed,
    accessDenied,
    clearAccessDenied,
  } = useTaskContext();

  const detailTeamId = useMemo<number | null>(() => {
    if (!selectedTaskDetail?.team) {
      return null;
    }
    if (typeof selectedTaskDetail.team === 'number') {
      return selectedTaskDetail.team;
    }
    if (typeof selectedTaskDetail.team === 'object') {
      const maybeId = (selectedTaskDetail.team as { id?: number }).id;
      return typeof maybeId === 'number' ? maybeId : null;
    }
    return null;
  }, [selectedTaskDetail?.team]);

  const _detailTeamName = useMemo<string | null>(() => {
    if (!selectedTaskDetail?.team) {
      return null;
    }
    if (typeof selectedTaskDetail.team === 'object') {
      const maybeName = (selectedTaskDetail.team as { name?: string }).name;
      return typeof maybeName === 'string' ? maybeName : null;
    }
    return null;
  }, [selectedTaskDetail?.team]);

  // Global Chat Stream Context - streams persist across task switches
  const {
    getStreamState,
    isTaskStreaming,
    sendMessage: contextSendMessage,
    stopStream: contextStopStream,
    resetStream: contextResetStream,
    resumeStream: contextResumeStream,
    clearVersion,
  } = useChatStreamContext();

  const { retryMessage } = useSocket();

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
  // Check if there's any active stream (for the streaming task we started)
  const isStreamingTaskActive = streamingTaskId ? isTaskStreaming(streamingTaskId) : false;

  // Check if context reports streaming (for message sender, before subtask status is updated)
  // Computed from messages - a task is streaming if any AI message has status='streaming'
  const isContextStreaming = computeIsStreaming(currentStreamState?.messages);

  // Check if any AI message (assistant subtask) is currently running
  // This is the source of truth for streaming state, derived from actual subtask status
  // This ensures all users (including group chat members) see correct streaming state
  const isSubtaskStreaming = useMemo(() => {
    if (!selectedTaskDetail?.subtasks) return false;
    return selectedTaskDetail.subtasks.some(
      subtask => subtask.role === 'assistant' && subtask.status === 'RUNNING'
    );
  }, [selectedTaskDetail?.subtasks]);

  // Combine both sources of truth:
  // - isSubtaskStreaming: for group chat members and after task detail refresh
  // - isContextStreaming: for message sender, before subtask status is updated
  const isStreaming = isSubtaskStreaming || isContextStreaming;

  const isStopping = currentStreamState?.isStopping || false;

  // Check if there are any pending user messages in the unified messages Map
  const hasPendingUserMessage = useMemo(() => {
    if (localPendingMessage) return true;
    if (!currentStreamState?.messages) return false;
    for (const msg of currentStreamState.messages.values()) {
      if (msg.type === 'user' && msg.status === 'pending') return true;
    }
    return false;
  }, [localPendingMessage, currentStreamState?.messages]);

  // Wrapper for stopStream that uses the current display task ID
  // Passes current subtasks and team to help find running AI subtask if chat:start hasn't been received
  const stopStream = useCallback(async () => {
    const taskIdToStop = currentDisplayTaskId || streamingTaskId;

    if (taskIdToStop && taskIdToStop > 0) {
      // Pass current subtasks and team from task detail to help find running subtask and get shell_type
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

  // Group chat message handlers
  // Note: Group chat streaming from other users is now handled by useMultipleStreamingRecovery
  // in MessagesArea, which detects RUNNING ASSISTANT subtasks and recovers their streaming content.
  // This simplifies the architecture by using a single mechanism for all streaming recovery.
  const handleNewMessages = useCallback(
    (messages: SubtaskWithSender[]) => {
      if (messages.length > 0) {
        refreshSelectedTaskDetail();
      }
    },
    [refreshSelectedTaskDetail]
  );

  // When group chat stream completes, refresh to get the final message
  const handleStreamComplete = useCallback(
    (_subtaskId: number, _result?: Record<string, unknown>) => {
      // Refresh to get the final message
      refreshSelectedTaskDetail();
    },
    [refreshSelectedTaskDetail]
  );

  // Reset all local state when clearAllStreams is called (e.g., user clicks "New Chat")
  // This ensures the UI is not stuck in loading/streaming state
  // Use a ref to track the previous clearVersion to detect actual changes
  const prevClearVersionRef = useRef(clearVersion);
  useEffect(() => {
    // Only reset when clearVersion actually changes (not on initial mount)
    if (clearVersion !== prevClearVersionRef.current) {
      console.log('[ChatArea] clearVersion changed, resetting all local state', {
        prev: prevClearVersionRef.current,
        current: clearVersion,
      });
      prevClearVersionRef.current = clearVersion;

      // Reset ALL streaming-related state immediately
      setIsLoading(false);
      setLocalPendingMessage(null);
      setStreamingTaskId(null);

      // Also reset the previousTaskIdRef to prevent stale state issues
      previousTaskIdRef.current = undefined;

      // Reset prevTaskIdForModelRef to prevent model sync when creating new task
      // This ensures user's model selection is preserved after clicking "New Chat"
      prevTaskIdForModelRef.current = undefined;

      // Reset hasRestoredPreferences to allow team preference restoration for new task
      // This ensures the team selector can re-initialize when starting a new conversation
      setHasRestoredPreferences(false);

      // Reset isCancelling state to prevent UI from being stuck
      setIsCancelling(false);

      // Clear selected contexts when starting a new conversation
      // User needs to re-select knowledge bases for the new task
      setSelectedContexts([]);
    }
  }, [clearVersion]);

  // Clear streamingTaskId when the streaming task completes or when we switch to a different task
  useEffect(() => {
    if (streamingTaskId && selectedTaskDetail?.id && selectedTaskDetail.id !== streamingTaskId) {
      // User switched to a different task, clear the streaming task ID
      // The stream will continue in the background
      setStreamingTaskId(null);
    }
  }, [selectedTaskDetail?.id, streamingTaskId]);

  // Unified effect to reset streaming state in specific scenarios:
  // Only reset when user navigates to a fresh new task state (no selectedTaskDetail and no streamingTaskId)
  //
  // IMPORTANT: Do NOT reset when stream completes (streamingTaskId && !isStreamingTaskActive)
  // because we want to keep localPendingMessage visible until displayMessages is updated.
  // The pending message will be hidden by isPendingMessageAlreadyDisplayed logic in MessagesArea.
  useEffect(() => {
    // Only reset when no task selected and no active streaming task
    // This handles the case when user clicks "New Chat" or navigates away
    if (!selectedTaskDetail?.id && !streamingTaskId) {
      resetStreamingState();
      // Also reset isLoading to ensure UI is not stuck in loading state
      // This is important when user clicks "New Chat" while a message is being sent
      setIsLoading(false);
    }
  }, [selectedTaskDetail?.id, streamingTaskId, resetStreamingState]);

  // IMPORTANT: Only reset when switching to a DIFFERENT task, not when the current task gets an ID
  // This prevents clearing the pending message when a new task is created and gets its ID
  const previousTaskIdRef = useRef<number | null | undefined>(undefined);
  useEffect(() => {
    const currentTaskId = selectedTaskDetail?.id;
    const previousTaskId = previousTaskIdRef.current;

    // Only reset if:
    // 1. We had a previous task ID (not undefined, meaning this isn't the first render)
    // 2. The task ID actually changed to a different value
    // 3. We're not transitioning from null/undefined to a new ID (which happens when creating a new task)
    if (
      previousTaskId !== undefined &&
      currentTaskId !== previousTaskId &&
      previousTaskId !== null // Don't reset when going from null to a new ID
    ) {
      resetStreamingState();
    }

    previousTaskIdRef.current = currentTaskId;
  }, [selectedTaskDetail?.id, resetStreamingState]);

  // Try to resume streaming when task changes or on initial load
  // This handles the case when user refreshes the page while streaming is in progress
  useEffect(() => {
    const taskId = selectedTaskDetail?.id;
    if (!taskId) return;

    // Only try to resume if we're not already streaming for this task
    // Use isStreaming which is derived from subtask status
    if (isStreaming) return;

    // Only try to resume for Chat Shell tasks
    if (!selectedTeam || !isChatShell(selectedTeam)) return;

    // Try to resume the stream
    const tryResumeStream = async () => {
      console.log('[ChatArea] Trying to resume stream for task', taskId);
      const resumed = await contextResumeStream(taskId, {
        onComplete: (completedTaskId, subtaskId) => {
          console.log('[ChatArea] Resumed stream completed', { completedTaskId, subtaskId });
          // Refresh task detail to get the final content
          refreshSelectedTaskDetail(false);
        },
        onError: error => {
          console.error('[ChatArea] Resumed stream error', error);
        },
      });

      if (resumed) {
        console.log('[ChatArea] Stream resumed successfully for task', taskId);
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
  // 5. CRITICAL: Once we have messages, keep showing them even during data refresh
  //    to prevent the "flash of empty state" bug
  // 6. NEW: Local pending message for immediate UI feedback
  const isViewingExistingTask = Boolean(selectedTaskDetail?.id);

  const hasMessages = React.useMemo(() => {
    const hasSelectedTask = selectedTaskDetail && selectedTaskDetail.id;
    const hasNewTaskStream = !selectedTaskDetail?.id && streamingTaskId && isStreamingTaskActive;
    const hasSubtasks = selectedTaskDetail?.subtasks && selectedTaskDetail.subtasks.length > 0;
    const hasLocalPending = localPendingMessage !== null;
    // Check if there are any messages in the unified messages Map
    const hasUnifiedMessages = currentStreamState?.messages && currentStreamState.messages.size > 0;

    // Once we have a task with subtasks, always show messages view
    // This prevents flashing back to empty state during refresh
    if (hasSelectedTask && hasSubtasks) {
      return true;
    }

    return Boolean(
      hasSelectedTask ||
      hasPendingUserMessage ||
      isStreaming ||
      hasNewTaskStream ||
      hasLocalPending ||
      hasUnifiedMessages
    );
  }, [
    selectedTaskDetail,
    hasPendingUserMessage,
    isStreaming,
    streamingTaskId,
    isStreamingTaskActive,
    localPendingMessage,
    currentStreamState?.messages,
  ]);

  useEffect(() => {
    console.debug('[ChatArea][sync-state]', {
      selectedTaskId: selectedTaskDetail?.id ?? null,
      taskModelId: selectedTaskDetail?.model_id ?? null,
      detailTeamId,
      selectedTeamId: selectedTeam?.id ?? null,
      selectedModel: selectedModel?.name ?? null,
      forceOverride,
      hasMessages,
      isViewingExistingTask,
    });
  }, [
    selectedTaskDetail?.id,
    selectedTaskDetail?.model_id,
    detailTeamId,
    selectedTeam?.id,
    selectedModel?.name,
    forceOverride,
    hasMessages,
    isViewingExistingTask,
  ]);

  // Determine if chat input should be hidden (workflow mode always hides chat input)
  const shouldHideChatInput = React.useMemo(() => {
    return appMode === 'workflow';
  }, [appMode]);

  // Helper function to check if a team is compatible with the current mode
  const isTeamCompatibleWithMode = useCallback(
    (team: Team): boolean => {
      // If bind_mode is not set or is an empty array, team is not compatible
      if (!team.bind_mode || team.bind_mode.length === 0) return false;
      // Otherwise, check if current mode is in bind_mode
      return team.bind_mode.includes(taskType);
    },
    [taskType]
  );

  // Restore user preferences from localStorage when teams load
  // Only runs for new tasks (no messages), not when switching to existing tasks
  useEffect(() => {
    // Skip if already restored, no teams, or viewing existing task (has messages)
    if (hasRestoredPreferences || !teams.length || (!selectedTaskDetail && hasMessages)) return;

    const lastTeamId = initialTeamIdRef.current;

    if (lastTeamId) {
      const lastTeam = teams.find(team => team.id === lastTeamId);
      // Only restore if the team is compatible with current mode
      if (lastTeam && isTeamCompatibleWithMode(lastTeam)) {
        setSelectedTeam(lastTeam);
        setHasRestoredPreferences(true);
        return;
      } else {
        console.log(
          '[ChatArea] ❌ Team from localStorage not found or not compatible with current mode, ID:',
          lastTeamId
        );
      }
    }

    // No valid preference, use first compatible team as default
    const compatibleTeam = teams.find(team => isTeamCompatibleWithMode(team));
    if (compatibleTeam) {
      console.log(
        '[ChatArea] No valid preference, using first compatible team as default:',
        compatibleTeam.name,
        compatibleTeam.id
      );
      setSelectedTeam(compatibleTeam);
    } else {
      console.log('[ChatArea] No compatible team found for current mode:', taskType);
    }
    setHasRestoredPreferences(true);
    // Note: selectedTaskDetail is intentionally excluded from dependencies
    // This effect should only run when teams load, not when task detail changes
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [teams, hasRestoredPreferences, hasMessages, isTeamCompatibleWithMode]);

  // Handle external team selection for new tasks (from team sharing)
  useEffect(() => {
    if (selectedTeamForNewTask && !selectedTaskDetail) {
      setSelectedTeam(selectedTeamForNewTask);
    }
  }, [selectedTeamForNewTask, selectedTaskDetail]);

  // Sync team selection when viewing an existing task
  useEffect(() => {
    if (!detailTeamId) {
      return;
    }

    if (!selectedTeam?.id || selectedTeam.id !== detailTeamId) {
      // Try to find team in teams list first
      const matchedTeam = teams.find(team => team.id === detailTeamId) || null;
      if (matchedTeam) {
        setSelectedTeam(matchedTeam);
        setHasRestoredPreferences(true);
      } else {
        // For group chat members: team might not be in teams list
        // Use team object directly from selectedTaskDetail if available
        if (selectedTaskDetail?.team && typeof selectedTaskDetail.team === 'object') {
          const teamFromDetail = selectedTaskDetail.team as Team;
          if (teamFromDetail.id === detailTeamId) {
            console.log(
              '[ChatArea] Using team from task detail (group chat member):',
              teamFromDetail.name
            );
            setSelectedTeam(teamFromDetail);
            setHasRestoredPreferences(true);
          }
        }
      }
    }
  }, [detailTeamId, teams, selectedTeam?.id, setSelectedTeam, selectedTaskDetail?.team]);

  // Set model and override flag when viewing existing task
  // Track previous task ID to only run when task actually changes
  const prevTaskIdForModelRef = useRef<number | null | undefined>(undefined);
  useEffect(() => {
    if (!selectedTaskDetail?.id || !selectedTeam) {
      return;
    }

    // Only sync model when task ID actually changes (not on every render)
    // This prevents overwriting user's model selection when they manually change it
    const taskIdChanged = prevTaskIdForModelRef.current !== selectedTaskDetail.id;
    if (!taskIdChanged) {
      // Task ID hasn't changed, don't override user's selection
      return;
    }

    // IMPORTANT: Only sync model when switching FROM an existing task TO another task
    // When prevTaskIdForModelRef.current is undefined, it means:
    // 1. Initial page load, OR
    // 2. User just sent a message and created a new task
    // In both cases, we should NOT override the user's model selection
    // We only sync model when user explicitly switches to a different existing task
    const isUserSwitchingTasks =
      prevTaskIdForModelRef.current !== undefined && prevTaskIdForModelRef.current !== null;

    prevTaskIdForModelRef.current = selectedTaskDetail.id;

    // Skip model sync if this is not a user-initiated task switch
    if (!isUserSwitchingTasks) {
      return;
    }

    const taskModelId = selectedTaskDetail.model_id;

    const handleDefaultModel = () => {
      setSelectedModel({ name: DEFAULT_MODEL_NAME, provider: '', modelId: '' });
      setForceOverride(false);
    };

    const handleExplicitModel = (modelName: string) => {
      setSelectedModel({
        name: modelName,
        provider: '',
        modelId: modelName,
        displayName: null,
        type: undefined,
      });
    };

    if (!taskModelId || taskModelId === DEFAULT_MODEL_NAME) {
      // Try to match the team's current default model (first bot's bound model)
      const teamModelName = (() => {
        if (!selectedTeam.bots || selectedTeam.bots.length === 0) {
          return null;
        }
        const firstBotConfig = selectedTeam.bots[0]?.bot?.agent_config;
        if (!firstBotConfig) {
          return null;
        }
        try {
          return (firstBotConfig as Record<string, unknown>).bind_model as string | undefined;
        } catch (_error) {
          return null;
        }
      })();

      if (teamModelName) {
        handleExplicitModel(teamModelName);
        setForceOverride(false);
      } else {
        handleDefaultModel();
      }
      return;
    }

    handleExplicitModel(taskModelId);
    setForceOverride(true);
  }, [
    selectedTaskDetail?.id,
    selectedTaskDetail?.model_id,
    selectedTeam,
    // NOTE: selectedModel and forceOverride are intentionally excluded
    // to prevent overwriting user's manual selection
    setSelectedModel,
    setForceOverride,
  ]);
  const shouldHideQuotaUsage = React.useMemo(() => {
    if (!isMobile || !selectedTeam?.name) return false;

    if (selectedTeam.share_status === 2 && selectedTeam.user?.user_name) {
      return selectedTeam.name.trim().length > 12;
    }

    return selectedTeam.name.trim().length > SHOULD_HIDE_QUOTA_NAME_LIMIT;
  }, [selectedTeam, isMobile]);

  // Always use compact mode (icon only) to save space
  const shouldUseCompactQuota = true;

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

  // Unified canSubmit flag for both button and keyboard submission
  // This ensures consistent behavior between clicking the send button and pressing Enter
  const canSubmit = React.useMemo(() => {
    return !isLoading && !isStreaming && !isModelSelectionRequired && isAttachmentReadyToSend;
  }, [isLoading, isStreaming, isModelSelectionRequired, isAttachmentReadyToSend]);

  const handleTeamChange = (team: Team | null) => {
    console.log('[ChatArea] handleTeamChange called:', team?.name || 'null', team?.id || 'null');
    setSelectedTeam(team);

    // Reset external API params when team changes
    setExternalApiParams({});
    setAppMode(undefined);

    // Save team preference to localStorage by mode
    if (team && team.id) {
      console.log('[ChatArea] Saving team to localStorage for mode:', taskType, team.id);
      saveLastTeamByMode(team.id, taskType);
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

      if (isLoading || isStreaming || attachmentState.attachments.length > 0) return;
      setIsDragging(true);
    },
    [isLoading, isStreaming, attachmentState.attachments.length, selectedTeam]
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

      if (isLoading || isStreaming || attachmentState.attachments.length > 0) return;

      const file = e.dataTransfer.files?.[0];
      if (file) {
        handleFileSelect(file);
      }
    },
    [isLoading, isStreaming, attachmentState.attachments.length, handleFileSelect, selectedTeam]
  );

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

  /**
   * Helper function to create retry button for toast notifications
   * Reduces code duplication for error handling
   */
  const createRetryButton = useCallback(
    (onRetryClick: () => void) => (
      <Button variant="outline" size="sm" onClick={onRetryClick}>
        {t('actions.retry') || '重试'}
      </Button>
    ),
    [t]
  );

  /**
   * Helper function to handle send errors with retry logic
   * Extracts duplicate error handling from onError callback and catch block
   */
  const handleSendError = useCallback(
    (error: Error, message: string) => {
      // Reset all streaming state on error
      resetStreamingState();

      // Parse error to provide better user feedback
      const parsedError = parseError(error);

      // Store message for retry
      lastFailedMessageRef.current = message;

      // Show error toast with retry button if error is retryable
      toast({
        variant: 'destructive',
        title: parsedError.retryable
          ? t('errors.request_failed_retry')
          : t('errors.model_unsupported'),
        action: parsedError.retryable
          ? createRetryButton(() => {
              // Retry by calling handleSendMessage with the last failed message
              if (lastFailedMessageRef.current && handleSendMessageRef.current) {
                handleSendMessageRef.current(lastFailedMessageRef.current);
              }
            })
          : undefined,
      });
    },
    [resetStreamingState, toast, t, createRetryButton]
  );

  // Core message sending logic - can be called directly with a message or use taskInputMessage
  // All team types now use WebSocket for unified message sending
  const handleSendMessage = useCallback(
    async (overrideMessage?: string) => {
      const message = overrideMessage?.trim() || taskInputMessage.trim();
      if (!message && !shouldHideChatInput) return;

      // Check if attachment is ready
      if (!isAttachmentReadyToSend) {
        toast({
          variant: 'destructive',
          title: '请等待文件上传完成',
        });
        return;
      }

      // For code type tasks, repository is required
      // Use git info from selectedTaskDetail if available (for existing tasks opened via URL)
      // This fixes the issue where clarification form can't submit when repo selector hasn't synced yet
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
      setError('');

      console.log('[ChatArea] handleSendMessage - using unified WebSocket mode:', {
        selectedTeam: selectedTeam?.name,
        selectedTeamId: selectedTeam?.id,
        agentType: selectedTeam?.agent_type,
        taskType: taskType,
        attachmentIds: attachmentState.attachments.map(a => a.id),
      });

      // OPTIMIZATION: Set local pending state IMMEDIATELY for instant UI feedback
      // This happens synchronously before any async operations
      setLocalPendingMessage(message);

      setTaskInputMessage('');
      // Reset attachment immediately after sending (clear from input area)
      resetAttachment();
      // Keep selectedContexts - user wants to maintain context selection across messages
      // Backend will persist contexts to Task CRD and use them for subsequent queries

      // When default model is selected, don't pass model_id (use bot's predefined model)
      const modelId = selectedModel?.name === DEFAULT_MODEL_NAME ? undefined : selectedModel?.name;

      // Prepare message with embedded external API parameters if applicable (for Dify teams)
      let finalMessage = message;
      if (Object.keys(externalApiParams).length > 0) {
        // Embed parameters using special marker format
        // Backend will extract these parameters for external API calls
        const paramsJson = JSON.stringify(externalApiParams);
        finalMessage = `[EXTERNAL_API_PARAMS]${paramsJson}[/EXTERNAL_API_PARAMS]\n${message}`;
      }

      try {
        // For new tasks, generate a temporary ID for tracking
        // NOTE: We do NOT set streamingTaskId here - it will be set when chat:start event is received
        // This ensures AI response rendering is only triggered by server push events
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

        // Use the global context to send message with callbacks
        // Pass immediateTaskId to ensure ChatArea and context use the same temporary ID
        const tempTaskId = await contextSendMessage(
          {
            message: finalMessage,
            team_id: selectedTeam?.id ?? 0,
            task_id: selectedTaskDetail?.id,
            model_id: modelId,
            force_override_bot_model: forceOverride,
            attachment_ids: attachmentState.attachments.map(a => a.id),
            enable_deep_thinking: enableDeepThinking,
            enable_clarification: enableClarification,
            is_group_chat: selectedTaskDetail?.is_group_chat || false,
            // Pass repository info for code tasks
            // Use effectiveRepo to handle cases where repo selector hasn't synced yet
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
            pendingAttachments: attachmentState.attachments,
            immediateTaskId: immediateTaskId,
            // Pass current user info for group chat sender display
            currentUserId: user?.id,
            currentUserName: user?.user_name,
            // Called immediately after message is sent (before AI response)
            // NOTE: NO REFRESH - the UI displays pendingUserMessage from state
            // The message will remain visible until user sends another message or switches tasks
            // New signature: (localMessageId, taskId, subtaskId) for precise message update
            onMessageSent: (
              _localMessageId: string,
              completedTaskId: number,
              _subtaskId: number
            ) => {
              // Update streaming task ID when real task ID is resolved
              if (completedTaskId > 0) {
                setStreamingTaskId(completedTaskId);
              }

              // If this was a new task (first message), update URL and task list
              if (completedTaskId && !selectedTaskDetail?.id) {
                const params = new URLSearchParams(Array.from(searchParams.entries()));
                params.set('taskId', String(completedTaskId));
                router.push(`?${params.toString()}`);

                // Update task list in sidebar (but don't refresh task detail)
                refreshTasks();
              }

              // For group chat: mark task as viewed when user sends a message
              // This prevents showing unread indicator for the sender's own messages
              // The backend updates task.updated_at when any message is sent,
              // so we need to update viewedAt to match
              if (selectedTaskDetail?.is_group_chat && completedTaskId) {
                markTaskAsViewed(
                  completedTaskId,
                  selectedTaskDetail.status,
                  new Date().toISOString()
                );
              }
              // NO REFRESH of task detail - pendingUserMessage is displayed from state
              // This prevents the progress bar flash issue
            },
            onError: (error: Error) => {
              handleSendError(error, message);
            },
          }
        );

        // Update streaming task ID if it changed (e.g., from immediate to returned)
        // Only update if we got a different ID back
        if (tempTaskId !== immediateTaskId && tempTaskId > 0) {
          setStreamingTaskId(tempTaskId);
        }

        // Note: For new tasks, the selected task is now set in onTaskIdResolved callback
        // when the real task ID is received from the backend

        // Manually trigger scroll to bottom after sending message
        setTimeout(() => scrollToBottom(true), 0);
      } catch (err) {
        handleSendError(err as Error, message);
      }

      setIsLoading(false);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [
      taskInputMessage,
      shouldHideChatInput,
      isAttachmentReadyToSend,
      toast,
      selectedTeam,
      attachmentState.attachments,
      resetAttachment,
      selectedModel?.name,
      selectedTaskDetail?.id,
      selectedTaskDetail?.is_group_chat,
      selectedTaskDetail?.status,
      selectedTaskDetail?.git_url,
      selectedTaskDetail?.git_repo,
      selectedTaskDetail?.git_repo_id,
      selectedTaskDetail?.git_domain,
      selectedTaskDetail?.branch_name,
      contextSendMessage,
      forceOverride,
      enableDeepThinking,
      enableClarification,
      refreshTasks,
      searchParams,
      router,
      refreshSelectedTaskDetail,
      contextResetStream,
      resetStreamingState,
      scrollToBottom,
      externalApiParams,
      showRepositorySelector,
      selectedRepo,
      selectedBranch,
      taskType,
      setSelectedTask,
      markTaskAsViewed,
      user?.id,
      user?.user_name,
      createRetryButton,
    ]
  );

  // Update ref when handleSendMessage changes
  useEffect(() => {
    handleSendMessageRef.current = handleSendMessage;
  }, [handleSendMessage]);

  /**
   * Handle retry for failed messages
   * Uses Same-ID retry: reuses the original user message and creates a new AI subtask
   * with the same message_id
   */
  const handleRetry = useCallback(
    async (message: { content: string; type: string; error?: string; subtaskId?: number }) => {
      // Same-ID retry: retry on the same message by reusing the existing user message
      // and creating a new AI subtask with the same message_id
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
            // Use the SAME model logic as sending new messages
            // When default model is selected, don't pass model_id (use bot's predefined model)
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
            console.error('[ChatArea] Retry failed:', error);
            toast({
              variant: 'destructive',
              title: t('errors.request_failed_retry'),
            });
            throw error; // Re-throw to mark the trace as failed
          }
        }
      );
    },
    [
      retryMessage,
      selectedTaskDetail?.id,
      selectedModel?.name,
      selectedModel?.type,
      forceOverride,
      t,
      toast,
      traceAction,
    ]
  );

  const [isCancelling, setIsCancelling] = useState(false);

  const handleCancelTask = useCallback(async () => {
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
  }, [selectedTaskDetail?.id, isCancelling, toast, refreshTasks, refreshSelectedTaskDetail]);

  // Callback for MessagesArea to notify content changes (for auto-scroll during streaming)
  const handleMessagesContentChange = useCallback(() => {
    // During streaming or when user is near bottom, auto-scroll to bottom
    if (isStreaming || isUserNearBottomRef.current) {
      scrollToBottom();
    }
  }, [isStreaming, scrollToBottom]);
  // Callback for child components (e.g., ClarificationForm) to send messages directly
  // This ensures all chat options (web search, clarification mode, model, etc.) are properly included
  // Reuses handleSendMessage to avoid code duplication
  const handleSendMessageFromChild = useCallback(
    async (content: string) => {
      // Combine the content from child component with any existing input text
      const existingInput = taskInputMessage.trim();
      const combinedMessage = existingInput ? `${content}\n\n---\n\n${existingInput}` : content;

      // Clear the input field immediately
      setTaskInputMessage('');

      // Reuse handleSendMessage with the combined message
      await handleSendMessage(combinedMessage);
    },
    [taskInputMessage, handleSendMessage]
  );

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
  // Handle access denied state - show error UI when user doesn't have permission
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
            {/* Error Icon */}
            <div className="flex justify-center mb-6">
              <div className="w-20 h-20 rounded-full bg-destructive/10 flex items-center justify-center">
                <ShieldX className="h-10 w-10 text-destructive" />
              </div>
            </div>

            {/* Error Title */}
            <h1 className="text-2xl font-semibold text-center mb-3 text-text-primary">
              {t('tasks.access_denied_title')}
            </h1>

            {/* Error Description */}
            <p className="text-center text-text-muted mb-8 leading-relaxed">
              {t('tasks.access_denied_description')}
            </p>

            {/* Action Button */}
            <div className="flex justify-center">
              <Button
                onClick={handleGoHome}
                variant="default"
                size="default"
                className="min-w-[160px]"
              >
                {t('tasks.access_denied_go_home')}
              </Button>
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div
      ref={chatAreaRef}
      className="flex-1 flex flex-col min-h-0 w-full relative"
      style={{ height: '100%', boxSizing: 'border-box' }}
    >
      {/* Group Chat Sync Manager - zero UI, handles polling for new messages */}
      {/* Note: Streaming content recovery is handled by useMultipleStreamingRecovery in MessagesArea */}
      {selectedTaskDetail?.is_group_chat && selectedTaskDetail.id && (
        <GroupChatSyncManager
          taskId={selectedTaskDetail.id}
          isGroupChat={true}
          enabled={true}
          onNewMessages={handleNewMessages}
          onStreamComplete={handleStreamComplete}
        />
      )}

      {/* Messages Area: always mounted to keep scroll container stable */}
      <div className={hasMessages ? 'relative flex-1 min-h-0' : 'relative'}>
        {/* Top gradient fade effect - only show when has messages */}
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
              selectedTeam={selectedTeam}
              selectedRepo={selectedRepo}
              selectedBranch={selectedBranch}
              onContentChange={handleMessagesContentChange}
              onShareButtonRender={onShareButtonRender}
              onSendMessage={handleSendMessageFromChild}
              isGroupChat={selectedTaskDetail?.is_group_chat || false}
              onRetry={handleRetry}
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
            {/* Floating Input Area */}
            <div ref={floatingInputRef} className="w-full max-w-4xl mx-auto px-4 sm:px-6">
              {/* Slogan Display - always render to maintain consistent layout height */}
              {/* This prevents the chat input from "jumping" when switching between /chat and /code tabs */}
              <SloganDisplay slogan={randomSlogan} />
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
                  className={`relative w-full flex flex-col rounded-3xl border border-border bg-base shadow-[0px_4px_24px_0px_rgba(111,79,191,0.06)] transition-colors ${isDragging ? 'border-primary ring-2 ring-primary/20' : ''}`}
                  onDragEnter={handleDragEnter}
                  onDragLeave={handleDragLeave}
                  onDragOver={handleDragOver}
                  onDrop={handleDrop}
                >
                  {/* Drag Overlay */}
                  {isDragging && (
                    <div className="absolute inset-0 z-50 rounded-3xl bg-base/95 backdrop-blur-sm flex flex-col items-center justify-center border-2 border-dashed border-primary transition-all animate-in fade-in duration-200">
                      <div className="p-4 rounded-full bg-primary/10 mb-4 animate-bounce">
                        <Upload className="h-8 w-8 text-primary" />
                      </div>
                      <p className="text-lg font-medium text-primary">释放以上传文件</p>
                      <p className="text-sm text-text-muted mt-1">
                        支持 PDF, Word, TXT, Markdown 等格式
                      </p>
                    </div>
                  )}

                  {/* File Upload Preview - show above input on its own row */}
                  {(attachmentState.attachments.length > 0 ||
                    attachmentState.uploadingFiles.size > 0 ||
                    attachmentState.errors.size > 0) && (
                    <div className="px-3 pt-2">
                      <AttachmentUploadPreview
                        state={attachmentState}
                        onRemove={handleAttachmentRemove}
                        disabled={hasMessages || isLoading || isStreaming}
                      />
                    </div>
                  )}
                  {/* Chat Input with inline badge */}
                  {!shouldHideChatInput && (
                    <div className="px-4 pt-2">
                      <ChatInput
                        message={taskInputMessage}
                        setMessage={setTaskInputMessage}
                        handleSendMessage={handleSendMessage}
                        isLoading={isLoading}
                        taskType={taskType}
                        autoFocus={!hasMessages}
                        canSubmit={canSubmit}
                        tipText={randomTip}
                        badge={selectedTeam ? <SelectedTeamBadge team={selectedTeam} /> : undefined}
                        isGroupChat={selectedTaskDetail?.is_group_chat || false}
                        team={selectedTeam}
                        onPasteFile={
                          isChatShell(selectedTeam) && attachmentState.attachments.length === 0
                            ? handleFileSelect
                            : undefined
                        }
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
                  <div
                    className={`flex items-center justify-between px-3 gap-2 ${shouldHideChatInput ? 'py-3' : 'pb-2 pt-1'}`}
                    ref={inputControlsRef}
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
                        <AttachmentButton
                          onFileSelect={handleFileSelect}
                          disabled={hasMessages || isLoading || isStreaming}
                        />
                      )}
                      {/* Clarification Toggle Button - only show for chat shell */}
                      {isChatShell(selectedTeam) && (
                        <ClarificationToggle
                          enabled={enableClarification}
                          onToggle={setEnableClarification}
                          disabled={isLoading || isStreaming}
                        />
                      )}
                      {selectedTeam && (
                        <ModelSelector
                          selectedModel={selectedModel}
                          setSelectedModel={setSelectedModel}
                          forceOverride={forceOverride}
                          setForceOverride={setForceOverride}
                          selectedTeam={selectedTeam}
                          disabled={
                            isLoading || isStreaming || (hasMessages && !isChatShell(selectedTeam))
                          }
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
                      ) : selectedTaskDetail?.status === 'PENDING' &&
                        !isSubtaskStreaming &&
                        selectedTaskDetail?.is_group_chat ? (
                        // For group chat: if task status is PENDING but no AI subtask is running,
                        // show normal send button instead of loading animation.
                        // This handles the case where group chat messages don't trigger AI (no @mention)
                        <SendButton
                          onClick={() => handleSendMessage()}
                          disabled={
                            isLoading ||
                            isStreaming ||
                            isModelSelectionRequired ||
                            !isAttachmentReadyToSend ||
                            (shouldHideChatInput ? false : !taskInputMessage.trim())
                          }
                          isLoading={isLoading}
                        />
                      ) : selectedTaskDetail?.status === 'PENDING' ? (
                        // For non-group-chat tasks with PENDING status, show loading animation
                        <Button
                          variant="ghost"
                          size="icon"
                          disabled
                          className="h-6 w-6 rounded-full flex-shrink-0 translate-y-0.5"
                        >
                          <LoadingDots />
                        </Button>
                      ) : selectedTaskDetail?.status === 'CANCELLING' ? (
                        <div className="relative h-6 w-6 flex items-center justify-center flex-shrink-0 translate-y-0.5">
                          <div className="absolute inset-0 rounded-full border-2 border-orange-200 border-t-orange-500 animate-spin" />
                          <CircleStop className="h-5 w-5 text-orange-500" />
                        </div>
                      ) : (
                        <SendButton
                          onClick={() => handleSendMessage()}
                          disabled={
                            isLoading ||
                            isStreaming ||
                            isModelSelectionRequired ||
                            !isAttachmentReadyToSend ||
                            (shouldHideChatInput ? false : !taskInputMessage.trim())
                          }
                          isLoading={isLoading}
                        />
                      )}
                    </div>
                  </div>
                </div>
              </div>
              {/* Quick Access Cards - show below input card when no messages */}
              <QuickAccessCards
                teams={teams}
                selectedTeam={selectedTeam}
                onTeamSelect={handleTeamChange}
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
                className={`relative w-full flex flex-col rounded-3xl border border-border bg-base shadow-[0px_4px_24px_0px_rgba(111,79,191,0.06)] transition-colors ${isDragging ? 'border-primary ring-2 ring-primary/20' : ''}`}
                onDragEnter={handleDragEnter}
                onDragLeave={handleDragLeave}
                onDragOver={handleDragOver}
                onDrop={handleDrop}
              >
                {/* Drag Overlay */}
                {isDragging && (
                  <div className="absolute inset-0 z-50 rounded-3xl bg-base/95 backdrop-blur-sm flex flex-col items-center justify-center border-2 border-dashed border-primary transition-all animate-in fade-in duration-200">
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
                {(attachmentState.attachments.length > 0 ||
                  attachmentState.uploadingFiles.size > 0 ||
                  attachmentState.errors.size > 0) && (
                  <div className="px-3 pt-2">
                    <AttachmentUploadPreview
                      state={attachmentState}
                      onRemove={handleAttachmentRemove}
                      disabled={isLoading || isStreaming}
                    />
                  </div>
                )}
                {/* Chat Input - hide for workflow mode */}
                {!shouldHideChatInput && (
                  <div className="px-4 pt-2">
                    <ChatInput
                      message={taskInputMessage}
                      setMessage={setTaskInputMessage}
                      handleSendMessage={handleSendMessage}
                      isLoading={isLoading}
                      taskType={taskType}
                      canSubmit={canSubmit}
                      tipText={randomTip}
                      badge={selectedTeam ? <SelectedTeamBadge team={selectedTeam} /> : undefined}
                      isGroupChat={selectedTaskDetail?.is_group_chat || false}
                      team={selectedTeam}
                      onPasteFile={
                        isChatShell(selectedTeam) && attachmentState.attachments.length === 0
                          ? handleFileSelect
                          : undefined
                      }
                    />
                  </div>
                )}
                {/* Team Selector and Send Button - always show */}
                <div
                  className={`flex items-center justify-between px-3 gap-2 ${shouldHideChatInput ? 'py-3' : 'pb-2 pt-1'}`}
                >
                  <div className="flex-1 min-w-0 overflow-hidden flex items-center gap-3">
                    {/* Context Selection - only show for chat shell */}
                    {isChatShell(selectedTeam) && (
                      <ChatContextInput
                        selectedContexts={selectedContexts}
                        onContextsChange={setSelectedContexts}
                      />
                    )}
                    {/* File Upload Button - always show for chat shell */}
                    {isChatShell(selectedTeam) && (
                      <AttachmentButton
                        onFileSelect={handleFileSelect}
                        disabled={isLoading || isStreaming}
                      />
                    )}
                    {/* Clarification Toggle Button - only show for chat shell */}
                    {isChatShell(selectedTeam) && (
                      <ClarificationToggle
                        enabled={enableClarification}
                        onToggle={setEnableClarification}
                        disabled={isLoading || isStreaming}
                      />
                    )}
                    {selectedTeam && (
                      <ModelSelector
                        selectedModel={selectedModel}
                        setSelectedModel={setSelectedModel}
                        forceOverride={forceOverride}
                        setForceOverride={setForceOverride}
                        selectedTeam={selectedTeam}
                        disabled={
                          isLoading || isStreaming || (hasMessages && !isChatShell(selectedTeam))
                        }
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
                    ) : selectedTaskDetail?.status === 'PENDING' &&
                      !isSubtaskStreaming &&
                      selectedTaskDetail?.is_group_chat ? (
                      // For group chat: if task status is PENDING but no AI subtask is running,
                      // show normal send button instead of loading animation.
                      // This handles the case where group chat messages don't trigger AI (no @mention)
                      <SendButton
                        onClick={() => handleSendMessage()}
                        disabled={
                          isLoading ||
                          isStreaming ||
                          isModelSelectionRequired ||
                          !isAttachmentReadyToSend ||
                          (shouldHideChatInput ? false : !taskInputMessage.trim())
                        }
                        isLoading={isLoading}
                      />
                    ) : selectedTaskDetail?.status === 'PENDING' ? (
                      // For non-group-chat tasks with PENDING status, show loading animation
                      <Button
                        variant="ghost"
                        size="icon"
                        disabled
                        className="h-6 w-6 rounded-full flex-shrink-0 translate-y-0.5"
                      >
                        <LoadingDots />
                      </Button>
                    ) : selectedTaskDetail?.status === 'CANCELLING' ? (
                      <div className="relative h-6 w-6 flex items-center justify-center flex-shrink-0 translate-y-0.5">
                        <div className="absolute inset-0 rounded-full border-2 border-orange-200 border-t-orange-500 animate-spin" />
                        <CircleStop className="h-5 w-5 text-orange-500" />
                      </div>
                    ) : (
                      <SendButton
                        onClick={() => handleSendMessage()}
                        disabled={
                          isLoading ||
                          isStreaming ||
                          isModelSelectionRequired ||
                          !isAttachmentReadyToSend ||
                          (shouldHideChatInput ? false : !taskInputMessage.trim())
                        }
                        isLoading={isLoading}
                      />
                    )}
                  </div>
                </div>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
