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
import {
  Search,
  Plus,
  X,
  PanelLeftClose,
  PanelLeftOpen,
  Code,
  BookOpen,
  CheckCircle2,
  XCircle,
  StopCircle,
  PauseCircle,
  RotateCw,
  Code2,
  MessageSquare,
} from 'lucide-react';
import { useTaskContext } from '@/features/tasks/contexts/taskContext';
import { useChatStreamContext } from '@/features/tasks/contexts/chatStreamContext';
import TaskListSection from './TaskListSection';
import { useTranslation } from '@/hooks/useTranslation';
import MobileSidebar from '@/features/layout/MobileSidebar';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { UserFloatingMenu } from '@/features/layout/components/UserFloatingMenu';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Task, TaskType } from '@/types/api';
import { taskApis } from '@/apis/tasks';

interface TaskSidebarProps {
  isMobileSidebarOpen: boolean;
  setIsMobileSidebarOpen: (open: boolean) => void;
  pageType?: 'chat' | 'code' | 'knowledge';
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
    searchTerm: _searchTerm,
    setSearchTerm,
    searchTasks,
    isSearching,
    isSearchResult,
    getUnreadCount,
    markAllTasksAsViewed,
    viewStatusVersion,
  } = useTaskContext();
  const scrollRef = useRef<HTMLDivElement>(null);
  const [isSearchDialogOpen, setIsSearchDialogOpen] = useState(false);
  const searchInputRef = useRef<HTMLInputElement>(null);

  // Search dialog specific state
  const [dialogSearchTerm, setDialogSearchTerm] = useState('');
  const [dialogSearchResults, setDialogSearchResults] = useState<Task[]>([]);
  const [isDialogSearching, setIsDialogSearching] = useState(false);

  // Custom debounce hook
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

  // Clear search for sidebar (used when clearing search results)
  const handleClearSearch = () => {
    setSearchTerm('');
    searchTasks('');
  };

  // Dialog search function
  const searchInDialog = useCallback(async (term: string) => {
    if (!term.trim()) {
      setDialogSearchResults([]);
      return;
    }

    setIsDialogSearching(true);
    try {
      const result = await taskApis.searchTasks(term, { page: 1, limit: 20 });
      setDialogSearchResults(result.items);
    } catch (error) {
      console.error('Failed to search tasks in dialog:', error);
      setDialogSearchResults([]);
    } finally {
      setIsDialogSearching(false);
    }
  }, []);

  // Debounced dialog search
  const debouncedDialogSearch = useDebounce((term: string) => {
    searchInDialog(term);
  }, 300);

  // Dialog search input change
  const handleDialogSearchChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const value = e.target.value;
    setDialogSearchTerm(value);
    debouncedDialogSearch(value);
  };

  // Clear dialog search
  const handleClearDialogSearch = () => {
    setDialogSearchTerm('');
    setDialogSearchResults([]);
  };

  // Open search dialog
  const handleOpenSearchDialog = () => {
    setIsSearchDialogOpen(true);
    // Reset dialog search state when opening
    setDialogSearchTerm('');
    setDialogSearchResults([]);
  };

  // Close search dialog
  const handleCloseSearchDialog = () => {
    setIsSearchDialogOpen(false);
    // Clear dialog search state when closing
    setDialogSearchTerm('');
    setDialogSearchResults([]);
  };

  // Focus input when dialog opens
  useEffect(() => {
    if (isSearchDialogOpen && searchInputRef.current) {
      setTimeout(() => {
        searchInputRef.current?.focus();
      }, 100);
    }
  }, [isSearchDialogOpen]);

  // Handle task click in search dialog
  const handleDialogTaskClick = (task: Task) => {
    // Clear all stream states when switching tasks
    clearAllStreams();

    if (typeof window !== 'undefined') {
      const params = new URLSearchParams();
      params.set('taskId', String(task.id));

      // Navigate to the appropriate page based on task task_type
      let targetPath = paths.chat.getHref(); // default to chat

      if (task.task_type === 'code') {
        targetPath = paths.code.getHref();
      } else if (task.task_type === 'chat') {
        targetPath = paths.chat.getHref();
      } else {
        // For backward compatibility: infer type from git information
        if (task.git_repo && task.git_repo.trim() !== '') {
          targetPath = paths.code.getHref();
        } else {
          targetPath = paths.chat.getHref();
        }
      }

      router.push(`${targetPath}?${params.toString()}`);
    }

    // Close the dialog after navigation
    handleCloseSearchDialog();
    // Close mobile sidebar if open
    setIsMobileSidebarOpen(false);
  };

  // Get status icon for search results
  const getStatusIcon = (status: string) => {
    switch (status) {
      case 'COMPLETED':
        return <CheckCircle2 className="w-4 h-4 text-green-500" />;
      case 'FAILED':
        return <XCircle className="w-4 h-4 text-red-500" />;
      case 'CANCELLED':
        return <StopCircle className="w-4 h-4 text-gray-400" />;
      case 'RUNNING':
        return (
          <RotateCw
            className="w-4 h-4 text-blue-500 animate-spin"
            style={{ animationDuration: '2s' }}
          />
        );
      case 'PENDING':
        return <PauseCircle className="w-4 h-4 text-yellow-500" />;
      default:
        return <PauseCircle className="w-4 h-4 text-gray-400" />;
    }
  };

  // Get task type icon for search results
  const getTaskTypeIcon = (task: Task) => {
    let taskType: TaskType | undefined = task.task_type;
    if (!taskType) {
      if (task.git_repo && task.git_repo.trim() !== '') {
        taskType = 'code';
      } else {
        taskType = 'chat';
      }
    }

    if (taskType === 'code') {
      return <Code2 className="w-3.5 h-3.5 text-text-muted" />;
    } else {
      return <MessageSquare className="w-3.5 h-3.5 text-text-muted" />;
    }
  };

  // Format time ago for search results
  const formatTimeAgo = (dateString: string) => {
    const now = new Date();
    const date = new Date(dateString);
    const diffMs = now.getTime() - date.getTime();

    const MINUTE_MS = 60 * 1000;
    const HOUR_MS = 60 * MINUTE_MS;
    const DAY_MS = 24 * HOUR_MS;

    if (diffMs < MINUTE_MS) {
      return '0m';
    } else if (diffMs < HOUR_MS) {
      return `${Math.floor(diffMs / MINUTE_MS)}m`;
    } else if (diffMs < DAY_MS) {
      return `${Math.floor(diffMs / HOUR_MS)}h`;
    } else {
      return `${Math.floor(diffMs / DAY_MS)}d`;
    }
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

      {/* Search Dialog - shows search input and results list */}
      <Dialog
        open={isSearchDialogOpen}
        onOpenChange={open => {
          if (!open) {
            handleCloseSearchDialog();
          } else {
            setIsSearchDialogOpen(true);
          }
        }}
      >
        <DialogContent className="sm:max-w-[678px] max-h-[440px] flex flex-col">
          <DialogHeader>
            <DialogTitle>{t('tasks.search_placeholder_chat')}</DialogTitle>
          </DialogHeader>
          <div className="relative">
            <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 h-4 w-4 text-text-muted" />
            <input
              ref={searchInputRef}
              type="text"
              value={dialogSearchTerm}
              onChange={handleDialogSearchChange}
              placeholder={t('tasks.search_placeholder_chat')}
              className="w-full pl-10 pr-10 py-2 bg-surface border border-border rounded-lg text-sm text-text-primary placeholder:text-text-muted focus:outline-none focus:ring-2 focus:ring-primary/40 focus:border-transparent"
            />
            {dialogSearchTerm && (
              <button
                onClick={handleClearDialogSearch}
                className="absolute right-3 top-1/2 transform -translate-y-1/2"
              >
                <X className="h-4 w-4 text-text-muted hover:text-text-primary" />
              </button>
            )}
          </div>

          {/* New Conversation Button - below search input */}
          <div
            className="flex items-center gap-3 py-2.5 px-3 mt-2 rounded-lg hover:bg-hover cursor-pointer transition-colors border border-dashed border-border"
            onClick={() => {
              handleCloseSearchDialog();
              handleNewAgentClick();
            }}
          >
            <div className="flex-shrink-0">
              <Plus className="w-3.5 h-3.5 text-primary" />
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-sm text-primary font-medium">{t('tasks.new_conversation')}</p>
            </div>
          </div>

          {/* Search Results List or Recent Tasks */}
          <div className="flex-1 overflow-y-auto mt-3 -mx-6 px-6">
            {isDialogSearching ? (
              <div className="text-center py-8 text-sm text-text-muted">{t('tasks.searching')}</div>
            ) : dialogSearchTerm && dialogSearchResults.length === 0 ? (
              <div className="text-center py-8 text-sm text-text-muted">
                {t('tasks.no_search_results')}
              </div>
            ) : dialogSearchTerm && dialogSearchResults.length > 0 ? (
              // Show search results when there's a search term
              <div className="space-y-1">
                {dialogSearchResults.map(task => (
                  <div
                    key={task.id}
                    className="flex items-center gap-3 py-2.5 px-3 rounded-lg hover:bg-hover cursor-pointer transition-colors"
                    onClick={() => handleDialogTaskClick(task)}
                  >
                    {/* Task type icon */}
                    <div className="flex-shrink-0">{getTaskTypeIcon(task)}</div>

                    {/* Task title and time */}
                    <div className="flex-1 min-w-0">
                      <p className="text-sm text-text-primary truncate">{task.title}</p>
                      <p className="text-xs text-text-muted">{formatTimeAgo(task.created_at)}</p>
                    </div>

                    {/* Status icon */}
                    <div className="flex-shrink-0">{getStatusIcon(task.status)}</div>
                  </div>
                ))}
              </div>
            ) : !dialogSearchTerm && tasks.length > 0 ? (
              // Show recent tasks when no search term (default view)
              <div className="space-y-1">
                {tasks.slice(0, 20).map(task => (
                  <div
                    key={task.id}
                    className="flex items-center gap-3 py-2.5 px-3 rounded-lg hover:bg-hover cursor-pointer transition-colors"
                    onClick={() => handleDialogTaskClick(task)}
                  >
                    {/* Task type icon */}
                    <div className="flex-shrink-0">{getTaskTypeIcon(task)}</div>

                    {/* Task title and time */}
                    <div className="flex-1 min-w-0">
                      <p className="text-sm text-text-primary truncate">{task.title}</p>
                      <p className="text-xs text-text-muted">{formatTimeAgo(task.created_at)}</p>
                    </div>

                    {/* Status icon */}
                    <div className="flex-shrink-0">{getStatusIcon(task.status)}</div>
                  </div>
                ))}
              </div>
            ) : !dialogSearchTerm && tasks.length === 0 ? (
              <div className="text-center py-8 text-sm text-text-muted">{t('tasks.no_tasks')}</div>
            ) : null}
          </div>
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
                    <p>{t('tasks.search_placeholder_chat')}</p>
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
        {/* Search Button for collapsed mode */}
        {isCollapsed && !isSearchResult && (
          <div className="px-1 pb-2 flex justify-center">
            <TooltipProvider>
              <Tooltip delayDuration={300}>
                <TooltipTrigger asChild>
                  <button
                    onClick={handleOpenSearchDialog}
                    className="p-1 text-text-muted hover:text-text-primary transition-colors rounded hover:bg-hover"
                    aria-label={t('tasks.search_placeholder_chat')}
                  >
                    <Search className="h-4 w-4" />
                  </button>
                </TooltipTrigger>
                <TooltipContent side="right">
                  <p>{t('tasks.search_placeholder_chat')}</p>
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>
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
