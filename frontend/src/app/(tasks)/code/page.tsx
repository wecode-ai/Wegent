// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client';

import { Suspense, useState, useEffect, useMemo, useCallback } from 'react';
import { useSearchParams, useRouter } from 'next/navigation';
import { teamService } from '@/features/tasks/service/teamService';
import TopNavigation from '@/features/layout/TopNavigation';
import {
  TaskSidebar,
  ResizableSidebar,
  CollapsedSidebarButtons,
  SearchDialog,
} from '@/features/tasks/components/sidebar';
import OnboardingTour from '@/features/onboarding/OnboardingTour';
import { TaskParamSync } from '@/features/tasks/components/params';
import { TeamShareHandler } from '@/features/tasks/components/share';
import OidcTokenHandler from '@/features/login/components/OidcTokenHandler';
import WorkbenchToggle from '@/features/layout/WorkbenchToggle';
import { OpenMenu } from '@/features/tasks/components/input';
import '@/app/tasks/tasks.css';
import '@/features/common/scrollbar.css';
import { GithubStarButton } from '@/features/layout/GithubStarButton';
import { ThemeToggle } from '@/features/theme/ThemeToggle';
import { Team, WorkbenchData } from '@/types/api';
import { useTaskContext } from '@/features/tasks/contexts/taskContext';
import { useChatStreamContext } from '@/features/tasks/contexts/chatStreamContext';
import { saveLastTab } from '@/utils/userPreferences';
import { useIsMobile } from '@/features/layout/hooks/useMediaQuery';
import { calculateOpenLinks } from '@/utils/openLinks';
import { useUser } from '@/features/common/UserContext';
import { paths } from '@/config/paths';
import { useSearchShortcut } from '@/features/tasks/hooks/useSearchShortcut';
import { Workbench } from '@/features/tasks/components';
import { ChatArea } from '@/features/tasks/components/chat';

