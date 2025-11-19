// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client';

import React, { useState, useEffect, useRef } from 'react';
import { PaperAirplaneIcon } from '@heroicons/react/24/outline';
import MessagesArea from './MessagesArea';
import ChatInput from './ChatInput';
import TeamSelector from './TeamSelector';
import RepositorySelector from './RepositorySelector';
import BranchSelector from './BranchSelector';
import LoadingDots from './LoadingDots';
import type { Team, GitRepoInfo, GitBranch } from '@/types/api';
import { sendMessage } from '../service/messageService';
import { useRouter, useSearchParams } from 'next/navigation';
import { useTaskContext } from '../contexts/taskContext';
import { App, Button } from 'antd';
import QuotaUsage from './QuotaUsage';
import { useMediaQuery } from '@/hooks/useMediaQuery';
import { saveLastTeam, getLastTeamId, saveLastRepo } from '@/utils/userPreferences';

const SHOULD_HIDE_QUOTA_NAME_LIMIT = 18;

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
  const { message } = App.useApp();

  // Pre-load team preference from localStorage to use as initial value
  const initialTeamIdRef = useRef<number | null>(null);
  if (initialTeamIdRef.current === null && typeof window !== 'undefined') {
    initialTeamIdRef.current = getLastTeamId();
    console.log('[ChatArea] Pre-loaded team ID from localStorage:', initialTeamIdRef.current);
  }

  const [selectedTeam, setSelectedTeam] = useState<Team | null>(null);
  const [selectedRepo, setSelectedRepo] = useState<GitRepoInfo | null>(null);
  const [selectedBranch, setSelectedBranch] = useState<GitBranch | null>(null);
  const [hasRestoredPreferences, setHasRestoredPreferences] = useState(false);
  const isMobile = useMediaQuery('(max-width: 640px)');

  const [taskInputMessage, setTaskInputMessage] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  // Unified error prompt using antd message.error, no local error state needed
  const [_error, setError] = useState('');

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
        console.log('[ChatArea] ✅ Restoring team from localStorage:', lastTeam.name, lastTeam.id);
        setSelectedTeam(lastTeam);
        setHasRestoredPreferences(true);
        return;
      } else {
        console.log(
          '[ChatArea] ❌ Team from localStorage not found in teams list, ID:',
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
  }, [teams, hasRestoredPreferences]);

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

  const handleTeamChange = (team: Team | null) => {
    console.log('[ChatArea] handleTeamChange called:', team?.name || 'null', team?.id || 'null');
    setSelectedTeam(team);

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
    const { error, newTask } = await sendMessage({
      message: taskInputMessage,
      team: selectedTeam,
      repo: showRepositorySelector ? selectedRepo : null,
      branch: showRepositorySelector ? selectedBranch : null,
      task_id: selectedTaskDetail?.id,
      taskType: taskType,
    });
    if (error) {
      message.error(error);
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
  }, [selectedTaskDetail?.id]);

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
        <div className="w-full max-w-3xl mx-auto px-4 sm:px-6">
          <MessagesArea
            selectedTeam={selectedTeam}
            selectedRepo={selectedRepo}
            selectedBranch={selectedBranch}
          />
        </div>
      </div>

      {/* Main Content Area */}
      <div
        className={
          hasMessages ? 'w-full' : 'flex-1 flex flex-col items-center justify-center w-full'
        }
      >
        {/* Floating Input Area */}
        <div
          ref={floatingInputRef}
          className={
            hasMessages
              ? 'fixed bottom-0 z-10 bg-gradient-to-t from-base via-base/95 to-base/0'
              : 'w-full max-w-3xl px-4 sm:px-6'
          }
          style={
            hasMessages
              ? {
                  left: floatingMetrics.width ? floatingMetrics.left : 0,
                  width: floatingMetrics.width || '100%',
                  right: floatingMetrics.width ? undefined : 0,
                }
              : {}
          }
        >
          <div className={hasMessages ? 'w-full max-w-3xl mx-auto px-4 sm:px-6 py-4' : 'w-full'}>
            {/* Chat Input Card */}
            <div className="relative w-full flex flex-col rounded-xl border border-border bg-surface shadow-lg">
              <ChatInput
                message={taskInputMessage}
                setMessage={setTaskInputMessage}
                handleSendMessage={handleSendMessage}
                isLoading={isLoading}
                taskType={taskType}
              />
              {/* Team Selector and Send Button */}
              <div className="flex items-end justify-between px-3 py-0">
                <div>
                  {teams.length > 0 && (
                    <TeamSelector
                      selectedTeam={selectedTeam}
                      setSelectedTeam={handleTeamChange}
                      teams={teams}
                      disabled={hasMessages}
                      isLoading={isTeamsLoading}
                    />
                  )}
                </div>
                <div className="ml-auto flex items-center">
                  {!shouldHideQuotaUsage && <QuotaUsage className="mr-2" />}
                  <Button
                    type="text"
                    onClick={handleSendMessage}
                    disabled={
                      isLoading ||
                      selectedTaskDetail?.status === 'PENDING' ||
                      selectedTaskDetail?.status === 'RUNNING'
                    }
                    icon={
                      isLoading ||
                      selectedTaskDetail?.status === 'PENDING' ||
                      selectedTaskDetail?.status === 'RUNNING' ? (
                        <LoadingDots />
                      ) : (
                        <PaperAirplaneIcon className="w-4 h-4" />
                      )
                    }
                    style={{
                      color: 'rgb(var(--color-text-muted))',
                      padding: '0',
                      height: 'auto',
                    }}
                  />
                </div>
              </div>
            </div>

            {/* Bottom Controls */}
            <div className="flex flex-row gap-1 mb-2 ml-3 mt-1 items-center flex-wrap">
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
    </div>
  );
}
