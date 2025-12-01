// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client';

import React, { useState, useEffect, useRef, useCallback } from 'react';
import { Send, CircleStop } from 'lucide-react';
import MessagesArea from './MessagesArea';
import ChatInput from './ChatInput';
import TeamSelector from './TeamSelector';
import TeamShowcase from './TeamShowcase';
import ModelSelector, { Model, DEFAULT_MODEL_NAME } from './ModelSelector';
import RepositorySelector from './RepositorySelector';
import BranchSelector from './BranchSelector';
import LoadingDots from './LoadingDots';
import ExternalApiParamsInput from './ExternalApiParamsInput';
import type { Team, GitRepoInfo, GitBranch } from '@/types/api';
import { sendMessage } from '../service/messageService';
import { useRouter, useSearchParams } from 'next/navigation';
import { useTaskContext } from '../contexts/taskContext';
import { Button } from '@/components/ui/button';
import QuotaUsage from './QuotaUsage';
import { useMediaQuery } from '@/hooks/useMediaQuery';
import { saveLastTeam, getLastTeamId, saveLastRepo } from '@/utils/userPreferences';
import { useToast } from '@/hooks/use-toast';
import { taskApis } from '@/apis/tasks';

const SHOULD_HIDE_QUOTA_NAME_LIMIT = 18;
// Threshold for combined team name + model name length to trigger compact quota mode
const COMPACT_QUOTA_NAME_THRESHOLD = 22;

interface ChatAreaProps {
  teams: Team[];
  isTeamsLoading: boolean;
  selectedTeamForNewTask?: Team | null;
  showRepositorySelector?: boolean;
  taskType?: 'chat' | 'code';
}

export default function ChatArea({
  teams,
  isTeamsLoading,
  selectedTeamForNewTask,
  showRepositorySelector = true,
  taskType = 'chat',
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

  // New: Get selectedTask to determine if there are messages
  const { selectedTaskDetail, refreshTasks, refreshSelectedTaskDetail, setSelectedTask } =
    useTaskContext();
  const hasMessages = Boolean(selectedTaskDetail && selectedTaskDetail.id);
  const subtaskList = selectedTaskDetail?.subtasks ?? [];
  const lastSubtask = subtaskList.length ? subtaskList[subtaskList.length - 1] : null;
  const lastSubtaskId = lastSubtask?.id;
  const lastSubtaskUpdatedAt = lastSubtask?.updated_at || lastSubtask?.completed_at;

  // Determine if chat input should be hidden (workflow mode always hides chat input)
  const shouldHideChatInput = React.useMemo(() => {
    return appMode === 'workflow';
  }, [appMode]);

  // Restore user preferences from localStorage when teams load
  useEffect(() => {
    console.log('[ChatArea] Preference restoration effect triggered', {
      teamsLength: teams.length,
      hasRestoredPreferences,
      selectedTeam: selectedTeam?.name || 'null',
      selectedTeamId: selectedTeam?.id || 'null',
      initialTeamId: initialTeamIdRef.current,
    });

    if (hasRestoredPreferences || !teams.length) return;

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
  }, [teams, hasRestoredPreferences, selectedTeam]);

  // Handle external team selection for new tasks (from team sharing)
  useEffect(() => {
    if (selectedTeamForNewTask && !hasMessages) {
      setSelectedTeam(selectedTeamForNewTask);
    }
  }, [selectedTeamForNewTask, hasMessages]);

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

  const handleSendMessage = async () => {
    setIsLoading(true);
    setError('');

    // Prepare message with embedded external API parameters if applicable
    let finalMessage = taskInputMessage;
    if (Object.keys(externalApiParams).length > 0) {
      // Embed parameters using special marker format
      // Backend will extract these parameters for external API calls
      const paramsJson = JSON.stringify(externalApiParams);
      finalMessage = `[EXTERNAL_API_PARAMS]${paramsJson}[/EXTERNAL_API_PARAMS]\n${taskInputMessage}`;
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
          title: taskInputMessage.substring(0, 100),
          team_id: selectedTeam?.id || 0,
          git_url: selectedRepo?.git_url || '',
          git_repo: selectedRepo?.git_repo || '',
          git_repo_id: selectedRepo?.git_repo_id || 0,
          git_domain: selectedRepo?.git_domain || '',
          branch_name: selectedBranch?.name || '',
          prompt: taskInputMessage,
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

  const scrollToBottom = (force = false) => {
    const container = scrollContainerRef.current;
    if (!container) return;

    if (force || isUserNearBottomRef.current) {
      container.scrollTop = container.scrollHeight;
      // Force means user initiated action, treat as pinned to bottom
      if (force) {
        isUserNearBottomRef.current = true;
      }
    }
  };

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
  }, [selectedTaskDetail?.id, hasMessages]);

  useEffect(() => {
    if (!hasMessages || !lastSubtaskId) return;

    const timer = setTimeout(() => {
      // Auto scroll when new subtasks/messages are appended
      scrollToBottom();
    }, 60);

    return () => clearTimeout(timer);
  }, [hasMessages, lastSubtaskId, lastSubtaskUpdatedAt]);

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
        <div className="w-full max-w-4xl mx-auto px-4 sm:px-6">
          <MessagesArea
            selectedTeam={selectedTeam}
            selectedRepo={selectedRepo}
            selectedBranch={selectedBranch}
          />
        </div>
      </div>

      {/* Main Content Area */}
      <div className={hasMessages ? 'w-full' : 'flex-1 flex flex-col w-full'}>
        {/* Center area for input when no messages */}
        {!hasMessages && (
          <div className="flex-1 flex items-center justify-center w-full">
            {/* Floating Input Area */}
            <div ref={floatingInputRef} className="w-full max-w-4xl px-4 sm:px-6">
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
                <div className="relative w-full flex flex-col rounded-2xl border border-border bg-base shadow-lg">
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
                    <div className="flex-1 min-w-0 overflow-hidden flex items-center gap-3">
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
                      {selectedTaskDetail?.status === 'PENDING' ? (
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
                            isLoading || (shouldHideChatInput ? false : !taskInputMessage.trim())
                          }
                          className="h-6 w-6 rounded-full hover:bg-primary/10 flex-shrink-0 translate-y-0.5"
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

                {/* Team Showcase - Recommended and Favorites */}
                <TeamShowcase onSelectTeam={handleTeamChange} />
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
              <div className="relative w-full flex flex-col rounded-2xl border border-border bg-base shadow-lg">
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
                    {selectedTaskDetail?.status === 'PENDING' ? (
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
                          isLoading || (shouldHideChatInput ? false : !taskInputMessage.trim())
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
        )}
      </div>
    </div>
  );
}
