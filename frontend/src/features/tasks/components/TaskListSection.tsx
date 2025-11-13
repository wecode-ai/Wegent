// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client';

import { useState } from 'react';
import { Task, TaskType } from '@/types/api';
import TaskMenu from './TaskMenu';
import {
  FaRegCircleCheck,
  FaRegCircleStop,
  FaRegCircleXmark,
  FaRegCirclePause,
} from 'react-icons/fa6';
import { ArrowPathIcon } from '@heroicons/react/24/outline';

import { useTaskContext } from '@/features/tasks/contexts/taskContext';
import { useTranslation } from '@/hooks/useTranslation';
import { taskApis } from '@/apis/tasks';

interface TaskListSectionProps {
  tasks: Task[];
  title: string;
  onTaskClick?: () => void;
}

import { useRouter } from 'next/navigation';
import { paths } from '@/config/paths';

export default function TaskListSection({ tasks, title, onTaskClick }: TaskListSectionProps) {
  const router = useRouter();
  const { selectedTaskDetail, setSelectedTask, refreshTasks } = useTaskContext();
  const { t } = useTranslation('common');
  const [hoveredTaskId, setHoveredTaskId] = useState<number | null>(null);
  const [_loading, setLoading] = useState(false);

  // Select task
  const handleTaskClick = (task: Task, event?: React.MouseEvent | React.TouchEvent) => {
    // Prevent default behavior for touch events
    if (event) {
      event.preventDefault();
    }

    if (typeof window !== 'undefined') {
      const params = new URLSearchParams();
      params.set('taskId', String(task.id));

      // Navigate to the appropriate page based on task task_type
      // If task_type is not set, infer from git information
      let targetPath = paths.chat.getHref(); // default to chat

      if (task.task_type === 'code') {
        targetPath = paths.code.getHref();
      } else if (task.task_type === 'chat') {
        targetPath = paths.chat.getHref();
      } else {
        // For backward compatibility: infer type from git information
        // If task has git repo info, assume it's a code task
        if (task.git_repo && task.git_repo.trim() !== '') {
          targetPath = paths.code.getHref();
        } else {
          targetPath = paths.chat.getHref();
        }
      }

      router.push(`${targetPath}?${params.toString()}`);

      // Call the onTaskClick callback if provided (to close mobile sidebar)
      if (onTaskClick) {
        onTaskClick();
      }
    }
  };
  // Handle touch start for immediate response on mobile
  const handleTaskTouchStart = (task: Task) => (event: React.TouchEvent) => {
    event.preventDefault();
    handleTaskClick(task, event);
  };

  // Copy task ID
  const handleCopyTaskId = async (taskId: number) => {
    const textToCopy = taskId.toString();
    if (typeof navigator !== 'undefined' && navigator.clipboard && navigator.clipboard.writeText) {
      try {
        await navigator.clipboard.writeText(textToCopy);
        return;
      } catch (err) {
        console.error('Copy failed', err);
      }
    }
    try {
      const textarea = document.createElement('textarea');
      textarea.value = textToCopy;
      textarea.style.cssText = 'position:fixed;opacity:0';
      document.body.appendChild(textarea);
      textarea.select();
      document.execCommand('copy');
      document.body.removeChild(textarea);
    } catch (err) {
      console.error('Fallback copy failed', err);
    }
  };

  // Delete task
  const handleDeleteTask = async (taskId: number) => {
    setLoading(true);
    try {
      await taskApis.deleteTask(taskId);
      setSelectedTask(null);
      if (typeof window !== 'undefined') {
        const url = new URL(window.location.href);
        url.searchParams.delete('taskId');
        router.replace(url.pathname + url.search);
        refreshTasks();
      }
    } catch (err) {
      console.error('Delete failed', err);
    } finally {
      setLoading(false);
    }
  };

  if (tasks.length === 0) return null;

  const getStatusIcon = (status: string) => {
    switch (status) {
      case 'COMPLETED':
        return <FaRegCircleCheck className="w-4 h-4 text-green-500" />;
      case 'FAILED':
        return <FaRegCircleXmark className="w-4 h-4 text-red-500" />;
      case 'CANCELLED':
        return <FaRegCircleStop className="w-4 h-4 text-gray-400" />;
      case 'RUNNING':
        return (
          <ArrowPathIcon className="w-4 h-4 text-blue-500 animate-spin" style={{ animationDuration: '2s' }} />
        );
      case 'PENDING':
        return <FaRegCirclePause className="w-4 h-4 text-yellow-500" />;
      default:
        return <FaRegCirclePause className="w-4 h-4 text-gray-400" />;
    }
  };

  const getTaskTypeTag = (task: Task) => {
    let taskType: TaskType | undefined = task.task_type;

    // For backward compatibility: infer type from git information if not set
    if (!taskType) {
      if (task.git_repo && task.git_repo.trim() !== '') {
        taskType = 'code';
      } else {
        taskType = 'chat';
      }
    }

    const typeConfig = {
      chat: { label: t('navigation.chat'), color: 'bg-blue-100 text-blue-800' },
      code: { label: t('navigation.code'), color: 'bg-green-100 text-green-800' },
    };

    const config = typeConfig[taskType];
    if (!config) return null;

    return (
      <span
        className={`inline-flex items-center px-1.5 py-0.5 rounded text-xs font-medium ${config.color}`}
      >
        {config.label}
      </span>
    );
  };

  const formatTimeAgo = (dateString: string) => {
    const now = new Date();
    const date = new Date(dateString);
    const diffMs = now.getTime() - date.getTime();

    const MINUTE_MS = 60 * 1000;
    const HOUR_MS = 60 * MINUTE_MS;
    const DAY_MS = 24 * HOUR_MS;

    // Handle negative time difference (client time earlier than server time)
    // or very small positive differences (< 1 minute)
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

  return (
    <div className="mb-2">
      <h3
        className="text-xs font-medium text-text-muted tracking-wide mb-1"
        style={{ fontSize: '10px' }}
      >
        {title}
      </h3>
      <div className="space-y-0">
        {tasks.map(task => {
          return (
            <div
              key={task.id}
              className={`flex items-center justify-between py-1 rounded hover:bg-muted cursor-pointer ${selectedTaskDetail?.id === task.id ? 'bg-muted' : ''}`}
              onClick={() => handleTaskClick(task)}
              onTouchStart={handleTaskTouchStart(task)}
              onMouseEnter={() => setHoveredTaskId(task.id)}
              onMouseLeave={() => setHoveredTaskId(null)}
              style={{
                touchAction: 'manipulation',
                WebkitTapHighlightColor: 'transparent',
                minHeight: '44px',
                padding: '8px 12px',
                userSelect: 'none',
              }}
            >
              <div className="flex items-center space-x-2 flex-1 min-w-0">
                <div className="flex-shrink-0 w-4 h-4 flex items-center justify-center">
                  {getStatusIcon(task.status)}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 mb-1">
                    <p className="text-xs text-text-muted leading-tight truncate m-0 flex-1">
                      {task.title}
                    </p>
                    {getTaskTypeTag(task)}
                  </div>
                  <p className="text-xs text-text-secondary m-0">
                    {formatTimeAgo(task.created_at)}
                  </p>
                </div>
              </div>

              <div className="flex-shrink-0">
                {hoveredTaskId === task.id && (
                  <TaskMenu
                    taskId={task.id}
                    handleCopyTaskId={handleCopyTaskId}
                    handleDeleteTask={handleDeleteTask}
                  />
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
