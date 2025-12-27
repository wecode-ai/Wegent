// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client';

import { useEffect, useState } from 'react';
import {
  Disclosure,
  DisclosureButton,
  DisclosurePanel,
  Dialog,
  DialogPanel,
  DialogTitle,
} from '@headlessui/react';
import {
  Bars3Icon,
  CheckIcon,
  ChevronRightIcon,
  ClipboardDocumentIcon,
  XMarkIcon,
  ExclamationTriangleIcon,
} from '@heroicons/react/24/outline';
import MarkdownEditor from '@uiw/react-markdown-editor';
import { useTheme } from '@/features/theme/ThemeProvider';
import { useTranslation } from '@/hooks/useTranslation';
import { taskApis, BranchDiffResponse } from '@/apis/tasks';
import DiffViewer from '../message/DiffViewer';

// Tool icon mapping
const TOOL_ICONS: Record<string, string> = {
  Read: '📖',
  Edit: '✏️',
  Write: '📝',
  Bash: '⚙️',
  Grep: '🔍',
  Glob: '📁',
  Task: '🤖',
  WebFetch: '🌐',
  WebSearch: '🔎',
};

// Git commit statistics
interface CommitStats {
  files_changed: number;
  insertions: number;
  deletions: number;
}

// Git commit information
interface GitCommit {
  commit_id: string;
  short_id: string;
  message: string;
  author: string;
  author_email: string;
  committed_date: string;
  stats: CommitStats;
}

// Git information
interface GitInfo {
  initial_commit_id: string;
  initial_commit_message: string;
  task_commits: GitCommit[];
  source_branch: string;
  target_branch: string;
}

// File change information
interface FileChange {
  old_path: string;
  new_path: string;
  new_file: boolean;
  renamed_file: boolean;
  deleted_file: boolean;
  added_lines: number;
  removed_lines: number;
  diff_title: string;
}

// Workbench data structure
interface WorkbenchData {
  taskTitle: string;
  taskNumber: string;
  status: 'running' | 'completed' | 'failed';
  completedTime: string;
  repository: string;
  branch: string;
  sessions: number;
  premiumRequests: number;
  lastUpdated: string;
  summary: string;
  changes: string[];
  originalPrompt: string;
  file_changes: FileChange[];
  git_info: GitInfo;
  git_type?: 'github' | 'gitlab';
  git_domain?: string;
}

interface WorkbenchProps {
  isOpen: boolean;
  onClose: () => void;
  onOpen: () => void;
  workbenchData?: WorkbenchData | null;
  isLoading?: boolean;
  taskTitle?: string;
  taskNumber?: string;
  thinking?: Array<{
    title: string;
    next_action: string;
    details?: Record<string, unknown>;
  }> | null;
}

function classNames(...classes: string[]) {
  return classes.filter(Boolean).join(' ');
}

function formatDateTime(dateString: string | undefined): string {
  if (!dateString) return '';

  try {
    const date = new Date(dateString);
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    const hours = String(date.getHours()).padStart(2, '0');
    const minutes = String(date.getMinutes()).padStart(2, '0');
    const seconds = String(date.getSeconds()).padStart(2, '0');

    return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;
  } catch (_error) {
    return dateString;
  }
}