export default function CodePage() {
  // Get search params to check for taskId
  const searchParams = useSearchParams();
  const taskId = searchParams.get('taskId');
  const hasTaskId = !!taskId;
  const hasShareId = !!searchParams.get('share_id');

  // Team state from service
  const { teams, isTeamsLoading, refreshTeams } = teamService.useTeams();

  // Task context for workbench data
  const { selectedTaskDetail, setSelectedTask, refreshTasks, refreshSelectedTaskDetail } =
    useTaskContext();

  // Chat stream context for real-time workbench and thinking data
  const { getStreamState, clearAllStreams } = useChatStreamContext();

  // Get current task title for top navigation
  const currentTaskTitle = selectedTaskDetail?.title;

  // Handle task deletion
  const handleTaskDeleted = () => {
    setSelectedTask(null);
    refreshTasks();
  };

  // Handle members changed (when converting to group chat or adding/removing members)
  const handleMembersChanged = () => {
    refreshTasks();
    refreshSelectedTaskDetail(false);
  };

  // Router for navigation
  const router = useRouter();

  // User state for git token check
  const { user } = useUser();

  // Mobile sidebar state
  const [isMobileSidebarOpen, setIsMobileSidebarOpen] = useState(false);

  // Collapsed sidebar state
  const [isCollapsed, setIsCollapsed] = useState(false);

  // Selected team state for sharing
  const [selectedTeamForNewTask, setSelectedTeamForNewTask] = useState<Team | null>(null);

  // Share button state
  const [shareButton, setShareButton] = useState<React.ReactNode>(null);

  const handleShareButtonRender = (button: React.ReactNode) => {
    setShareButton(button);
  };

  // Workbench state - default to true when taskId exists
  const [isWorkbenchOpen, setIsWorkbenchOpen] = useState(true);

  // Search dialog state (controlled from page level for global shortcut support)
  const [isSearchDialogOpen, setIsSearchDialogOpen] = useState(false);

  // Toggle search dialog callback
  const toggleSearchDialog = useCallback(() => {
    setIsSearchDialogOpen(prev => !prev);
  }, []);

  // Global search shortcut hook
  const { shortcutDisplayText } = useSearchShortcut({
    onToggle: toggleSearchDialog,
  });

  // Mobile detection
  const isMobile = useIsMobile();

  // Check if user has git token
  const hasGitToken = !!(user?.git_info && user.git_info.length > 0);

  // Load collapsed state from localStorage
  useEffect(() => {
    const savedCollapsed = localStorage.getItem('task-sidebar-collapsed');
    if (savedCollapsed === 'true') {
      setIsCollapsed(true);
    }
  }, []);

  // Auto-open workbench when taskId is present
  useEffect(() => {
    if (hasTaskId) {
      setIsWorkbenchOpen(true);
    }
  }, [hasTaskId]);

  // Calculate open links from task detail
  const openLinks = useMemo(() => {
    return calculateOpenLinks(selectedTaskDetail);
  }, [selectedTaskDetail]);

  // Type for thinking data
  type ThinkingStep = {
    title: string;
    next_action: string;
    details?: Record<string, unknown>;
  };

  // Get real-time thinking and workbench data from stream state
  // Priority: stream state (real-time) > selectedTaskDetail (API polling)
  const { thinkingData, workbenchData } = useMemo(() => {
    const currentTaskId = selectedTaskDetail?.id;
    const streamState = currentTaskId ? getStreamState(currentTaskId) : undefined;

    // Try to get data from stream state first (real-time updates via WebSocket)
    if (streamState?.messages && streamState.messages.size > 0) {
      // Find the latest AI message with result data (iterate in reverse order to get the newest)
      // Priority: streaming message > completed message with result
      let latestAiMessageWithResult: {
        thinking: ThinkingStep[] | null;
        workbench: WorkbenchData | null;
      } | null = null;

      for (const msg of streamState.messages.values()) {
        if (msg.type === 'ai') {
          // For streaming messages, always use their result (real-time updates)
          if (msg.status === 'streaming' && msg.result) {
            const result = msg.result as { thinking?: unknown[]; workbench?: WorkbenchData };
            const thinking =
              result.thinking && Array.isArray(result.thinking)
                ? (result.thinking as ThinkingStep[])
                : null;
            const workbench = result.workbench || null;
            // Streaming message takes highest priority, return immediately
            return {
              thinkingData: thinking,
              workbenchData: workbench || selectedTaskDetail?.workbench || null,
            };
          }
          // For completed messages, keep track of the latest one with result
          if (msg.result) {
            const result = msg.result as { thinking?: unknown[]; workbench?: WorkbenchData };
            const thinking =
              result.thinking && Array.isArray(result.thinking)
                ? (result.thinking as ThinkingStep[])
                : null;
            const workbench = result.workbench || null;
            latestAiMessageWithResult = { thinking, workbench };
          }
        }
      }

      // If we found a completed AI message with result, use it
      if (latestAiMessageWithResult) {
        return {
          thinkingData: latestAiMessageWithResult.thinking,
          workbenchData:
            latestAiMessageWithResult.workbench || selectedTaskDetail?.workbench || null,
        };
      }
    }

    // Fallback to selectedTaskDetail (API polling data)
    if (selectedTaskDetail?.subtasks && selectedTaskDetail.subtasks.length > 0) {
      const latestSubtask = selectedTaskDetail.subtasks[selectedTaskDetail.subtasks.length - 1];
      if (latestSubtask?.result && typeof latestSubtask.result === 'object') {
        const result = latestSubtask.result as { thinking?: unknown[] };
        const thinking =
          result.thinking && Array.isArray(result.thinking)
            ? (result.thinking as ThinkingStep[])
            : null;
        return { thinkingData: thinking, workbenchData: selectedTaskDetail?.workbench || null };
      }
    }

    return { thinkingData: null, workbenchData: selectedTaskDetail?.workbench || null };
  }, [selectedTaskDetail, getStreamState]);

  // Save last active tab to localStorage
  useEffect(() => {
    saveLastTab('code');
  }, []);

  const handleRefreshTeams = async (): Promise<Team[]> => {
    return await refreshTeams();
  };

  const handleToggleCollapsed = () => {
    setIsCollapsed(prev => {
      const newValue = !prev;
      localStorage.setItem('task-sidebar-collapsed', String(newValue));
      return newValue;
    });
  };

  // Handle new task from collapsed sidebar button
  const handleNewTask = () => {
    // IMPORTANT: Clear selected task FIRST to ensure UI state is reset immediately
    // This prevents the UI from being stuck showing the previous task's messages
    setSelectedTask(null);
    clearAllStreams();
    router.replace(paths.code.getHref());
  };

  return (
    <>
      {/* Handle OIDC token from URL parameters */}
      <OidcTokenHandler />
      <Suspense>
        <TaskParamSync />
      </Suspense>
      <Suspense>
        <TeamShareHandler
          teams={teams}
          onTeamSelected={setSelectedTeamForNewTask}
          onRefreshTeams={handleRefreshTeams}
        />
      </Suspense>
      {/* Onboarding tour */}
      <OnboardingTour
        hasTeams={teams.length > 0}
        hasGitToken={hasGitToken}
        currentPage="code"
        isLoading={isTeamsLoading}
        hasShareId={hasShareId}
      />
      <div className="flex smart-h-screen bg-base text-text-primary box-border">
        {/* Collapsed sidebar floating buttons */}
        {isCollapsed && !isMobile && (
          <CollapsedSidebarButtons onExpand={handleToggleCollapsed} onNewTask={handleNewTask} />
        )}
        {/* Responsive resizable sidebar - fixed, not affected by right panel */}
        <ResizableSidebar isCollapsed={isCollapsed} onToggleCollapsed={handleToggleCollapsed}>
          <TaskSidebar
            isMobileSidebarOpen={isMobileSidebarOpen}
            setIsMobileSidebarOpen={setIsMobileSidebarOpen}
            pageType="code"
            isCollapsed={isCollapsed}
            onToggleCollapsed={handleToggleCollapsed}
            isSearchDialogOpen={isSearchDialogOpen}
            onSearchDialogOpenChange={setIsSearchDialogOpen}
            shortcutDisplayText={shortcutDisplayText}
          />
        </ResizableSidebar>
        {/* Main content area with right panel*/}
        <div className="flex-1 flex flex-col min-w-0">
          {/* Top navigation - fixed, not affected by right panel*/}
          <TopNavigation
            activePage="code"
            variant="with-sidebar"
            title={currentTaskTitle}
            taskDetail={selectedTaskDetail}
            onMobileSidebarToggle={() => setIsMobileSidebarOpen(true)}
            onTaskDeleted={handleTaskDeleted}
            onMembersChanged={handleMembersChanged}
            isSidebarCollapsed={isCollapsed}
          >
            {shareButton}
            {isMobile ? <ThemeToggle /> : <GithubStarButton />}
            {hasTaskId && <OpenMenu openLinks={openLinks} />}
            {hasTaskId && (
              <WorkbenchToggle
                isOpen={isWorkbenchOpen}
                onOpen={() => setIsWorkbenchOpen(true)}
                onClose={() => setIsWorkbenchOpen(false)}
              />
            )}
          </TopNavigation>
          {/* Content area with split layout */}
          {/* Content area with split layout */}
          <div className="flex flex-1 min-h-0">
            {/* Chat area - affected by workbench */}
            <div
              className="transition-all duration-300 ease-in-out flex flex-col min-h-0"
              style={{
                width: hasTaskId && isWorkbenchOpen && !isMobile ? '60%' : '100%',
              }}
            >
              <ChatArea
                teams={teams}
                isTeamsLoading={isTeamsLoading}
                selectedTeamForNewTask={selectedTeamForNewTask}
                taskType="code"
                onShareButtonRender={handleShareButtonRender}
              />
            </div>

            {/* Workbench component - only show if there's a taskId and not on mobile */}
            {hasTaskId && !isMobile && (
              <Workbench
                isOpen={isWorkbenchOpen}
                onClose={() => setIsWorkbenchOpen(false)}
                onOpen={() => setIsWorkbenchOpen(true)}
                workbenchData={workbenchData}
                isLoading={
                  hasTaskId &&
                  !workbenchData &&
                  selectedTaskDetail?.status !== 'COMPLETED' &&
                  selectedTaskDetail?.status !== 'FAILED' &&
                  selectedTaskDetail?.status !== 'CANCELLED'
                }
                taskTitle={selectedTaskDetail?.title}
                taskNumber={selectedTaskDetail ? `#${selectedTaskDetail.id}` : undefined}
                thinking={thinkingData}
              />
            )}
          </div>
        </div>
      </div>
      {/* Search Dialog - rendered at page level for global shortcut support */}
      <SearchDialog
        open={isSearchDialogOpen}
        onOpenChange={setIsSearchDialogOpen}
        shortcutDisplayText={shortcutDisplayText}
        pageType="code"
      />
    </>
  );
}
