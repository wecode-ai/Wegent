// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useEffect, useState, useRef } from 'react'
import { Disclosure, DisclosureButton, DisclosurePanel } from '@headlessui/react'
import {
  Bars3Icon,
  CheckIcon,
  ChevronRightIcon,
  ClipboardDocumentIcon,
  XMarkIcon,
} from '@heroicons/react/24/outline'
import EnhancedMarkdown from '@/components/common/EnhancedMarkdown'
import { useTheme } from '@/features/theme/ThemeProvider'
import { useTranslation } from '@/hooks/useTranslation'
import type { TaskApp, TaskFileChanges, WorkbenchData } from '@/types/api'
import WorkbenchFiles from './WorkbenchFiles'
import type { MessageBlock } from '../message/thinking/types'

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
}

interface WorkbenchProps {
  isOpen: boolean
  onClose: () => void
  onOpen: () => void
  workbenchData?: WorkbenchData | null
  repository?: string
  fileChanges?: TaskFileChanges | null
  isLoading?: boolean
  taskTitle?: string
  taskNumber?: string
  blocks?: MessageBlock[] | null
  app?: TaskApp | null
  taskStatus?:
    | 'PENDING'
    | 'RUNNING'
    | 'COMPLETED'
    | 'FAILED'
    | 'CANCELLED'
    | 'CANCELLING'
    | 'DELETE'
    | 'PENDING_CONFIRMATION'
    | null
}

type WorkbenchDisplayStatus = 'running' | 'completed' | 'failed' | 'pending_confirmation'

function classNames(...classes: string[]) {
  return classes.filter(Boolean).join(' ')
}