export default function Workbench({
  isOpen,
  onClose,
  onOpen: _onOpen,
  workbenchData,
  isLoading: _isLoading = false,
  taskTitle,
  taskNumber,
  thinking,
}: WorkbenchProps) {
  const [activeTab, setActiveTab] = useState<'overview' | 'files'>('overview');
  const [showCommits, setShowCommits] = useState(false);
  const [copiedCommitId, setCopiedCommitId] = useState<string | null>(null);
  const [diffData, setDiffData] = useState<BranchDiffResponse | null>(null);
  const [isDiffLoading, setIsDiffLoading] = useState(false);
  const [diffLoadError, setDiffLoadError] = useState<string | null>(null);
  const [showErrorDialog, setShowErrorDialog] = useState(false);
  const [loadingStateIndex, setLoadingStateIndex] = useState(0);
  const [tipIndex, setTipIndex] = useState(0);
  const [isTimelineExpanded, setIsTimelineExpanded] = useState(false); // Timeline collapse state
  const { theme } = useTheme();
  const { t } = useTranslation();

  // Internal state: cache the latest workbench data
  const [cachedWorkbenchData, setCachedWorkbenchData] = useState<WorkbenchData | null>(null);

  // Use cached data for rendering
  const displayData = cachedWorkbenchData;

  // Loading state rotation (4 seconds)
  useEffect(() => {
    if (!displayData) {
      const loadingStates = t('tasks:workbench.loading_states', {
        returnObjects: true,
      }) as string[];
      const interval = setInterval(() => {
        setLoadingStateIndex(prev => (prev + 1) % loadingStates.length);
      }, 4000);
      return () => clearInterval(interval);
    }
  }, [displayData, t]);

  // Tips rotation (6 seconds, random)
  useEffect(() => {
    if (!displayData) {
      const tips = t('tasks:workbench.tips', { returnObjects: true }) as string[];
      const interval = setInterval(() => {
        setTipIndex(Math.floor(Math.random() * tips.length));
      }, 6000);
      return () => clearInterval(interval);
    }
  }, [displayData, t]);

  // Observer pattern: listen to workbenchData changes
  useEffect(() => {
    // If the API returns new workbench data (not null/undefined), update the cache
    if (workbenchData) {
      // Check if task has changed by comparing task numbers or IDs
      const taskChanged =
        cachedWorkbenchData && cachedWorkbenchData.taskNumber !== workbenchData.taskNumber;

      setCachedWorkbenchData(workbenchData);

      // Reset diff data when task changes
      if (taskChanged) {
        setDiffData(null);
        setIsDiffLoading(false);
        setDiffLoadError(null);
      }
    }
    //If workbenchData is null/undefined, keep the previous state (don't update cache)
  }, [workbenchData, cachedWorkbenchData]);

  const loadDiffData = async () => {
    if (!cachedWorkbenchData || !cachedWorkbenchData.git_info.target_branch) {
      return;
    }

    setIsDiffLoading(true);
    setDiffLoadError(null);
    try {
      const response = await taskApis.getBranchDiff({
        git_repo: cachedWorkbenchData.repository,
        source_branch: cachedWorkbenchData.git_info.source_branch,
        target_branch: cachedWorkbenchData.git_info.target_branch,
        type: cachedWorkbenchData.git_type || 'github',
        git_domain: cachedWorkbenchData.git_domain || 'github.com',
      });
      setDiffData(response);
      setDiffLoadError(null);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.error('Failed to load diff data:', errorMessage);
      setDiffLoadError(errorMessage);
      // Don't set diffData - let error state prevent retry
    } finally {
      setIsDiffLoading(false);
    }
  };

  // Auto-load diff data when task is completed
  // Only load once per task - prevent infinite retry on error
  useEffect(() => {
    if (
      cachedWorkbenchData?.status === 'completed' &&
      cachedWorkbenchData.git_info.target_branch &&
      !diffData &&
      !isDiffLoading &&
      !diffLoadError // Don't retry if there was an error
    ) {
      loadDiffData();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    cachedWorkbenchData?.status,
    cachedWorkbenchData?.git_info.target_branch,
    diffData,
    isDiffLoading,
    diffLoadError,
  ]);

  // Check if we should show diff data
  const shouldShowDiffData = () => {
    return (
      displayData?.status === 'completed' &&
      diffData &&
      !isDiffLoading &&
      !diffLoadError &&
      diffData.files &&
      diffData.files.length > 0
    );
  };

  const navigation = [
    {
      name: t('tasks:workbench.overview'),
      value: 'overview' as const,
      current: activeTab === 'overview',
    },
    {
      name: t('tasks:workbench.files_changed'),
      value: 'files' as const,
      current: activeTab === 'files',
      badge: shouldShowDiffData()
        ? diffData?.files?.length || 0
        : displayData?.file_changes?.length || 0,
    },
  ];

  const getStatusColor = () => {
    switch (displayData?.status) {
      case 'completed':
        return 'text-green-600';
      case 'failed':
        return 'text-red-600';
      default:
        return 'text-yellow-600';
    }
  };

  const getStatusText = () => {
    switch (displayData?.status) {
      case 'completed':
        return t('tasks:workbench.status.completed');
      case 'failed':
        return t('tasks:workbench.status.failed');
      default:
        return t('tasks:workbench.status.running');
    }
  };

  // Build execution timeline from thinking data
  interface TimelineStep {
    toolName: string;
    count: number;
    timestamp: string;
  }

  const buildTimeline = (
    thinkingSteps: Array<{
      title: string;
      next_action: string;
      details?: Record<string, unknown>;
    }>
  ): TimelineStep[] => {
    if (!thinkingSteps || thinkingSteps.length === 0) return [];

    const timeline: TimelineStep[] = [];
    let currentTool: string | null = null;
    let currentCount = 0;
    let currentTimestamp = '';

    thinkingSteps.forEach(step => {
      let toolName: string | null = null;
      let timestamp = '';

      // Extract tool name from details
      if (step.details?.type === 'tool_use' && typeof step.details?.name === 'string') {
        toolName = step.details.name;
      } else if (
        step.details &&
        'message' in step.details &&
        typeof step.details.message === 'object' &&
        step.details.message !== null
      ) {
        const message = step.details.message as {
          content?: Array<{ type: string; name?: string }>;
        };
        if (message.content && Array.isArray(message.content)) {
          for (const content of message.content) {
            if (content.type === 'tool_use' && content.name) {
              toolName = content.name;
              break;
            }
          }
        }
      }

      // Extract timestamp
      const details = step.details as { timestamp?: string; created_at?: string } | undefined;
      if (details?.timestamp) {
        timestamp = new Date(details.timestamp).toLocaleTimeString('en-US', {
          hour12: false,
        });
      } else if (details?.created_at) {
        timestamp = new Date(details.created_at).toLocaleTimeString('en-US', {
          hour12: false,
        });
      }

      if (toolName) {
        if (toolName === currentTool) {
          // Same tool, increment count
          currentCount++;
        } else {
          // Different tool, save previous and start new
          if (currentTool) {
            timeline.push({
              toolName: currentTool,
              count: currentCount,
              timestamp: currentTimestamp,
            });
          }
          currentTool = toolName;
          currentCount = 1;
          currentTimestamp = timestamp || currentTimestamp;
        }
      }
    });

    // Add last group
    if (currentTool) {
      timeline.push({
        toolName: currentTool,
        count: currentCount,
        timestamp: currentTimestamp,
      });
    }

    return timeline;
  };

  const timelineSteps = thinking ? buildTimeline(thinking) : [];

  // Auto-collapse timeline when task is completed
  useEffect(() => {
    if (displayData?.status === 'completed' && timelineSteps.length > 0) {
      setIsTimelineExpanded(false);
    }
  }, [displayData?.status, timelineSteps.length]);

  // Generate collapsed timeline summary
  const getTimelineSummary = (): string => {
    if (timelineSteps.length === 0) return '';

    const summary: string[] = [];
    timelineSteps.forEach(step => {
      const icon = TOOL_ICONS[step.toolName] || '⚡';
      summary.push(`${icon}×${step.count}`);
    });

    return summary.join(' ');
  };

  return (
    <>
      {/* Right panel */}
      <div
        className="transition-all duration-300 ease-in-out bg-surface overflow-hidden"
        style={{
          width: isOpen ? '40%' : '0',
        }}
      >
        {isOpen && (
          <div className="h-full flex flex-col border border-border rounded-lg overflow-hidden">
            {/* Navigation Header */}
            <Disclosure as="nav" className="border-b border-border bg-surface">
              <div className="mx-auto px-2 sm:px-3 lg:px-4">
                <div className="flex h-12 justify-between">
                  <div className="flex">
                    <div className="hidden sm:-my-px sm:flex sm:space-x-8">
                      {navigation.map(item => (
                        <button
                          key={item.name}
                          onClick={() => setActiveTab(item.value)}
                          aria-current={item.current ? 'page' : undefined}
                          className={classNames(
                            item.current
                              ? 'border-primary text-text-primary'
                              : 'border-transparent text-text-muted hover:border-border hover:text-text-primary',
                            'inline-flex items-center border-b-2 px-1 pt-1 text-sm font-medium'
                          )}
                        >
                          {item.name}
                          {item.badge !== undefined && item.badge > 0 && (
                            <span className="ml-2 rounded-full bg-muted px-2 py-0.5 text-xs font-medium text-text-muted">
                              {item.badge}
                            </span>
                          )}
                        </button>
                      ))}
                    </div>
                  </div>
                  <div className="hidden sm:ml-6 sm:flex sm:items-center">
                    <button
                      onClick={onClose}
                      className="relative rounded-full p-1 text-text-muted hover:text-text-primary focus:outline focus:outline-2 focus:outline-offset-2 focus:outline-primary"
                    >
                      <span className="sr-only">{t('tasks:workbench.close_panel')}</span>
                      <XMarkIcon aria-hidden="true" className="size-6" />
                    </button>
                  </div>
                  <div className="-mr-2 flex items-center sm:hidden">
                    {/* Mobile menu button */}
                    <DisclosureButton className="group relative inline-flex items-center justify-center rounded-md bg-surface p-2 text-text-muted hover:bg-muted hover:text-text-primary focus:outline focus:outline-2 focus:outline-offset-2 focus:outline-primary">
                      <span className="absolute -inset-0.5" />
                      <span className="sr-only">{t('tasks:workbench.open_main_menu')}</span>
                      <Bars3Icon
                        aria-hidden="true"
                        className="block size-6 group-data-[open]:hidden"
                      />
                      <XMarkIcon
                        aria-hidden="true"
                        className="hidden size-6 group-data-[open]:block"
                      />
                    </DisclosureButton>
                  </div>
                </div>
              </div>

              <DisclosurePanel className="sm:hidden">
                <div className="space-y-1 pb-3 pt-2">
                  {navigation.map(item => (
                    <DisclosureButton
                      key={item.name}
                      as="button"
                      onClick={() => setActiveTab(item.value)}
                      aria-current={item.current ? 'page' : undefined}
                      className={classNames(
                        item.current
                          ? 'border-primary bg-muted text-text-primary'
                          : 'border-transparent text-text-muted hover:border-border hover:bg-muted hover:text-text-primary',
                        'block w-full text-left border-l-4 py-2 pl-3 pr-4 text-base font-medium'
                      )}
                    >
                      <div className="flex items-center justify-between">
                        <span>{item.name}</span>
                        {item.badge !== undefined && item.badge > 0 && (
                          <span className="rounded-full bg-muted px-2 py-0.5 text-xs font-medium text-text-muted">
                            {item.badge}
                          </span>
                        )}
                      </div>
                    </DisclosureButton>
                  ))}
                </div>
              </DisclosurePanel>
            </Disclosure>

            {/* Content */}
            <div className="flex-1 overflow-y-auto">
              <div className="mx-auto max-w-7xl px-2 pt-4 pb-2 sm:px-3 lg:px-4">
                {!displayData ? (
                  // Loading state without skeleton screen, only progress text and tips
                  <div className="space-y-6">
                    {/* Task Title Section - shown even during loading */}
                    {(taskTitle || taskNumber) && (
                      <div className="flex items-baseline gap-2">
                        <h2 className="text-lg font-semibold text-text-primary">
                          {taskTitle || ''}
                        </h2>
                        <span className="text-sm text-text-muted">{taskNumber || ''}</span>
                      </div>
                    )}

                    {/* Progress Text with Icon */}
                    <div className="flex items-center justify-center gap-3 pt-4 transition-opacity duration-300">
                      <div className="animate-spin rounded-full h-5 w-5 border-2 border-primary border-t-transparent"></div>
                      <p className="text-sm text-text-primary">
                        {
                          (
                            t('tasks:workbench.loading_states', { returnObjects: true }) as string[]
                          )[loadingStateIndex]
                        }
                      </p>
                    </div>

                    {/* Tips */}
                    <div className="flex items-center justify-center transition-opacity duration-300">
                      <p className="text-xs text-text-muted text-center">
                        {(t('tasks:workbench.tips', { returnObjects: true }) as string[])[tipIndex]}
                      </p>
                    </div>
                  </div>
                ) : activeTab === 'overview' ? (
                  <div className="space-y-6">
                    <div className="flex items-baseline gap-2">
                      <h2 className="text-lg font-semibold text-text-primary">
                        {displayData?.taskTitle || ''}
                      </h2>
                      <span className="text-sm text-text-muted">
                        {displayData?.taskNumber || ''}
                      </span>
                    </div>
                    {/* Status Badge */}
                    <div className="flex items-center gap-3">
                      <span
                        className={classNames(
                          getStatusColor(),
                          'inline-flex items-center gap-2 rounded-full px-3 py-1 text-sm font-medium bg-muted'
                        )}
                      >
                        {displayData?.status === 'running' ? (
                          <div className="animate-spin rounded-full h-4 w-4 border-[2px] border-current border-t-transparent"></div>
                        ) : (
                          <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 16 16">
                            <path d="M8 16A8 8 0 1 1 8 0a8 8 0 0 1 0 16zm3.78-9.72a.75.75 0 0 0-1.06-1.06L6.75 9.19 5.28 7.72a.75.75 0 0 0-1.06 1.06l2 2a.75.75 0 0 0 1.06 0l4.5-4.5z" />
                          </svg>
                        )}
                        {getStatusText()}
                      </span>
                      <span className="text-sm text-text-muted">
                        {formatDateTime(displayData?.completedTime) || ''}
                      </span>
                    </div>
                    {/* Repository Info */}
                    <div className="rounded-lg border border-border bg-surface p-4">
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-2 text-sm text-text-muted">
                          <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 16 16">
                            <path d="M2 2.5A2.5 2.5 0 0 1 4.5 0h8.75a.75.75 0 0 1 .75.75v12.5a.75.75 0 0 1-.75.75h-2.5a.75.75 0 0 1 0-1.5h1.75v-2h-8a1 1 0 0 0-.714 1.7.75.75 0 1 1-1.072 1.05A2.495 2.495 0 0 1 2 11.5v-9zm10.5-1h-8a1 1 0 0 0-1 1v6.708A2.486 2.486 0 0 1 4.5 9h8V1.5z" />
                          </svg>
                          <span className="font-medium">{displayData?.repository || ''}</span>
                        </div>
                      </div>
                      <div className="mt-3 flex items-center gap-2 text-sm">
                        <span className="inline-flex items-center rounded-md bg-primary/10 px-2 py-1 text-xs font-medium text-primary ring-1 ring-inset ring-primary/20">
                          {displayData?.git_info?.source_branch || displayData?.branch || ''}
                        </span>
                        {displayData?.git_info?.target_branch ? (
                          <>
                            <ChevronRightIcon className="w-4 h-4 text-text-muted" />
                            <span className="inline-flex items-center rounded-md bg-primary/10 px-2 py-1 text-xs font-medium text-primary ring-1 ring-inset ring-primary/20">
                              {displayData.git_info.target_branch}
                            </span>
                          </>
                        ) : displayData?.status === 'running' ? (
                          <>
                            <ChevronRightIcon className="w-4 h-4 text-text-muted" />
                            <div className="flex items-center gap-1.5">
                              <div className="animate-pulse flex space-x-1">
                                <div className="w-1.5 h-1.5 bg-primary/40 rounded-full"></div>
                                <div className="w-1.5 h-1.5 bg-primary/40 rounded-full animation-delay-200"></div>
                                <div className="w-1.5 h-1.5 bg-primary/40 rounded-full animation-delay-400"></div>
                              </div>
                            </div>
                          </>
                        ) : null}
                      </div>
                    </div>

                    {/* Execution Timeline */}
                    {timelineSteps.length > 0 && (
                      <div className="rounded-lg border border-border bg-surface overflow-hidden">
                        <button
                          onClick={() => setIsTimelineExpanded(!isTimelineExpanded)}
                          className="w-full border-b border-border bg-muted px-4 py-3 text-left hover:bg-muted/80 transition-colors"
                        >
                          <div className="flex items-center justify-between">
                            <h3 className="text-base font-semibold text-text-primary">
                              {t('tasks:workbench.execution_timeline')}
                            </h3>
                            <ChevronRightIcon
                              className={classNames(
                                isTimelineExpanded ? 'rotate-90 transform' : '',
                                'h-5 w-5 text-text-muted transition-transform'
                              )}
                            />
                          </div>
                          {!isTimelineExpanded && (
                            <div className="mt-2 text-sm text-text-muted">
                              {getTimelineSummary()}
                            </div>
                          )}
                        </button>
                        {isTimelineExpanded && (
                          <div className="px-4 py-4">
                            <div className="relative space-y-4">
                              {timelineSteps.map((step, index) => {
                                const isLast = index === timelineSteps.length - 1;
                                const toolActionKey = `thinking.tool_actions.${step.toolName}`;
                                const toolActionName = t(toolActionKey);
                                const displayName =
                                  toolActionName !== toolActionKey ? toolActionName : step.toolName;
                                const icon = TOOL_ICONS[step.toolName] || '⚡';

                                return (
                                  <div key={index} className="relative flex items-start gap-3">
                                    {/* Timeline connector line */}
                                    {!isLast && (
                                      <div
                                        className="absolute left-[9px] top-6 w-[2px] h-full bg-border"
                                        style={{ height: 'calc(100% + 1rem)' }}
                                      />
                                    )}

                                    {/* Timeline dot */}
                                    <div className="relative z-10 flex-shrink-0 w-5 h-5 mt-0.5">
                                      <div className="w-5 h-5 rounded-full bg-primary border-2 border-surface" />
                                    </div>

                                    {/* Timeline content */}
                                    <div className="flex-1 min-w-0 pb-1">
                                      <div className="flex items-center gap-2 mb-1">
                                        <span className="text-sm font-medium text-text-primary">
                                          {displayName}
                                        </span>
                                        <span className="text-sm text-text-muted">
                                          {icon}×{step.count}
                                        </span>
                                      </div>
                                      {step.timestamp && (
                                        <div className="text-xs text-text-tertiary">
                                          {step.timestamp}
                                        </div>
                                      )}
                                    </div>
                                  </div>
                                );
                              })}
                            </div>
                          </div>
                        )}
                      </div>
                    )}

                    {/* Summary */}
                    <div className="rounded-lg border border-border bg-surface overflow-hidden">
                      <div className="border-b border-border bg-muted px-4 py-3">
                        <h3 className="text-base font-semibold text-text-primary">
                          {t('tasks:workbench.summary')}
                        </h3>
                        <div className="mt-1 flex items-center gap-2 text-sm text-text-muted">
                          <button
                            onClick={() => setShowCommits(!showCommits)}
                            className="inline-flex items-center gap-1 hover:text-text-primary transition-colors"
                          >
                            <span className="font-medium text-primary">
                              {displayData?.git_info?.task_commits?.length || 0}{' '}
                              {t('tasks:workbench.commits')}
                            </span>
                            <ChevronRightIcon
                              className={classNames(
                                showCommits ? 'rotate-90 transform' : '',
                                'h-4 w-4 transition-transform'
                              )}
                            />
                          </button>
                          <span>·</span>
                          <span>
                            {t('tasks:workbench.last_updated')}{' '}
                            {formatDateTime(displayData?.lastUpdated)}
                          </span>
                        </div>
                      </div>
                      {showCommits &&
                        displayData?.git_info?.task_commits &&
                        displayData.git_info.task_commits.length > 0 && (
                          <div className="border-b border-border bg-surface px-4 py-3">
                            <div className="space-y-2">
                              {displayData.git_info.task_commits.map((commit: GitCommit) => (
                                <div
                                  key={commit.commit_id}
                                  className="flex items-start gap-3 p-2 rounded-md hover:bg-muted/50 transition-colors"
                                >
                                  <div className="flex-1 min-w-0">
                                    <div className="flex items-center gap-2">
                                      <code className="text-xs font-mono text-primary bg-primary/10 px-2 py-0.5 rounded">
                                        {commit.short_id}
                                      </code>
                                      <button
                                        onClick={() => {
                                          navigator.clipboard.writeText(commit.commit_id);
                                          setCopiedCommitId(commit.commit_id);
                                          setTimeout(() => setCopiedCommitId(null), 2000);
                                        }}
                                        className="p-1 hover:bg-muted rounded transition-colors"
                                        title={t('tasks:workbench.copy_commit_id')}
                                      >
                                        {copiedCommitId === commit.commit_id ? (
                                          <CheckIcon className="h-4 w-4 text-green-600" />
                                        ) : (
                                          <ClipboardDocumentIcon className="h-4 w-4 text-text-muted" />
                                        )}
                                      </button>
                                    </div>
                                    <div className="mt-1 flex items-center gap-3 text-xs text-text-muted">
                                      <span>{commit.author}</span>
                                      <span>·</span>
                                      <span>
                                        {commit.stats.files_changed} {t('tasks:workbench.files')}, +
                                        {commit.stats.insertions} -{commit.stats.deletions}
                                      </span>
                                    </div>
                                  </div>
                                </div>
                              ))}
                            </div>
                          </div>
                        )}
                      <div className="px-4 py-4">
                        <div className="text-sm text-text-primary">
                          {displayData?.summary ? (
                            <MarkdownEditor.Markdown
                              source={displayData.summary}
                              style={{ background: 'transparent' }}
                              wrapperElement={{ 'data-color-mode': theme }}
                              components={{
                                a: ({ href, children, ...props }) => (
                                  <a
                                    href={href}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    {...props}
                                  >
                                    {children}
                                  </a>
                                ),
                              }}
                            />
                          ) : (
                            ''
                          )}
                        </div>
                      </div>
                    </div>

                    {/* Changes */}
                    {displayData?.changes && displayData.changes.length > 0 && (
                      <div className="rounded-lg border border-border bg-surface p-4">
                        <h3 className="text-base font-semibold text-text-primary mb-3">
                          {t('tasks:workbench.changes')}
                        </h3>
                        <ul className="space-y-2">
                          {displayData.changes.map((change: string, index: number) => (
                            <li
                              key={index}
                              className="flex items-start gap-2 text-sm text-text-primary"
                            >
                              <span className="text-text-muted mt-0.5">•</span>
                              <span>{change}</span>
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}

                    {/* Original Prompt */}
                    {displayData?.originalPrompt && (
                      <Disclosure>
                        {({ open }) => (
                          <div className="rounded-lg border border-border bg-surface overflow-hidden">
                            <DisclosureButton className="flex w-full items-center justify-between bg-muted px-4 py-3 text-left hover:bg-muted/80">
                              <span className="text-base font-semibold text-text-primary">
                                {t('tasks:workbench.original_prompt')}
                              </span>
                              <ChevronRightIcon
                                className={classNames(
                                  open ? 'rotate-90 transform' : '',
                                  'h-5 w-5 text-text-muted transition-transform'
                                )}
                              />
                            </DisclosureButton>
                            <DisclosurePanel className="border-t border-border px-4 py-4">
                              <div className="rounded-md bg-muted p-4">
                                <pre className="text-sm text-text-primary whitespace-pre-wrap font-mono">
                                  {displayData.originalPrompt}
                                </pre>
                              </div>
                            </DisclosurePanel>
                          </div>
                        )}
                      </Disclosure>
                    )}
                  </div>
                ) : (
                  // Files Changed Tab - with integrated diff support
                  <>
                    {isDiffLoading ? (
                      // Loading diff data
                      <div className="flex items-center justify-center h-64">
                        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary"></div>
                        <span className="ml-3 text-text-muted">
                          {t('tasks:workbench.loading_diff')}
                        </span>
                      </div>
                    ) : shouldShowDiffData() ? (
                      // Show diff data with expand/collapse
                      <DiffViewer
                        diffData={diffData}
                        isLoading={false}
                        gitType={displayData?.git_type || 'github'}
                        showDiffContent={true}
                      />
                    ) : displayData?.file_changes && displayData.file_changes.length > 0 ? (
                      // Show simple file changes without diff content, with error indicator if present
                      <div className="relative">
                        {diffLoadError && (
                          <div className="absolute top-0 right-0 z-10 p-2">
                            <button
                              onClick={() => setShowErrorDialog(true)}
                              className="text-red-600 hover:text-red-700 dark:text-red-400 dark:hover:text-red-300 transition-colors"
                              title={t('tasks:workbench.view_error_details')}
                            >
                              <ExclamationTriangleIcon className="w-5 h-5" />
                            </button>
                          </div>
                        )}
                        <DiffViewer
                          diffData={null}
                          isLoading={false}
                          gitType={displayData?.git_type || 'github'}
                          fileChanges={displayData.file_changes}
                          showDiffContent={false}
                        />
                      </div>
                    ) : (
                      // No changes found
                      <div className="rounded-lg border border-border bg-surface p-8 text-center">
                        <p className="text-text-muted">
                          {displayData?.status === 'completed'
                            ? t('tasks:workbench.no_changes_found')
                            : t('tasks:workbench.no_file_changes')}
                        </p>
                      </div>
                    )}
                  </>
                )}
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Error Details Dialog */}
      <Dialog
        open={showErrorDialog}
        onClose={() => setShowErrorDialog(false)}
        className="relative z-50"
      >
        <div className="fixed inset-0 bg-black/30" aria-hidden="true" />
        <div className="fixed inset-0 flex items-center justify-center p-4">
          <DialogPanel className="mx-auto max-w-2xl w-full rounded-lg bg-surface border border-border shadow-xl">
            <div className="flex items-center justify-between border-b border-border px-6 py-4">
              <DialogTitle className="text-lg font-semibold text-text-primary flex items-center gap-2">
                <ExclamationTriangleIcon className="w-5 h-5 text-red-600" />
                {t('tasks:workbench.error_details')}
              </DialogTitle>
              <button
                onClick={() => setShowErrorDialog(false)}
                className="rounded-md p-1 hover:bg-muted transition-colors"
              >
                <XMarkIcon className="w-5 h-5 text-text-muted" />
              </button>
            </div>
            <div className="px-6 py-4">
              <div className="rounded-md bg-red-50 dark:bg-red-900/10 border border-red-200 dark:border-red-800 p-4">
                <pre className="text-sm text-red-800 dark:text-red-200 whitespace-pre-wrap font-mono overflow-x-auto">
                  {diffLoadError}
                </pre>
              </div>
            </div>
            <div className="flex justify-end gap-3 border-t border-border px-6 py-4">
              <button
                onClick={() => setShowErrorDialog(false)}
                className="px-4 py-2 text-sm font-medium text-text-primary bg-muted hover:bg-muted/80 rounded-md transition-colors"
              >
                {t('tasks:workbench.close_panel')}
              </button>
              <button
                onClick={() => {
                  setShowErrorDialog(false);
                  setDiffLoadError(null);
                  setDiffData(null);
                  loadDiffData();
                }}
                className="px-4 py-2 text-sm font-medium text-white bg-primary hover:bg-primary/90 rounded-md transition-colors"
              >
                {t('tasks:workbench.retry')}
              </button>
            </div>
          </DialogPanel>
        </div>
      </Dialog>

      {/* Toggle button - fixed position - hidden on mobile */}
    </>
  );
}
