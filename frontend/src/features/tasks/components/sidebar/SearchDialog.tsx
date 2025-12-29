// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client';

import React, { useState, useCallback, useRef, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import {
  Search,
  Plus,
  X,
  CheckCircle2,
  XCircle,
  StopCircle,
  PauseCircle,
  RotateCw,
  Code2,
  MessageSquare,
  Users,
} from 'lucide-react';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { useTranslation } from '@/hooks/useTranslation';
import { useTaskContext } from '@/features/tasks/contexts/taskContext';
import { useChatStreamContext } from '@/features/tasks/contexts/chatStreamContext';
import { Task } from '@/types/api';
import { taskApis } from '@/apis/tasks';
import { paths } from '@/config/paths';

interface SearchDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  shortcutDisplayText?: string;
  pageType?: 'chat' | 'code' | 'knowledge';
}

export default function SearchDialog({
  open,
  onOpenChange,
  shortcutDisplayText = '',
  pageType = 'chat',
}: SearchDialogProps) {
  const { t } = useTranslation();
  const router = useRouter();
  const { clearAllStreams } = useChatStreamContext();
  const { tasks, setSelectedTask } = useTaskContext();

  const searchInputRef = useRef<HTMLInputElement>(null);
  const [dialogSearchTerm, setDialogSearchTerm] = useState('');
  const [dialogSearchResults, setDialogSearchResults] = useState<Task[]>([]);
  const [isDialogSearching, setIsDialogSearching] = useState(false);

  // Debounce timer ref
  const debounceTimerRef = useRef<NodeJS.Timeout | null>(null);

  // Focus input when dialog opens
  useEffect(() => {
    if (open && searchInputRef.current) {
      // Small delay to ensure dialog is rendered
      setTimeout(() => {
        searchInputRef.current?.focus();
      }, 100);
    }
  }, [open]);

  // Clear state when dialog closes
  useEffect(() => {
    if (!open) {
      setDialogSearchTerm('');
      setDialogSearchResults([]);
    }
  }, [open]);

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

  // Dialog search input change with debounce
  const handleDialogSearchChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const value = e.target.value;
    setDialogSearchTerm(value);

    // Clear existing timer
    if (debounceTimerRef.current) {
      clearTimeout(debounceTimerRef.current);
    }

    // Set new timer for debounced search
    debounceTimerRef.current = setTimeout(() => {
      searchInDialog(value);
    }, 300);
  };

  // Clear dialog search
  const handleClearDialogSearch = () => {
    setDialogSearchTerm('');
    setDialogSearchResults([]);
    searchInputRef.current?.focus();
  };

  // Handle dialog close
  const handleCloseSearchDialog = () => {
    setDialogSearchTerm('');
    setDialogSearchResults([]);
    onOpenChange(false);
  };

  // Handle task click in dialog
  const handleDialogTaskClick = (task: Task) => {
    handleCloseSearchDialog();
    setSelectedTask(task);
    // Navigate to task with taskId parameter
    const targetPath = task.task_type === 'code' ? paths.code.getHref() : paths.chat.getHref();
    router.push(`${targetPath}?taskId=${task.id}`);
  };

  // Handle new conversation click
  const handleNewAgentClick = () => {
    handleCloseSearchDialog();
    setSelectedTask(null);
    clearAllStreams();
    // Navigate to appropriate page based on pageType
    const targetPath = pageType === 'code' ? paths.code.getHref() : paths.chat.getHref();
    router.replace(targetPath);
  };

  // Format time ago
  const formatTimeAgo = (dateString: string) => {
    const date = new Date(dateString);
    const now = new Date();
    const diffInSeconds = Math.floor((now.getTime() - date.getTime()) / 1000);

    if (diffInSeconds < 60) return 'just now';
    if (diffInSeconds < 3600) return `${Math.floor(diffInSeconds / 60)}m ago`;
    if (diffInSeconds < 86400) return `${Math.floor(diffInSeconds / 3600)}h ago`;
    if (diffInSeconds < 604800) return `${Math.floor(diffInSeconds / 86400)}d ago`;
    return date.toLocaleDateString();
  };

  // Get task type icon
  const getTaskTypeIcon = (task: Task) => {
    if (task.is_group_chat) {
      return <Users className="w-4 h-4 text-text-muted" />;
    }
    if (task.task_type === 'code') {
      return <Code2 className="w-4 h-4 text-text-muted" />;
    }
    return <MessageSquare className="w-4 h-4 text-text-muted" />;
  };

  // Get status icon
  const getStatusIcon = (status: string) => {
    switch (status) {
      case 'COMPLETED':
        return <CheckCircle2 className="w-4 h-4 text-green-500" />;
      case 'FAILED':
        return <XCircle className="w-4 h-4 text-red-500" />;
      case 'CANCELLED':
        return <StopCircle className="w-4 h-4 text-orange-500" />;
      case 'PENDING':
        return <PauseCircle className="w-4 h-4 text-yellow-500" />;
      case 'RUNNING':
        return <RotateCw className="w-4 h-4 text-blue-500 animate-spin" />;
      default:
        return null;
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={open => {
        if (!open) {
          handleCloseSearchDialog();
        } else {
          onOpenChange(true);
        }
      }}
    >
      <DialogContent className="sm:max-w-[678px] max-h-[440px] flex flex-col">
        <DialogHeader>
          <DialogTitle>{t('common:tasks.search_placeholder_chat')}</DialogTitle>
        </DialogHeader>
        <div className="relative">
          <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 h-4 w-4 text-text-muted" />
          <input
            ref={searchInputRef}
            type="text"
            value={dialogSearchTerm}
            onChange={handleDialogSearchChange}
            placeholder={
              shortcutDisplayText
                ? t('common:tasks.search_placeholder_with_shortcut', {
                    shortcut: shortcutDisplayText,
                  })
                : t('common:tasks.search_placeholder_chat')
            }
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
          onClick={handleNewAgentClick}
        >
          <div className="flex-shrink-0">
            <Plus className="w-3.5 h-3.5 text-primary" />
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-sm text-primary font-medium">{t('common:tasks.new_conversation')}</p>
          </div>
        </div>

        {/* Search Results List or Recent Tasks */}
        <div className="flex-1 overflow-y-auto mt-3 -mx-6 px-6">
          {isDialogSearching ? (
            <div className="text-center py-8 text-sm text-text-muted">
              {t('common:tasks.searching')}
            </div>
          ) : dialogSearchTerm && dialogSearchResults.length === 0 ? (
            <div className="text-center py-8 text-sm text-text-muted">
              {t('common:tasks.no_search_results')}
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
            <div className="text-center py-8 text-sm text-text-muted">
              {t('common:tasks.no_tasks')}
            </div>
          ) : null}
        </div>
      </DialogContent>
    </Dialog>
  );
}