function formatDateTime(dateString: string | undefined): string {
  if (!dateString) return ''

  try {
    const date = new Date(dateString)
    const year = date.getFullYear()
    const month = String(date.getMonth() + 1).padStart(2, '0')
    const day = String(date.getDate()).padStart(2, '0')
    const hours = String(date.getHours()).padStart(2, '0')
    const minutes = String(date.getMinutes()).padStart(2, '0')
    const seconds = String(date.getSeconds()).padStart(2, '0')

    return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`
  } catch (_error) {
    return dateString
  }
}

export default function Workbench({
  isOpen,
  onClose,
  onOpen: _onOpen,
  workbenchData,
  repository,
  fileChanges,
  isLoading = false,
  taskTitle,
  taskNumber,
  blocks,
  app,
  taskStatus,
}: WorkbenchProps) {
  const [activeTab, setActiveTab] = useState<'overview' | 'files' | 'preview'>('overview')
  const [showCommits, setShowCommits] = useState(false)
  const [copiedCommitId, setCopiedCommitId] = useState<string | null>(null)
  const [loadingStateIndex, setLoadingStateIndex] = useState(0)
  const [tipIndex, setTipIndex] = useState(0)
  const [isTimelineExpanded, setIsTimelineExpanded] = useState(false) // Timeline collapse state
  const prevAppRef = useRef<TaskApp | null | undefined>(undefined) // Track previous app state
  const { theme } = useTheme()
  const { t } = useTranslation('tasks')

  const hasBlocks = Boolean(blocks && blocks.length > 0)
  const displayData = workbenchData

  const getDisplayStatus = (): WorkbenchDisplayStatus | null => {
    switch (taskStatus) {
      case 'COMPLETED':
        return 'completed'
      case 'FAILED':
      case 'CANCELLED':
      case 'DELETE':
        return 'failed'
      case 'PENDING_CONFIRMATION':
        return 'pending_confirmation'
      case 'PENDING':
      case 'RUNNING':
      case 'CANCELLING':
        return 'running'
      default:
        return displayData?.status || null
    }
  }

  const displayStatus = getDisplayStatus()

  const shouldShowLoading = isLoading && !displayData && !hasBlocks && !fileChanges

  // Loading state rotation (4 seconds)
  useEffect(() => {
    if (shouldShowLoading) {
      const loadingStates = t('tasks:workbench.loading_states', {
        returnObjects: true,
      }) as string[]
      const interval = setInterval(() => {
        setLoadingStateIndex(prev => (prev + 1) % loadingStates.length)
      }, 4000)
      return () => clearInterval(interval)
    }
  }, [shouldShowLoading, t])

  // Tips rotation (6 seconds, random)
  useEffect(() => {
    if (shouldShowLoading) {
      const tips = t('tasks:workbench.tips', { returnObjects: true }) as string[]
      const interval = setInterval(() => {
        setTipIndex(Math.floor(Math.random() * tips.length))
      }, 6000)
      return () => clearInterval(interval)
    }
  }, [shouldShowLoading, t])

  const navigation = [
    {
      name: t('tasks:workbench.overview'),
      value: 'overview' as const,
      current: activeTab === 'overview',
    },
    // Files Changed tab - always shown for code tasks
    {
      name: t('tasks:workbench.files_changed'),
      value: 'files' as const,
      current: activeTab === 'files',
      badge: fileChanges ? fileChanges.files.length : displayData?.file_changes?.length || 0,
    },
    // Preview tab - only shown when app data is available
    ...(app
      ? [
          {
            name: t('common:appPreview.button'),
            value: 'preview' as const,
            current: activeTab === 'preview',
          },
        ]
      : []),
  ]

  const getStatusColor = () => {
    switch (displayStatus) {
      case 'completed':
        return 'text-green-600'
      case 'failed':
        return 'text-red-600'
      case 'pending_confirmation':
        return 'text-yellow-600'
      default:
        return 'text-yellow-600'
    }
  }

  const getStatusText = () => {
    switch (displayStatus) {
      case 'completed':
        return t('tasks:workbench.status.completed')
      case 'failed':
        return t('tasks:workbench.status.failed')
      case 'pending_confirmation':
        return t('tasks:workbench.status.pending_confirmation')
      default:
        return t('tasks:workbench.status.running')
    }
  }

  const getFallbackStatusDisplay = () => {
    switch (taskStatus) {
      case 'COMPLETED':
        return {
          color: 'text-green-600',
          icon: 'success' as const,
          text: t('tasks:workbench.status.completed'),
        }
      case 'FAILED':
      case 'CANCELLED':
      case 'DELETE':
        return {
          color: 'text-red-600',
          icon: 'failed' as const,
          text: t('tasks:workbench.status.failed'),
        }
      case 'PENDING':
      case 'RUNNING':
      case 'CANCELLING':
        return {
          color: 'text-yellow-600',
          icon: 'running' as const,
          text: t('tasks:workbench.status.running'),
        }
      case 'PENDING_CONFIRMATION':
        return {
          color: 'text-yellow-600',
          icon: 'success' as const,
          text: t('tasks:workbench.status.pending_confirmation'),
        }
      default:
        return null
    }
  }

  // Timeline item for expanded view (each tool call shown individually)
  interface TimelineItem {
    toolName: string
    timestamp: string
    id: string
  }

  // Timeline step for collapsed summary (aggregated by tool)
  interface TimelineStep {
    toolName: string
    count: number
  }

  // Build timeline items from blocks (each tool call shown individually)
  const buildTimelineItems = (messageBlocks: MessageBlock[]): TimelineItem[] => {
    if (!messageBlocks || messageBlocks.length === 0) return []

    // Filter only tool blocks and map to timeline items
    const toolBlocks = messageBlocks.filter(block => block.type === 'tool')

    return toolBlocks.map(block => {
      const toolName = block.display_name || block.tool_name || 'Unknown'
      let timestamp = ''
      if (block.timestamp) {
        timestamp = new Date(block.timestamp).toLocaleTimeString('en-US', {
          hour12: false,
        })
      }
      return {
        toolName,
        timestamp,
        id: block.id,
      }
    })
  }

  // Build aggregated timeline summary for collapsed view
  const buildTimelineSummary = (items: TimelineItem[]): TimelineStep[] => {
    if (items.length === 0) return []

    const summary: TimelineStep[] = []
    let currentTool: string | null = null
    let currentCount = 0

    items.forEach(item => {
      if (item.toolName === currentTool) {
        currentCount++
      } else {
        if (currentTool) {
          summary.push({ toolName: currentTool, count: currentCount })
        }
        currentTool = item.toolName
        currentCount = 1
      }
    })

    if (currentTool) {
      summary.push({ toolName: currentTool, count: currentCount })
    }

    return summary
  }

  const timelineItems = blocks ? buildTimelineItems(blocks) : []
  const timelineSummary = buildTimelineSummary(timelineItems)
  const fallbackStatusDisplay = getFallbackStatusDisplay()

  // Auto-collapse timeline when task is completed
  useEffect(() => {
    if (displayStatus === 'completed' && timelineItems.length > 0) {
      setIsTimelineExpanded(false)
    }
  }, [displayStatus, timelineItems.length])

  // Auto-switch to preview tab when app data first becomes available
  useEffect(() => {
    // Check if app just became available (was null/undefined, now has value)
    if (!prevAppRef.current && app) {
      setActiveTab('preview')
    }
    // Update the ref to track current app state
    prevAppRef.current = app
  }, [app])

  // Generate collapsed timeline summary (aggregated view)
  const getTimelineSummaryText = (): string => {
    if (timelineSummary.length === 0) return ''

    const summaryParts: string[] = []
    timelineSummary.forEach(step => {
      const icon = TOOL_ICONS[step.toolName] || '⚡'
      summaryParts.push(`${icon}×${step.count}`)
    })

    return summaryParts.join(' ')
  }

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
                {shouldShowLoading ? (
                  // Loading state - no workbench data and no blocks
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
                    {/* Task Title - use displayData or props */}
                    <div className="flex items-baseline gap-2">
                      <h2 className="text-lg font-semibold text-text-primary">
                        {displayData?.taskTitle || taskTitle || ''}
                      </h2>
                      <span className="text-sm text-text-muted">
                        {displayData?.taskNumber || taskNumber || ''}
                      </span>
                    </div>

                    {/* Status Badge - only show when displayData is available */}
                    {displayData && (
                      <div className="flex items-center gap-3">
                        <span
                          className={classNames(
                            getStatusColor(),
                            'inline-flex items-center gap-2 rounded-full px-3 py-1 text-sm font-medium bg-muted'
                          )}
                        >
                          {displayStatus === 'running' ? (
                            <div className="animate-spin rounded-full h-4 w-4 border-[2px] border-current border-t-transparent"></div>
                          ) : displayStatus === 'failed' ? (
                            <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 16 16">
                              <path d="M8 16A8 8 0 1 1 8 0a8 8 0 0 1 0 16zM5.354 4.646a.5.5 0 1 0-.708.708L7.293 8l-2.647 2.646a.5.5 0 0 0 .708.708L8 8.707l2.646 2.647a.5.5 0 0 0 .708-.708L8.707 8l2.647-2.646a.5.5 0 0 0-.708-.708L8 7.293 5.354 4.646z" />
                            </svg>
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
                    )}

                    {/* Status indicator - show when no displayData, use taskStatus prop */}
                    {!displayData && !shouldShowLoading && fallbackStatusDisplay && (
                      <div className="flex items-center gap-3">
                        {fallbackStatusDisplay.icon === 'success' ? (
                          <span
                            className={classNames(
                              fallbackStatusDisplay.color,
                              'inline-flex items-center gap-2 rounded-full px-3 py-1 text-sm font-medium bg-muted'
                            )}
                          >
                            <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 16 16">
                              <path d="M8 16A8 8 0 1 1 8 0a8 8 0 0 1 0 16zm3.78-9.72a.75.75 0 0 0-1.06-1.06L6.75 9.19 5.28 7.72a.75.75 0 0 0-1.06 1.06l2 2a.75.75 0 0 0 1.06 0l4.5-4.5z" />
                            </svg>
                            {fallbackStatusDisplay.text}
                          </span>
                        ) : fallbackStatusDisplay.icon === 'failed' ? (
                          <span
                            className={classNames(
                              fallbackStatusDisplay.color,
                              'inline-flex items-center gap-2 rounded-full px-3 py-1 text-sm font-medium bg-muted'
                            )}
                          >
                            <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 16 16">
                              <path d="M8 16A8 8 0 1 1 8 0a8 8 0 0 1 0 16zM5.354 4.646a.5.5 0 1 0-.708.708L7.293 8l-2.647 2.646a.5.5 0 0 0 .708.708L8 8.707l2.646 2.647a.5.5 0 0 0 .708-.708L8.707 8l2.647-2.646a.5.5 0 0 0-.708-.708L8 7.293 5.354 4.646z" />
                            </svg>
                            {fallbackStatusDisplay.text}
                          </span>
                        ) : (
                          <span
                            className={classNames(
                              fallbackStatusDisplay.color,
                              'inline-flex items-center gap-2 rounded-full px-3 py-1 text-sm font-medium bg-muted'
                            )}
                          >
                            <div className="animate-spin rounded-full h-4 w-4 border-[2px] border-current border-t-transparent"></div>
                            {fallbackStatusDisplay.text}
                          </span>
                        )}
                      </div>
                    )}

                    {/* Repository Info - only show when displayData is available */}
                    {displayData && (
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
                          ) : displayStatus === 'running' ? (
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
                    )}

                    {/* Execution Timeline */}
                    {timelineItems.length > 0 && (
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
                              {getTimelineSummaryText()}
                            </div>
                          )}
                        </button>
                        {isTimelineExpanded && (
                          <div className="px-4 py-4">
                            <div className="relative space-y-4">
                              {timelineItems.map((item, index) => {
                                const isLast = index === timelineItems.length - 1
                                const toolActionKey = `thinking.tool_actions.${item.toolName}`
                                const toolActionName = t(toolActionKey)
                                const displayName =
                                  toolActionName !== toolActionKey ? toolActionName : item.toolName
                                const icon = TOOL_ICONS[item.toolName] || '⚡'

                                return (
                                  <div key={item.id} className="relative flex items-start gap-3">
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
                                        <span className="text-sm text-text-muted">{icon}</span>
                                        <span className="text-sm font-medium text-text-primary">
                                          {displayName}
                                        </span>
                                      </div>
                                      {item.timestamp && (
                                        <div className="text-xs text-text-tertiary">
                                          {item.timestamp}
                                        </div>
                                      )}
                                    </div>
                                  </div>
                                )
                              })}
                            </div>
                          </div>
                        )}
                      </div>
                    )}

                    {/* Summary - only show when displayData is available */}
                    {displayData && (
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
                                {displayData.git_info.task_commits.map(commit => (
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
                                            navigator.clipboard.writeText(commit.commit_id)
                                            setCopiedCommitId(commit.commit_id)
                                            setTimeout(() => setCopiedCommitId(null), 2000)
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
                                          {commit.stats.files_changed} {t('tasks:workbench.files')},
                                          +{commit.stats.insertions} -{commit.stats.deletions}
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
                              <EnhancedMarkdown
                                source={displayData.summary}
                                theme={theme}
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
                    )}

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
                ) : activeTab === 'files' ? (
                  <WorkbenchFiles
                    key={taskNumber}
                    taskKey={taskNumber || ''}
                    repository={repository || displayData?.repository}
                    fileChanges={fileChanges}
                    workbenchData={displayData}
                    isCompleted={displayStatus === 'completed'}
                  />
                ) : activeTab === 'preview' && app ? (
                  // Preview Tab - iframe for app preview
                  <div className="h-full flex flex-col -mx-2 -mb-2 sm:-mx-3 lg:-mx-4">
                    <div className="flex-1 min-h-0">
                      <iframe
                        src={app.previewUrl}
                        title={app.name || t('common:appPreview.title')}
                        className="w-full h-full border-0"
                        style={{ minHeight: 'calc(100vh - 180px)' }}
                        sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-modals"
                      />
                    </div>
                  </div>
                ) : null}
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Toggle button - fixed position - hidden on mobile */}
    </>
  )
}
