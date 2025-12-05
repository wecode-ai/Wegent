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
import { Search, Plus, Settings, X, PanelLeftClose, PanelLeftOpen } from 'lucide-react';
import { useTaskContext } from '@/features/tasks/contexts/taskContext';
import TaskListSection from './TaskListSection';
import { useTranslation } from '@/hooks/useTranslation';
import MobileSidebar from '@/features/layout/MobileSidebar';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';

interface TaskSidebarProps {
  isMobileSidebarOpen: boolean;
  setIsMobileSidebarOpen: (open: boolean) => void;
  pageType?: 'chat' | 'code';
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
  const {
    tasks,
    loadMore,
    hasMore,
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

  // Grouping logic
  // Include viewStatusVersion in dependencies to recalculate unread counts when view status changes
  const groupTasksByDate = React.useMemo(() => {
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());

    // Calculate the start of this week (Monday 00:00:00)
    const dayOfWeek = now.getDay(); // 0 = Sunday, 1 = Monday, ..., 6 = Saturday
    const daysFromMonday = dayOfWeek === 0 ? 6 : dayOfWeek - 1; // If Sunday, 6 days back; otherwise (dayOfWeek - 1)
    const thisMonday = new Date(today.getTime() - daysFromMonday * 24 * 60 * 60 * 1000);

    const todayTasks = tasks.filter(task => new Date(task.created_at) >= today);
    const thisWeekTasks = tasks.filter(task => {
      const taskDate = new Date(task.created_at);
      return taskDate >= thisMonday && taskDate < today;
    });
    const earlierTasks = tasks.filter(task => new Date(task.created_at) < thisMonday);

    return {
      today: todayTasks,
      thisWeek: thisWeekTasks,
      earlier: earlierTasks,
      todayUnread: getUnreadCount(todayTasks),
      thisWeekUnread: getUnreadCount(thisWeekTasks),
      earlierUnread: getUnreadCount(earlierTasks),
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tasks, getUnreadCount, viewStatusVersion]);

  // New task
  const handleNewAgentClick = () => {
    if (typeof window !== 'undefined') {
      // Navigate to the same page type for new task creation
      switch (pageType) {
        case 'code':
          router.replace(paths.code.getHref());
          break;
        case 'chat':
        default:
          router.replace(paths.chat.getHref());
          break;
      }
    }
    // Close mobile sidebar after navigation
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
      {/* Logo */}
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
                    className="h-8 w-8 p-0 text-text-muted hover:text-text-primary hover:bg-hover"
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

      {/* New Task Button */}
      <div className="px-1 mb-0">
        {isCollapsed ? (
          <TooltipProvider>
            <Tooltip delayDuration={300}>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  onClick={handleNewAgentClick}
                  className="w-full justify-center p-2 h-auto min-h-[44px] text-text-primary hover:bg-hover rounded"
                  aria-label={t('tasks.new_task')}
                >
                  <Plus className="h-4 w-4" />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="right">
                <p>{t('tasks.new_task')}</p>
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
        ) : (
          <Button
            variant="ghost"
            onClick={handleNewAgentClick}
            className="w-full justify-start px-2 py-1.5 h-8 text-sm text-text-primary hover:bg-hover"
            size="sm"
          >
            <Plus className="h-4 w-4 mr-0.5" />
            {t('tasks.new_task')}
          </Button>
        )}
      </div>

      {/* Search */}
      <div className="px-1 mb-0">
        {isCollapsed ? (
          <TooltipProvider>
            <Tooltip delayDuration={300}>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  onClick={onToggleCollapsed}
                  className="w-full justify-center p-2 h-auto min-h-[44px] text-text-primary hover:bg-hover rounded"
                  aria-label={t('tasks.search_placeholder')}
                >
                  <Search className="h-4 w-4" />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="right">
                <p>{t('tasks.search_placeholder')}</p>
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
        ) : (
          <div className="relative group">
            <Search className="absolute left-2.5 top-1/2 transform -translate-y-1/2 h-3.5 w-3.5 text-text-muted" />
            <input
              type="text"
              value={localSearchTerm}
              onChange={handleSearchChange}
              placeholder={t('tasks.search_placeholder')}
              className="w-full pl-8 pr-8 py-1.5 bg-transparent group-hover:bg-hover border border-transparent group-hover:border-border rounded text-sm text-text-primary placeholder:text-text-primary focus:outline-none focus:ring-2 focus:ring-primary/40 focus:border-transparent focus:bg-hover cursor-text"
            />
            {localSearchTerm && (
              <button
                onClick={handleClearSearch}
                className="absolute right-2 top-1/2 transform -translate-y-1/2"
              >
                <X className="h-3.5 w-3.5 text-text-muted hover:text-text-primary" />
              </button>
            )}
          </div>
        )}
      </div>

      {/* Mark All As Read Button - hide in collapsed mode */}
      {!isCollapsed && totalUnreadCount > 0 && (
        <div className="px-1 mb-2">
          <button
            onClick={handleMarkAllAsViewed}
            className="w-full text-xs text-text-primary hover:text-text-primary py-1 px-2 rounded hover:bg-hover transition-colors text-center"
          >
            {t('tasks.mark_all_read')} ({totalUnreadCount})
          </button>
        </div>
      )}

      {/* Tasks Section */}
      <div
        className={`flex-1 ${isCollapsed ? 'px-0' : 'pl-2 pr-1'} pt-2 overflow-y-auto task-list-scrollbar`}
        ref={scrollRef}
      >
        {isSearching ? (
          <div className="text-center py-8 text-xs text-text-muted">{t('tasks.searching')}</div>
        ) : tasks.length === 0 ? (
          <div className="text-center py-8 text-xs text-text-muted">
            {isSearchResult ? t('tasks.no_search_results') : t('tasks.no_tasks')}
          </div>
        ) : isSearchResult ? (
          <TaskListSection
            tasks={tasks}
            title={t('tasks.search_results')}
            unreadCount={getUnreadCount(tasks)}
            onTaskClick={() => setIsMobileSidebarOpen(false)}
            isCollapsed={isCollapsed}
            key={`search-${viewStatusVersion}`}
          />
        ) : (
          <>
            <TaskListSection
              tasks={groupTasksByDate.today}
              title={t('tasks.today')}
              unreadCount={groupTasksByDate.todayUnread}
              onTaskClick={() => setIsMobileSidebarOpen(false)}
              isCollapsed={isCollapsed}
              key={`today-${viewStatusVersion}`}
            />
            <TaskListSection
              tasks={groupTasksByDate.thisWeek}
              title={t('tasks.this_week')}
              unreadCount={groupTasksByDate.thisWeekUnread}
              onTaskClick={() => setIsMobileSidebarOpen(false)}
              isCollapsed={isCollapsed}
              key={`week-${viewStatusVersion}`}
            />
            <TaskListSection
              tasks={groupTasksByDate.earlier}
              title={t('tasks.earlier')}
              unreadCount={groupTasksByDate.earlierUnread}
              onTaskClick={() => setIsMobileSidebarOpen(false)}
              isCollapsed={isCollapsed}
              key={`earlier-${viewStatusVersion}`}
            />
          </>
        )}
        {loadingMore && (
          <div className="text-center py-2 text-xs text-text-muted">{t('tasks.loading')}</div>
        )}
        {!isSearchResult && !hasMore && tasks.length > 0 && (
          <div className="text-center py-2 text-xs text-text-muted">{t('tasks.no_more_tasks')}</div>
        )}
      </div>

      {/* Settings */}
      <div className="p-3 border-t border-border">
        {isCollapsed ? (
          <TooltipProvider>
            <Tooltip delayDuration={300}>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  onClick={() => {
                    router.push(paths.settings.root.getHref());
                    setIsMobileSidebarOpen(false);
                  }}
                  className="w-full justify-center p-2 h-auto min-h-[44px] text-text-primary hover:text-text-primary hover:bg-hover rounded"
                  data-tour="settings-link"
                  aria-label={t('tasks.settings')}
                >
                  <Settings className="h-3.5 w-3.5" />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="right">
                <p>{t('tasks.settings')}</p>
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
        ) : (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              router.push(paths.settings.root.getHref());
              setIsMobileSidebarOpen(false);
            }}
            className="text-text-primary hover:text-text-primary hover:bg-hover"
            data-tour="settings-link"
          >
            <Settings className="h-3.5 w-3.5 mr-2" />
            {t('tasks.settings')}
          </Button>
        )}
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
