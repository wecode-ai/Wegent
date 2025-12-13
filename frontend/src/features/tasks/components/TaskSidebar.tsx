// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client';

import './task-list-scrollbar.css';
import React, { useRef, useEffect, useState, useCallback } from 'react';
import { Button } from '@/components/ui/button';
import Image from 'next/image';
import { useRouter } from 'next/navigation';
import { paths } from '@/config/paths';
import { Search, Plus, X, PanelLeftClose, PanelLeftOpen, Code, BookOpen, Rss } from 'lucide-react';
import { useTaskContext } from '@/features/tasks/contexts/taskContext';
import { useChatStreamContext } from '@/features/tasks/contexts/chatStreamContext';
import TaskListSection from './TaskListSection';
import { useTranslation } from '@/hooks/useTranslation';
import MobileSidebar from '@/features/layout/MobileSidebar';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { UserFloatingMenu } from '@/features/layout/components/UserFloatingMenu';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';

interface TaskSidebarProps {
  isMobileSidebarOpen: boolean;
  setIsMobileSidebarOpen: (open: boolean) => void;
  pageType?: 'chat' | 'code' | 'knowledge' | 'feed';
  isCollapsed?: boolean;
  onToggleCollapsed?: () => void;
}

export default function TaskSidebar({
  isMobileSidebarOpen,
  setIsMobileSidebarOpen,
  pageType = 'chat',
  isCollapsed = false,
  onToggleCollapsed,
}: TaskSidebarProps) {
  const { t } = useTranslation('common');
  const router = useRouter();
  const { clearAllStreams } = useChatStreamContext();
  const {
    tasks,
    loadMore,
    loadingMore,
    searchTerm,
    setSearchTerm,
    searchTasks,
    isSearching,
    isSearchResult,
    getUnreadCount,
    markAllTasksAsViewed,
    viewStatusVersion,
  } = useTaskContext();
  const scrollRef = useRef<HTMLDivElement>(null);
  const [localSearchTerm, setLocalSearchTerm] = useState(searchTerm);
  const [isSearchDialogOpen, setIsSearchDialogOpen] = useState(false);
  const searchInputRef = useRef<HTMLInputElement>(null);

  // Custom debounce
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const useDebounce = <T extends (...args: any[]) => void>(callback: T, delay: number) => {
    const timeoutRef = useRef<NodeJS.Timeout | null>(null);
    const debouncedFn = useCallback(
      (...args: Parameters<T>) => {
        if (timeoutRef.current) {
          clearTimeout(timeoutRef.current);
        }
        timeoutRef.current = setTimeout(() => {
          callback(...args);
        }, delay);
      },
      [callback, delay]
    );
    useEffect(() => {
      return () => {
        if (timeoutRef.current) {
          clearTimeout(timeoutRef.current);
        }
      };
    }, []);
    return debouncedFn;
  };

  // Debounce search
  const debouncedSearch = useDebounce((term: string) => {
    setSearchTerm(term);
    searchTasks(term);
  }, 500);

  // Search input change
  const handleSearchChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const value = e.target.value;
    setLocalSearchTerm(value);
    debouncedSearch(value);
  };

  // Clear search
  const handleClearSearch = () => {
    setLocalSearchTerm('');
    setSearchTerm('');
    searchTasks('');
  };

  // Open search dialog
  const handleOpenSearchDialog = () => {
    setIsSearchDialogOpen(true);
  };

  // Close search dialog
  const handleCloseSearchDialog = () => {
    setIsSearchDialogOpen(false);
  };

  // Focus input when dialog opens
  useEffect(() => {
    if (isSearchDialogOpen && searchInputRef.current) {
      setTimeout(() => {
        searchInputRef.current?.focus();
      }, 100);
    }
  }, [isSearchDialogOpen]);

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
    {
      label: t('navigation.feed'),
      icon: Rss,
      path: '/feed',
      isActive: pageType === 'feed',
    },
  ];

  // New conversation - always navigate to chat page
  const handleNewAgentClick = () => {
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
      {/* Logo and Mode Indicator */}
      <div className="px-1 pt-2 pb-3">
        <div
          className={`flex items-center ${isCollapsed ? 'justify-center' : 'justify-between pl-2'} gap-2`}
        >
          {!isCollapsed && (
            <div className="flex items-center gap-2">
              <Image
                src="/weibo-logo.png"
                alt="Weibo Logo"
                width={20}
                height={20}
                className="object-container"
              />
              <span className="text-sm text-text-primary">Wegent</span>
            </div>
          )}
          {onToggleCollapsed && (
            <TooltipProvider>
              <Tooltip delayDuration={300}>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={onToggleCollapsed}
                    className="h-8 w-8 p-0 text-text-muted hover:text-text-primary hover:bg-hover rounded-xl"
                    aria-label={isCollapsed ? t('sidebar.expand') : t('sidebar.collapse')}
                  >
                    {isCollapsed ? (
                      <PanelLeftOpen className="h-4 w-4" />
                    ) : (
                      <PanelLeftClose className="h-4 w-4" />
                    )}
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="right">
                  <p>{isCollapsed ? t('sidebar.expand') : t('sidebar.collapse')}</p>
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>
          )}
        </div>
      </div>

      {/* New Conversation Button - always shows "New Conversation" and navigates to chat */}
      <div className="px-1 mb-0">
        {isCollapsed ? (
          <TooltipProvider>
            <Tooltip delayDuration={300}>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  onClick={handleNewAgentClick}
                  className="w-full justify-center p-2 h-auto min-h-[44px] text-text-primary hover:bg-hover rounded-xl"
                  aria-label={t('tasks.new_conversation')}
                >
                  <Plus className="h-4 w-4" />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="right">
                <p>{t('tasks.new_conversation')}</p>
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
        ) : (
          <Button
            variant="ghost"
            onClick={handleNewAgentClick}
            className="w-full justify-start px-2 py-1.5 h-8 text-sm text-text-primary hover:bg-hover rounded-xl"
            size="sm"
          >
            <Plus className="h-4 w-4 mr-0.5" />
            {t('tasks.new_conversation')}
          </Button>
        )}
      </div>

      {/* Search Button - always shows "Search Conversation" */}
      <div className="px-1 mb-0">
        {isCollapsed ? (
          <TooltipProvider>
            <Tooltip delayDuration={300}>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  onClick={handleOpenSearchDialog}
                  className="w-full justify-center p-2 h-auto min-h-[44px] text-text-primary hover:bg-hover rounded-xl"
                  aria-label={t('tasks.search_placeholder_chat')}
                >
                  <Search className="h-4 w-4" />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="right">
                <p>{t('tasks.search_placeholder_chat')}</p>
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
        ) : (
          <Button
            variant="ghost"
            onClick={handleOpenSearchDialog}
            className="w-full justify-start px-2 py-1.5 h-8 text-sm text-text-primary hover:bg-hover rounded-xl"
            size="sm"
          >
            <Search className="h-4 w-4 mr-0.5" />
            {t('tasks.search_placeholder_chat')}
          </Button>
        )}
      </div>

      {/* Search Dialog - always shows "Search Conversation" */}
      <Dialog open={isSearchDialogOpen} onOpenChange={setIsSearchDialogOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{t('tasks.search_placeholder_chat')}</DialogTitle>
          </DialogHeader>
          <div className="relative">
            <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 h-4 w-4 text-text-muted" />
            <input
              ref={searchInputRef}
              type="text"
              value={localSearchTerm}
              onChange={handleSearchChange}
              placeholder={t('tasks.search_placeholder_chat')}
              className="w-full pl-10 pr-10 py-2 bg-surface border border-border rounded-lg text-sm text-text-primary placeholder:text-text-muted focus:outline-none focus:ring-2 focus:ring-primary/40 focus:border-transparent"
              onKeyDown={e => {
                if (e.key === 'Enter') {
                  handleCloseSearchDialog();
                }
              }}
            />
            {localSearchTerm && (
              <button
                onClick={handleClearSearch}
                className="absolute right-3 top-1/2 transform -translate-y-1/2"
              >
                <X className="h-4 w-4 text-text-muted hover:text-text-primary" />
              </button>
            )}
          </div>
          {localSearchTerm && (
            <p className="text-xs text-text-muted mt-2">{t('tasks.press_enter_to_search')}</p>
          )}
        </DialogContent>
      </Dialog>

      {/* Navigation Buttons - hide in collapsed mode */}
      {!isCollapsed && navigationButtons.length > 0 && (
        <div className="px-1 mb-2">
          {navigationButtons.map(btn => (
            <div key={btn.path} className="relative group">
              <Button
                variant="ghost"
                onClick={() => handleNavigationClick(btn.path, btn.isActive)}
                className={`w-full justify-start px-2 py-1.5 h-8 text-sm rounded-xl transition-colors ${
                  btn.isActive
                    ? 'bg-primary/10 text-primary font-medium'
                    : 'text-text-primary hover:bg-hover'
                }`}
                size="sm"
              >
                <btn.icon className={`h-4 w-4 mr-0.5 ${btn.isActive ? 'text-primary' : ''}`} />
                {btn.label}
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

      {/* Tasks Section */}
      <div
        className={`flex-1 ${isCollapsed ? 'px-0' : 'pl-2 pr-1'} pt-2 overflow-y-auto task-list-scrollbar border-t border-border`}
        ref={scrollRef}
      >
        {/* History Title or Search Result Header */}
        {!isCollapsed && !isSearchResult && (
          <div className="px-1 pb-2 text-xs font-medium text-text-muted flex items-center justify-between">
            <span>{t('tasks.history_title')}</span>
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
        {isSearching ? (
          <div className="text-center py-8 text-xs text-text-muted">{t('tasks.searching')}</div>
        ) : tasks.length === 0 ? (
          <div className="text-center py-8 text-xs text-text-muted">
            {isSearchResult ? t('tasks.no_search_results') : t('tasks.no_tasks')}
          </div>
        ) : (
          <TaskListSection
            tasks={tasks}
            title=""
            unreadCount={getUnreadCount(tasks)}
            onTaskClick={() => setIsMobileSidebarOpen(false)}
            isCollapsed={isCollapsed}
            showTitle={false}
            key={`tasks-${viewStatusVersion}`}
          />
        )}
        {loadingMore && (
          <div className="text-center py-2 text-xs text-text-muted">{t('tasks.loading')}</div>
        )}
      </div>

      {/* User Menu */}
      <div className="p-2 border-t border-border" data-tour="settings-link">
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
