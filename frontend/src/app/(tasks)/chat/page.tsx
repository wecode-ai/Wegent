// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client';

import { Suspense, useState, useEffect, useCallback } from 'react';
import { useSearchParams, useRouter } from 'next/navigation';
import { UserGroupIcon } from '@heroicons/react/24/outline';
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
import { TeamShareHandler, TaskShareHandler } from '@/features/tasks/components/share';
import { InviteJoinHandler, CreateGroupChatDialog } from '@/features/tasks/components/group-chat';
import OidcTokenHandler from '@/features/login/components/OidcTokenHandler';
import '@/app/tasks/tasks.css';
import '@/features/common/scrollbar.css';
import { GithubStarButton } from '@/features/layout/GithubStarButton';
import { ThemeToggle } from '@/features/theme/ThemeToggle';
import { useIsMobile } from '@/features/layout/hooks/useMediaQuery';
import { Team } from '@/types/api';
import { saveLastTab } from '@/utils/userPreferences';
import { useUser } from '@/features/common/UserContext';
import { useTaskContext } from '@/features/tasks/contexts/taskContext';
import { useChatStreamContext } from '@/features/tasks/contexts/chatStreamContext';
import { paths } from '@/config/paths';
import { Button } from '@/components/ui/button';
import { useTranslation } from '@/hooks/useTranslation';
import { useSearchShortcut } from '@/features/tasks/hooks/useSearchShortcut';
import { ChatArea } from '@/features/tasks/components/chat';

export default function ChatPage() {
  const { t } = useTranslation();

  // Team state from service
  const { teams, isTeamsLoading, refreshTeams } = teamService.useTeams();

  // Task context for refreshing task list
  const { refreshTasks, selectedTaskDetail, setSelectedTask, refreshSelectedTaskDetail } =
    useTaskContext();

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

  // Chat stream context
  const { clearAllStreams } = useChatStreamContext();

  // User state for git token check
  const { user } = useUser();

  // Router for navigation
  const router = useRouter();

  // Check for share_id in URL
  const searchParams = useSearchParams();
  const hasShareId = !!searchParams.get('share_id');

  // Check if a task is currently open (support multiple parameter formats)
  const taskId =
    searchParams.get('task_id') || searchParams.get('taskid') || searchParams.get('taskId');
  const hasOpenTask = !!taskId;

  // Check for pending task share from public page (after login)
  useEffect(() => {
    const pendingToken = localStorage.getItem('pendingTaskShare');
    if (pendingToken) {
      // Clear the pending token
      localStorage.removeItem('pendingTaskShare');
      // Redirect to chat page with taskShare parameter to trigger the copy modal
      router.push(`/chat?taskShare=${pendingToken}`);
    }
  }, [router]);

  // Mobile detection
  const isMobile = useIsMobile();

  // Mobile sidebar state
  const [isMobileSidebarOpen, setIsMobileSidebarOpen] = useState(false);

  // Collapsed sidebar state
  const [isCollapsed, setIsCollapsed] = useState(false);

  // Selected team state for sharing
  const [selectedTeamForNewTask, setSelectedTeamForNewTask] = useState<Team | null>(null);

  // Share button state
  const [shareButton, setShareButton] = useState<React.ReactNode>(null);

  // Create group chat dialog state
  const [isCreateGroupChatOpen, setIsCreateGroupChatOpen] = useState(false);

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

  const handleShareButtonRender = (button: React.ReactNode) => {
    setShareButton(button);
  };

  // Check if user has git token
  const hasGitToken = !!(user?.git_info && user.git_info.length > 0);

  // Load collapsed state from localStorage
  useEffect(() => {
    const savedCollapsed = localStorage.getItem('task-sidebar-collapsed');
    if (savedCollapsed === 'true') {
      setIsCollapsed(true);
    }
  }, []);

  // Save last active tab to localStorage
  useEffect(() => {
    saveLastTab('chat');
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
    router.replace(paths.chat.getHref());
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
      <Suspense>
        <TaskShareHandler onTaskCopied={refreshTasks} />
      </Suspense>
      {/* Handle group chat invite links */}
      <Suspense>
        <InviteJoinHandler />
      </Suspense>
      {/* Onboarding tour */}
      <OnboardingTour
        hasTeams={teams.length > 0}
        hasGitToken={hasGitToken}
        currentPage="chat"
        isLoading={isTeamsLoading}
        hasShareId={hasShareId}
      />
      <div className="flex smart-h-screen bg-base text-text-primary box-border">
        {/* Collapsed sidebar floating buttons */}
        {isCollapsed && !isMobile && (
          <CollapsedSidebarButtons onExpand={handleToggleCollapsed} onNewTask={handleNewTask} />
        )}
        {/* Responsive resizable sidebar */}
        <ResizableSidebar isCollapsed={isCollapsed} onToggleCollapsed={handleToggleCollapsed}>
          <TaskSidebar
            isMobileSidebarOpen={isMobileSidebarOpen}
            setIsMobileSidebarOpen={setIsMobileSidebarOpen}
            pageType="chat"
            isCollapsed={isCollapsed}
            onToggleCollapsed={handleToggleCollapsed}
            isSearchDialogOpen={isSearchDialogOpen}
            onSearchDialogOpenChange={setIsSearchDialogOpen}
            shortcutDisplayText={shortcutDisplayText}
          />
        </ResizableSidebar>
        {/* Main content area */}
        <div className="flex-1 flex flex-col min-w-0">
          {/* Top navigation */}
          <TopNavigation
            activePage="chat"
            variant="with-sidebar"
            title={currentTaskTitle}
            taskDetail={selectedTaskDetail}
            onMobileSidebarToggle={() => setIsMobileSidebarOpen(true)}
            onTaskDeleted={handleTaskDeleted}
            onMembersChanged={handleMembersChanged}
            isSidebarCollapsed={isCollapsed}
          >
            {/* Create Group Chat Button - only show when no task is open */}
            {!hasOpenTask && (
              <Button
                variant="outline"
                size="sm"
                onClick={() => setIsCreateGroupChatOpen(true)}
                className="gap-1 h-8 pl-2 pr-3 rounded-[7px] text-sm"
              >
                <UserGroupIcon className="h-3.5 w-3.5" />
                <span className="hidden sm:inline">{t('groupChat.create.button')}</span>
              </Button>
            )}
            {shareButton}
            {isMobile ? <ThemeToggle /> : <GithubStarButton />}
          </TopNavigation>
          {/* Chat area without repository selector */}
          <ChatArea
            teams={teams}
            isTeamsLoading={isTeamsLoading}
            selectedTeamForNewTask={selectedTeamForNewTask}
            showRepositorySelector={false}
            taskType="chat"
            onShareButtonRender={handleShareButtonRender}
            onRefreshTeams={handleRefreshTeams}
          />
        </div>
      </div>
      {/* Create Group Chat Dialog */}
      <CreateGroupChatDialog open={isCreateGroupChatOpen} onOpenChange={setIsCreateGroupChatOpen} />
      {/* Search Dialog - rendered at page level for global shortcut support */}
      <SearchDialog
        open={isSearchDialogOpen}
        onOpenChange={setIsSearchDialogOpen}
        shortcutDisplayText={shortcutDisplayText}
        pageType="chat"
      />
    </>
  );
}
