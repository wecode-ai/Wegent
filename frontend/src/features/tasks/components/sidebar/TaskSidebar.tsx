// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client';

import './task-list-scrollbar.css';
import React, { useRef, useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import Image from 'next/image';
import { useRouter } from 'next/navigation';
import { paths } from '@/config/paths';
import {
  Search,
  Plus,
  X,
  PanelLeftClose,
  PanelLeftOpen,
  Code,
  BookOpen,
  ChevronDown,
  ChevronUp,
} from 'lucide-react';
import { useTaskContext } from '@/features/tasks/contexts/taskContext';
import { useChatStreamContext } from '@/features/tasks/contexts/chatStreamContext';
import TaskListSection from './TaskListSection';
import { useTranslation } from '@/hooks/useTranslation';
import { isTaskUnread } from '@/utils/taskViewStatus';
import MobileSidebar from '@/features/layout/MobileSidebar';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { UserFloatingMenu } from '@/features/layout/components/UserFloatingMenu';

interface TaskSidebarProps {
  isMobileSidebarOpen: boolean;
  setIsMobileSidebarOpen: (open: boolean) => void;
  pageType?: 'chat' | 'code' | 'knowledge';
  isCollapsed?: boolean;
  onToggleCollapsed?: () => void;
  // Search dialog control from parent (for global shortcut support)
  isSearchDialogOpen?: boolean;
  onSearchDialogOpenChange?: (open: boolean) => void;
  shortcutDisplayText?: string;
}

export default function TaskSidebar({
  isMobileSidebarOpen,
  setIsMobileSidebarOpen,
  pageType = 'chat',
  isCollapsed = false,
  onToggleCollapsed,
  isSearchDialogOpen: _externalIsSearchDialogOpen,
  onSearchDialogOpenChange,
  shortcutDisplayText: externalShortcutDisplayText,
}: TaskSidebarProps) {
  const { t } = useTranslation('common');
  const router = useRouter();
  const { clearAllStreams } = useChatStreamContext();
  const {
    tasks,
    loadMore,
    loadingMore,
    searchTerm: _searchTerm,
    setSearchTerm,
    searchTasks,
    isSearching,
    isSearchResult,
    getUnreadCount,
    markAllTasksAsViewed,
    viewStatusVersion,
    setSelectedTask,
  } = useTaskContext();
  const scrollRef = useRef<HTMLDivElement>(null);

  // Use external state for search dialog (controlled by parent page)
  const setIsSearchDialogOpen = onSearchDialogOpenChange ?? (() => {});

  // Group chats collapse/expand state
  const [isGroupChatsExpanded, setIsGroupChatsExpanded] = useState(false);
  const maxVisibleGroupChats = 5;

  // Use external shortcut display text from parent
  const shortcutDisplayText = externalShortcutDisplayText ?? '';

  // Clear search for sidebar (used when clearing search results)
  const handleClearSearch = () => {
    setSearchTerm('');
    searchTasks('');
  };

  // Open search dialog (controlled by parent)
  const handleOpenSearchDialog = () => {
    setIsSearchDialogOpen(true);
  };

  // Navigation buttons - always show all buttons
  const navigationButtons = [
    {
      label: t('navigation.code'),
      icon: Code,
      path: paths.code.getHref(),
      isActive: pageType === 'code',
      tooltip: pageType === 'code' ? t('tasks.new_task') : undefined,
    },
    {
      label: t('navigation.wiki'),
      icon: BookOpen,
      path: paths.wiki.getHref(),
      isActive: pageType === 'knowledge',
    },
  ];

  // New conversation - always navigate to chat page
  const handleNewAgentClick = () => {
    // IMPORTANT: Clear selected task FIRST to ensure UI state is reset immediately
    // This prevents the UI from being stuck showing the previous task's messages
    setSelectedTask(null);

    // Clear all stream states to reset the chat area to initial state
    clearAllStreams();

    if (typeof window !== 'undefined') {
      // Always navigate to chat page for new conversation
      router.replace(paths.chat.getHref());
    }
    // Close mobile sidebar after navigation
    setIsMobileSidebarOpen(false);
  };

  // Handle navigation button click - for code mode, clear streams to create new task
  const handleNavigationClick = (path: string, isActive: boolean) => {
    if (isActive) {
      // IMPORTANT: Clear selected task FIRST to ensure UI state is reset immediately
      setSelectedTask(null);

      // If already on this page, clear streams to create new task
      clearAllStreams();
      router.replace(path);
    } else {
      router.push(path);
    }
    setIsMobileSidebarOpen(false);
  };

  // Mark all tasks as viewed
  const handleMarkAllAsViewed = () => {
    markAllTasksAsViewed();
  };

  // Calculate total unread count
  // Include viewStatusVersion in dependencies to recalculate when view status changes
  const totalUnreadCount = React.useMemo(() => {
    return getUnreadCount(tasks);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tasks, getUnreadCount, viewStatusVersion]);

  // Scroll to bottom to load more
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const handleScroll = () => {
      if (el.scrollTop + el.clientHeight >= el.scrollHeight - 10) {
        loadMore();
      }
    };
    el.addEventListener('scroll', handleScroll);
    return () => el.removeEventListener('scroll', handleScroll);
  }, [loadMore]);

  const sidebarContent = (
    <>
      {/* Logo and Mode Indicator - matches Figma: left-[20px] top-[12px] */}
      <div className={`${isCollapsed ? 'px-2' : 'px-5'} pt-3 pb-4`}>
        {isCollapsed ? (
          /* Collapsed mode: Combined button with expand and add icons - matches Figma */
          <TooltipProvider>
            <Tooltip delayDuration={300}>
              <TooltipTrigger asChild>
                <div
                  className="flex items-center gap-3 px-4 py-2.5 rounded-3xl border border-border bg-base shadow-sm cursor-pointer hover:bg-hover transition-colors"
                  onClick={onToggleCollapsed}
                >
                  <PanelLeftOpen className="h-4 w-4 text-text-primary flex-shrink-0" />
                  <button
                    onClick={e => {
                      e.stopPropagation();
                      handleNewAgentClick();
                    }}
                    className="flex-shrink-0"
                    aria-label={t('tasks.new_conversation')}
                  >
                    <Plus className="h-4 w-4 text-text-primary" />
                  </button>
                </div>
              </TooltipTrigger>
              <TooltipContent side="right">
                <p>{t('sidebar.expand')}</p>
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
        ) : (
          /* Expanded mode: Logo and collapse button */
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <Image
                src="/weibo-logo.png"
                alt="Weibo Logo"
                width={24}
                height={23}
                className="object-container"
              />
              <span className="text-sm font-medium text-text-primary">Wegent</span>
            </div>
            {onToggleCollapsed && (
              <TooltipProvider>
                <Tooltip delayDuration={300}>
                  <TooltipTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={onToggleCollapsed}
                      className="h-8 w-8 p-0 text-text-muted hover:text-text-primary hover:bg-hover rounded-lg"
                      aria-label={t('sidebar.collapse')}
                    >
                      <PanelLeftClose className="h-4 w-4" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent side="right">
                    <p>{t('sidebar.collapse')}</p>
                  </TooltipContent>
                </Tooltip>
              </TooltipProvider>
            )}
          </div>
        )}
      </div>

      {/* New Conversation Button and Navigation Buttons - wrapped together for onboarding tour */}
      <div data-tour="mode-toggle" className="px-2.5">
        {/* New Conversation Button - only show in expanded mode, collapsed mode has it in the top combined button */}
        {!isCollapsed && (
          <div className="mb-1">
            <Button
              variant="ghost"
              onClick={handleNewAgentClick}
              className="w-full justify-between px-3 h-9 text-sm text-text-primary hover:bg-hover rounded-md group"
              size="sm"
            >
              <span className="flex items-center">
                <Plus className="h-4 w-4 flex-shrink-0" />
                <span className="ml-1.5">{t('tasks.new_conversation')}</span>
              </span>
              <span className="text-text-muted opacity-0 group-hover:opacity-100 transition-opacity">
                ›
              </span>
            </Button>
          </div>
        )}

        {/* Navigation Buttons - matches Figma: spacing and style */}
        {!isCollapsed && navigationButtons.length > 0 && (
          <div className="space-y-0.5">
            {navigationButtons.map(btn => (
              <div key={btn.path} className="relative group">
                <Button
                  variant="ghost"
                  onClick={() => handleNavigationClick(btn.path, btn.isActive)}
                  className={`w-full justify-start px-3 h-9 text-sm rounded-md transition-colors ${
                    btn.isActive
                      ? 'bg-primary/10 text-primary font-medium'
                      : 'text-text-primary hover:bg-hover'
                  }`}
                  size="sm"
                >
                  <span className="flex items-center">
                    <btn.icon
                      className={`h-4 w-4 flex-shrink-0 ${btn.isActive ? 'text-primary' : ''}`}
                    />
                    <span className="ml-1.5">{btn.label}</span>
                  </span>
                </Button>
                {/* Show "New Task" button on hover when in code mode */}
                {btn.isActive && btn.tooltip && (
                  <div className="absolute right-1 top-1/2 -translate-y-1/2 opacity-0 group-hover:opacity-100 transition-opacity duration-200">
                    <TooltipProvider>
                      <Tooltip delayDuration={0}>
                        <TooltipTrigger asChild>
                          <button
                            onClick={e => {
                              e.stopPropagation();
                              handleNavigationClick(btn.path, btn.isActive);
                            }}
                            className="flex items-center gap-1 px-1.5 py-0.5 text-xs bg-primary text-white rounded-md hover:bg-primary/90 transition-colors"
                          >
                            <Plus className="h-3 w-3" />
                            <span>{t('tasks.new_task')}</span>
                          </button>
                        </TooltipTrigger>
                        <TooltipContent side="right">
                          <p>{btn.tooltip}</p>
                        </TooltipContent>
                      </Tooltip>
                    </TooltipProvider>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Tasks Section - matches Figma: left-[20px] top-[198px] with border */}
      <div
        className={`flex-1 ${isCollapsed ? 'px-0' : 'px-2.5'} pt-4 overflow-y-auto task-list-scrollbar border-t border-border mt-3`}
        ref={scrollRef}
      >
        {/* Search Result Header */}
        {!isCollapsed && isSearchResult && (
          <div className="px-1 pb-2 flex items-center justify-between">
            <span className="text-xs font-medium text-text-muted">{t('tasks.search_results')}</span>
            <button
              onClick={handleClearSearch}
              className="flex items-center gap-1 text-xs text-text-muted hover:text-text-primary transition-colors"
            >
              <X className="h-3 w-3" />
              {t('tasks.clear_search')}
            </button>
          </div>
        )}
        {/* Search Button for collapsed mode - removed, search is now in the combined top button */}
        {isSearching ? (
          <div className="text-center py-8 text-xs text-text-muted">{t('tasks.searching')}</div>
        ) : tasks.length === 0 ? (
          <div className="text-center py-8 text-xs text-text-muted">
            {isSearchResult ? t('tasks.no_search_results') : t('tasks.no_tasks')}
          </div>
        ) : (
          (() => {
            // Separate group chats and regular tasks
            const allGroupChats = tasks
              .filter(task => task.is_group_chat)
              .sort((a, b) => new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime());
            const regularTasks = tasks
              .filter(task => !task.is_group_chat)
              .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());

            // Separate unread and read group chats, both sorted by updated_at desc
            const unreadGroupChats = allGroupChats.filter(isTaskUnread);
            const readGroupChats = allGroupChats.filter(task => !isTaskUnread(task));

            // Merge: unread first, then read
            const orderedGroupChats = [...unreadGroupChats, ...readGroupChats];

            // Calculate visible group chats based on collapse state
            let visibleGroupChats: typeof orderedGroupChats;
            if (isSearchResult) {
              // Search mode: show all
              visibleGroupChats = orderedGroupChats;
            } else if (unreadGroupChats.length === 0) {
              // No unread: show max 5 or all if expanded
              visibleGroupChats = isGroupChatsExpanded
                ? orderedGroupChats
                : orderedGroupChats.slice(0, maxVisibleGroupChats);
            } else {
              // Has unread: always show all unread + remaining slots for read
              const remainingSlots = maxVisibleGroupChats - unreadGroupChats.length;
              visibleGroupChats = isGroupChatsExpanded
                ? orderedGroupChats
                : [...unreadGroupChats, ...readGroupChats.slice(0, Math.max(0, remainingSlots))];
            }

            // Calculate how many read chats are collapsed (for display text)
            const collapsedReadCount =
              readGroupChats.length - (visibleGroupChats.length - unreadGroupChats.length);

            // Determine if expand/collapse button should be shown
            // Button should show when there are more read chats than can fit after showing all unread chats
            const maxReadSlotsWhenCollapsed = Math.max(
              0,
              maxVisibleGroupChats - unreadGroupChats.length
            );
            const shouldShowExpandCollapseButton =
              readGroupChats.length > maxReadSlotsWhenCollapsed;

            return (
              <>
                {/* Group Chats Section */}
                {allGroupChats.length > 0 && (
                  <>
                    {!isCollapsed && (
                      <div className="px-1 pb-1 text-xs font-medium text-text-muted">
                        {t('tasks.group_chats')}
                      </div>
                    )}
                    <TaskListSection
                      tasks={visibleGroupChats}
                      title=""
                      unreadCount={getUnreadCount(visibleGroupChats)}
                      onTaskClick={() => setIsMobileSidebarOpen(false)}
                      isCollapsed={isCollapsed}
                      showTitle={false}
                      key={`group-chats-${viewStatusVersion}`}
                    />
                    {/* Expand/Collapse button for group chats */}
                    {!isSearchResult && shouldShowExpandCollapseButton && !isCollapsed && (
                      <button
                        onClick={() => setIsGroupChatsExpanded(!isGroupChatsExpanded)}
                        className="flex items-center gap-1 px-1 py-1.5 text-xs text-text-muted hover:text-text-primary transition-colors w-full"
                      >
                        {isGroupChatsExpanded ? (
                          <>
                            <ChevronUp className="h-3.5 w-3.5" />
                            <span>{t('tasks.group_chats_collapse')}</span>
                          </>
                        ) : (
                          <>
                            <ChevronDown className="h-3.5 w-3.5" />
                            <span>
                              {t('tasks.group_chats_expand', { count: collapsedReadCount })}
                            </span>
                          </>
                        )}
                      </button>
                    )}
                    {/* Collapsed mode: show icon + tooltip for expand/collapse */}
                    {!isSearchResult && shouldShowExpandCollapseButton && isCollapsed && (
                      <TooltipProvider>
                        <Tooltip delayDuration={300}>
                          <TooltipTrigger asChild>
                            <button
                              onClick={() => setIsGroupChatsExpanded(!isGroupChatsExpanded)}
                              className="flex items-center justify-center w-full py-1.5 text-text-muted hover:text-text-primary transition-colors"
                            >
                              {isGroupChatsExpanded ? (
                                <ChevronUp className="h-3.5 w-3.5" />
                              ) : (
                                <ChevronDown className="h-3.5 w-3.5" />
                              )}
                            </button>
                          </TooltipTrigger>
                          <TooltipContent side="right">
                            <p>
                              {isGroupChatsExpanded
                                ? t('tasks.group_chats_collapse')
                                : t('tasks.group_chats_expand', { count: collapsedReadCount })}
                            </p>
                          </TooltipContent>
                        </Tooltip>
                      </TooltipProvider>
                    )}
                  </>
                )}
                {/* History Section - with search button next to title */}
                {regularTasks.length > 0 && (
                  <>
                    {!isCollapsed && (
                      <div
                        className={`px-1 pb-1 text-xs font-medium text-text-muted flex items-center justify-between ${allGroupChats.length > 0 ? 'pt-3 mt-2 border-t border-border' : ''}`}
                      >
                        <div className="flex items-center gap-1">
                          <span>{t('tasks.history_title')}</span>
                          <TooltipProvider>
                            <Tooltip delayDuration={300}>
                              <TooltipTrigger asChild>
                                <button
                                  onClick={handleOpenSearchDialog}
                                  className="p-0.5 text-text-muted hover:text-text-primary transition-colors rounded"
                                  aria-label={t('tasks.search_placeholder_chat')}
                                >
                                  <Search className="h-3.5 w-3.5" />
                                </button>
                              </TooltipTrigger>
                              <TooltipContent side="right">
                                <p>
                                  {shortcutDisplayText
                                    ? t('tasks.search_hint_with_shortcut', {
                                        shortcut: shortcutDisplayText,
                                      })
                                    : t('tasks.search_placeholder_chat')}
                                </p>
                              </TooltipContent>
                            </Tooltip>
                          </TooltipProvider>
                        </div>
                        {/* Mark All As Read Button - show only when there are unread tasks */}
                        {totalUnreadCount > 0 && (
                          <button
                            onClick={handleMarkAllAsViewed}
                            className="text-xs text-text-muted hover:text-text-primary transition-colors"
                          >
                            {t('tasks.mark_all_read')} ({totalUnreadCount})
                          </button>
                        )}
                      </div>
                    )}
                    {isCollapsed && allGroupChats.length > 0 && (
                      <div className="border-t border-border my-2" />
                    )}
                    <TaskListSection
                      tasks={regularTasks}
                      title=""
                      unreadCount={getUnreadCount(regularTasks)}
                      onTaskClick={() => setIsMobileSidebarOpen(false)}
                      isCollapsed={isCollapsed}
                      showTitle={false}
                      key={`regular-tasks-${viewStatusVersion}`}
                    />
                  </>
                )}
              </>
            );
          })()
        )}
        {loadingMore && (
          <div className="text-center py-2 text-xs text-text-muted">{t('tasks.loading')}</div>
        )}
      </div>

      {/* User Menu - matches Figma: left-[20px] top-[852px] with border */}
      <div className="px-2.5 py-3 border-t border-border" data-tour="settings-link">
        <UserFloatingMenu />
      </div>
    </>
  );

  return (
    <>
      {/* Desktop Sidebar - Hidden on mobile, width controlled by parent ResizableSidebar */}
      <div
        className="hidden lg:flex lg:flex-col lg:bg-surface w-full h-full"
        data-tour="task-sidebar"
      >
        {sidebarContent}
      </div>

      {/* Mobile Sidebar */}
      <MobileSidebar
        isOpen={isMobileSidebarOpen}
        onClose={() => setIsMobileSidebarOpen(false)}
        title={t('navigation.tasks')}
        data-tour="task-sidebar"
      >
        {sidebarContent}
      </MobileSidebar>
    </>
  );
}
