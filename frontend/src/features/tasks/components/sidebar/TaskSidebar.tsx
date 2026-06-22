// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import './task-list-scrollbar.css'
import React, { useRef, useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import Image from 'next/image'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { paths } from '@/config/paths'
import { getCodingNavItem, openNavigationHref } from '@/config/coding-route'
import {
  Plus,
  X,
  PanelLeftClose,
  PanelLeftOpen,
  Code,
  BookOpen,
  Workflow,
  ChevronRight,
  Monitor,
  Inbox,
  Library,
  LayoutGrid,
  Zap,
} from 'lucide-react'
import { useTaskSession } from '@/features/tasks/session/TaskSession'
import TaskListSection from './TaskListSection'
import TaskHistorySection from './TaskHistorySection'
import FixedGroupChatsSection from './FixedGroupChatsSection'
import { useTranslation } from '@/hooks/useTranslation'
import MobileSidebar from '@/features/layout/MobileSidebar'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { UserFloatingMenu } from '@/features/layout/components/UserFloatingMenu'
import HistoryManageDialog from './HistoryManageDialog'
import { TaskDndProvider } from '@/features/projects'
import { useInboxUnreadCount } from '@/features/inbox'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown'

export const SIDEBAR_NAV_CONFIG = {
  keepSecondaryNavFixed: true,
}

interface TaskSidebarProps {
  isMobileSidebarOpen: boolean
  setIsMobileSidebarOpen: (open: boolean) => void
  pageType?: 'chat' | 'code' | 'flow' | 'knowledge' | 'devices' | 'inbox' | 'resource-library'
  isCollapsed?: boolean
  onToggleCollapsed?: () => void
  // Search dialog control from parent (for global shortcut support)
  isSearchDialogOpen?: boolean
  onSearchDialogOpenChange?: (open: boolean) => void
  shortcutDisplayText?: string
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
  const { t } = useTranslation()
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const {
    tasks,
    groupTasks,
    personalTasks,
    loadMore,
    loadAllGroupTasks,
    loadMorePersonalTasks,
    loadingMore,
    loadingMoreGroupTasks,
    loadingMorePersonalTasks,
    hasMoreGroupTasks,
    hasMorePersonalTasks,
    searchTerm: _searchTerm,
    setSearchTerm,
    searchTasks,
    isSearching,
    isSearchResult,
    getUnreadCount,
    markAllTasksAsViewed,
    viewStatusVersion,
    selectTask,
    isRefreshing,
  } = useTaskSession()
  const desktopScrollRef = useRef<HTMLDivElement>(null)
  const mobileScrollRef = useRef<HTMLDivElement>(null)
  const moreNavCloseTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Inbox unread count
  const { unreadCount: inboxUnreadCount } = useInboxUnreadCount()

  // Use external state for search dialog (controlled by parent page)
  const setIsSearchDialogOpen = onSearchDialogOpenChange ?? (() => {})

  // Group chats collapse/expand state
  const [isGroupChatsExpanded, setIsGroupChatsExpanded] = useState(false)
  const [openMoreNavigationId, setOpenMoreNavigationId] = useState<'desktop' | 'mobile' | null>(
    null
  )

  // History manage dialog state
  const [isHistoryManageDialogOpen, setIsHistoryManageDialogOpen] = useState(false)

  // Use external shortcut display text from parent
  const shortcutDisplayText = externalShortcutDisplayText ?? ''

  // Clear search for sidebar (used when clearing search results)
  const handleClearSearch = () => {
    setSearchTerm('')
    searchTasks('')
  }

  const clearMoreNavCloseTimer = () => {
    if (moreNavCloseTimerRef.current) {
      clearTimeout(moreNavCloseTimerRef.current)
      moreNavCloseTimerRef.current = null
    }
  }

  const openMoreNavigation = (menuId: 'desktop' | 'mobile') => {
    clearMoreNavCloseTimer()
    setOpenMoreNavigationId(menuId)
  }

  const scheduleCloseMoreNavigation = () => {
    clearMoreNavCloseTimer()
    moreNavCloseTimerRef.current = setTimeout(() => {
      setOpenMoreNavigationId(null)
      moreNavCloseTimerRef.current = null
    }, 160)
  }

  // Open search dialog (controlled by parent)
  const handleOpenSearchDialog = () => {
    setIsSearchDialogOpen(true)
  }
  // Navigation buttons - always show all buttons
  // Define type explicitly to include all possible buttonPageType values
  type ButtonPageType =
    | 'chat'
    | 'code'
    | 'flow'
    | 'knowledge'
    | 'devices'
    | 'inbox'
    | 'resource-library'
    | 'wework'
  interface NavigationButton {
    label: string
    icon: typeof Workflow
    path: string
    isActive: boolean
    tooltip?: string
    buttonPageType: ButtonPageType
    unreadCount?: number
    testId?: string
  }

  const currentPath = pathname ?? ''
  const resourceLibraryPath = paths.resourceLibrary?.getHref?.() ?? '/resource-library'
  const codingNavItem = getCodingNavItem()
  const isCodeAgentActive =
    !codingNavItem.external &&
    currentPath === paths.chat.getHref() &&
    searchParams.get('agent') === 'code'

  const navigationButtons: NavigationButton[] = [
    {
      label: t('common:navigation.flow'),
      icon: Workflow,
      path: paths.feed.getHref(),
      isActive: pageType === 'flow',
      buttonPageType: 'flow',
    },
    {
      label: t(codingNavItem.labelKey),
      icon: codingNavItem.key === 'wework' ? Zap : Code,
      path: codingNavItem.href,
      isActive: pageType === 'code' || isCodeAgentActive,
      tooltip: pageType === 'code' ? t('common:tasks.new_task') : undefined,
      buttonPageType: codingNavItem.key,
    },
    {
      label: t('common:navigation.wiki'),
      icon: BookOpen,
      path: paths.wiki.getHref(),
      isActive: pageType === 'knowledge',
      buttonPageType: 'knowledge',
    },
    {
      label: t('resource-library:title'),
      icon: Library,
      path: resourceLibraryPath,
      isActive: pageType === 'resource-library' || currentPath === resourceLibraryPath,
      buttonPageType: 'resource-library',
      testId: 'resource-library-sidebar-button',
    },
    {
      label: t('devices:my_devices'),
      icon: Monitor,
      path: paths.devices.getHref(),
      isActive: pageType === 'devices',
      buttonPageType: 'devices',
    },
    {
      label: t('common:navigation.inbox'),
      icon: Inbox,
      path: paths.inbox.getHref(),
      isActive: pageType === 'inbox',
      buttonPageType: 'inbox',
      unreadCount: inboxUnreadCount,
    },
  ]

  // New conversation - always navigate to chat page
  const handleNewAgentClick = () => {
    // IMPORTANT: Clear selected task FIRST to ensure UI state is reset immediately
    // This prevents the UI from being stuck showing the previous task's messages
    selectTask(null)

    if (typeof window !== 'undefined') {
      // Always navigate to chat page for new conversation
      router.replace(paths.chat.getHref())
    }
    // Close mobile sidebar after navigation
    setIsMobileSidebarOpen(false)
  }

  // Handle navigation button click - reset the current task session when re-entering a page
  const handleNavigationClick = (path: string, isActive: boolean, buttonPageType?: string) => {
    const isExternalNavigation = buttonPageType === 'wework'

    if (isActive) {
      // IMPORTANT: Clear selected task FIRST to ensure UI state is reset immediately
      selectTask(null)

      // For knowledge page, dispatch event to clear selected KB and return to homepage
      if (buttonPageType === 'knowledge' && typeof window !== 'undefined') {
        window.dispatchEvent(new CustomEvent('knowledge-clear-selection'))
      }

      if (isExternalNavigation) {
        openNavigationHref(router, path)
      } else {
        router.replace(path)
      }
    } else {
      openNavigationHref(router, path)
    }
    setIsMobileSidebarOpen(false)
  }

  // Mark all tasks as viewed
  const handleMarkAllAsViewed = () => {
    markAllTasksAsViewed()
  }

  // Calculate total unread count
  // Include viewStatusVersion in dependencies to recalculate when view status changes
  const totalUnreadCount = React.useMemo(() => {
    return getUnreadCount(tasks)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tasks, getUnreadCount, viewStatusVersion])

  // Scroll to bottom to load more (legacy - for search results)
  useEffect(() => {
    const el = desktopScrollRef.current
    if (!el) return
    const handleScroll = () => {
      if (el.scrollTop + el.clientHeight >= el.scrollHeight - 10) {
        loadMore()
      }
    }
    el.addEventListener('scroll', handleScroll)
    return () => el.removeEventListener('scroll', handleScroll)
  }, [loadMore])

  useEffect(() => {
    const el = mobileScrollRef.current
    if (!el) return
    const handleScroll = () => {
      if (el.scrollTop + el.clientHeight >= el.scrollHeight - 10) {
        loadMore()
      }
    }
    el.addEventListener('scroll', handleScroll)
    return () => el.removeEventListener('scroll', handleScroll)
  }, [loadMore])

  useEffect(() => {
    return () => clearMoreNavCloseTimer()
  }, [])

  const fixedNavigationButtons = navigationButtons.filter(
    btn =>
      btn.buttonPageType === 'flow' ||
      btn.buttonPageType === 'code' ||
      btn.buttonPageType === 'wework' ||
      btn.buttonPageType === 'knowledge'
  )
  const moreNavigationButtons = navigationButtons.filter(
    btn =>
      btn.buttonPageType !== 'flow' &&
      btn.buttonPageType !== 'code' &&
      btn.buttonPageType !== 'wework' &&
      btn.buttonPageType !== 'knowledge'
  )
  const fixedSecondaryNavigationButtons = SIDEBAR_NAV_CONFIG.keepSecondaryNavFixed
    ? moreNavigationButtons
    : []
  const scrollableNavigationButtons = SIDEBAR_NAV_CONFIG.keepSecondaryNavFixed
    ? []
    : moreNavigationButtons

  const renderNavigationButtons = (buttons: NavigationButton[]) => {
    if (isCollapsed || buttons.length === 0) return null

    return (
      <div className="space-y-0.5">
        {buttons.map(btn => (
          <div key={btn.path} className="relative group">
            <Button
              variant="ghost"
              onClick={() => handleNavigationClick(btn.path, btn.isActive, btn.buttonPageType)}
              data-testid={btn.testId ?? `task-sidebar-nav-${btn.buttonPageType}-button`}
              className={`w-full justify-start px-3 h-11 min-w-[44px] text-sm rounded-md transition-all duration-200 lg:h-8 ${
                btn.isActive
                  ? 'bg-primary/10 text-primary font-medium hover:bg-primary/15'
                  : 'text-text-primary hover:bg-[rgb(238,238,238)] dark:hover:bg-white/10'
              }`}
              size="sm"
            >
              <span className="flex min-w-0 flex-1 items-center justify-start gap-2.5 text-left">
                <btn.icon
                  className={`h-4 w-4 flex-shrink-0 ${btn.isActive ? 'text-primary' : ''}`}
                />
                <span
                  className={`min-w-0 truncate text-[14px] leading-5 font-medium ${
                    btn.isActive ? 'text-primary' : 'text-text-primary'
                  }`}
                >
                  {btn.label}
                </span>
              </span>
              {btn.unreadCount !== undefined && btn.unreadCount > 0 && (
                <span className="ml-auto flex items-center justify-center min-w-[18px] h-[18px] px-1.5 text-[11px] font-medium bg-red-500 text-white rounded-full">
                  {btn.unreadCount > 99 ? '99+' : btn.unreadCount}
                </span>
              )}
            </Button>
            {btn.isActive && btn.tooltip && (
              <div className="absolute right-1 top-1/2 -translate-y-1/2 opacity-0 group-hover:opacity-100 transition-opacity duration-200">
                <TooltipProvider>
                  <Tooltip delayDuration={0}>
                    <TooltipTrigger asChild>
                      <button
                        type="button"
                        data-testid={`new-${btn.buttonPageType}-button`}
                        onClick={e => {
                          e.stopPropagation()
                          handleNavigationClick(btn.path, btn.isActive, btn.buttonPageType)
                        }}
                        className="flex h-11 min-w-[44px] items-center gap-1 px-2 text-xs bg-primary text-white rounded-md hover:bg-primary/90 transition-colors lg:h-8"
                      >
                        <Plus className="h-3 w-3" />
                        <span>{t('common:tasks.new_task')}</span>
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
    )
  }

  const renderMoreNavigationButton = (
    buttons: NavigationButton[],
    menuId: 'desktop' | 'mobile'
  ) => {
    if (isCollapsed || buttons.length === 0) return null

    const hasActiveItem = buttons.some(btn => btn.isActive)
    const unreadCount = buttons.reduce((total, btn) => total + (btn.unreadCount ?? 0), 0)

    return (
      <DropdownMenu
        modal={false}
        open={openMoreNavigationId === menuId}
        onOpenChange={open => setOpenMoreNavigationId(open ? menuId : null)}
      >
        <div
          onMouseEnter={() => openMoreNavigation(menuId)}
          onMouseLeave={scheduleCloseMoreNavigation}
        >
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              data-testid="task-sidebar-more-button"
              onFocus={() => openMoreNavigation(menuId)}
              className={`w-full justify-start px-3 h-11 min-w-[44px] text-sm rounded-md transition-all duration-200 lg:h-8 ${
                hasActiveItem
                  ? 'bg-primary/10 text-primary font-medium hover:bg-primary/15'
                  : 'text-text-primary hover:bg-[rgb(238,238,238)] dark:hover:bg-white/10'
              }`}
              size="sm"
            >
              <span className="flex min-w-0 flex-1 items-center justify-start gap-2.5 text-left">
                <LayoutGrid
                  aria-label="More navigation"
                  className={`h-4 w-4 flex-shrink-0 ${hasActiveItem ? 'text-primary' : ''}`}
                />
                <span
                  className={`min-w-0 truncate text-[14px] leading-5 font-medium ${
                    hasActiveItem ? 'text-primary' : 'text-text-primary'
                  }`}
                >
                  {t('common:navigation.more')}
                </span>
              </span>
              <span className="ml-auto flex items-center gap-1">
                {unreadCount > 0 && (
                  <span className="flex items-center justify-center min-w-[18px] h-[18px] px-1.5 text-[11px] font-medium bg-red-500 text-white rounded-full">
                    {unreadCount > 99 ? '99+' : unreadCount}
                  </span>
                )}
                <ChevronRight
                  className={`h-3.5 w-3.5 flex-shrink-0 ${hasActiveItem ? 'text-primary' : 'text-text-muted'}`}
                />
              </span>
            </Button>
          </DropdownMenuTrigger>
        </div>
        <DropdownMenuContent
          side="right"
          align="start"
          sideOffset={8}
          className="w-44 bg-base p-1"
          data-testid="task-sidebar-more-flyout"
          onMouseEnter={() => openMoreNavigation(menuId)}
          onMouseLeave={scheduleCloseMoreNavigation}
          onCloseAutoFocus={event => event.preventDefault()}
        >
          {buttons.map(btn => (
            <DropdownMenuItem
              key={btn.path}
              data-testid={`task-sidebar-more-${btn.buttonPageType}-button`}
              className={`h-11 min-w-[44px] gap-2 px-2 text-sm lg:h-8 ${
                btn.isActive
                  ? 'bg-primary/10 text-primary font-medium focus:bg-primary/15'
                  : 'text-text-primary focus:bg-[rgb(238,238,238)] dark:focus:bg-white/10'
              }`}
              onSelect={() => {
                handleNavigationClick(btn.path, btn.isActive, btn.buttonPageType)
                setOpenMoreNavigationId(null)
              }}
            >
              <btn.icon className={`h-4 w-4 flex-shrink-0 ${btn.isActive ? 'text-primary' : ''}`} />
              <span className="flex-1 text-[14px] leading-5 font-medium">{btn.label}</span>
              {btn.unreadCount !== undefined && btn.unreadCount > 0 && (
                <span className="flex items-center justify-center min-w-[18px] h-[18px] px-1.5 text-[11px] font-medium bg-red-500 text-white rounded-full">
                  {btn.unreadCount > 99 ? '99+' : btn.unreadCount}
                </span>
              )}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    )
  }

  const createFixedSectionWheelHandler =
    (scrollContainerRef: React.RefObject<HTMLDivElement | null>) =>
    (event: React.WheelEvent<HTMLDivElement>) => {
      const scrollContainer = scrollContainerRef.current
      if (!scrollContainer) return

      scrollContainer.scrollTop += event.deltaY
      event.preventDefault()
    }

  const renderSidebarContent = (
    scrollContainerRef: React.RefObject<HTMLDivElement | null>,
    menuId: 'desktop' | 'mobile'
  ) => (
    <>
      <TaskDndProvider>
        <div
          className="flex-1 min-h-0 overflow-y-auto task-list-scrollbar"
          ref={scrollContainerRef}
          data-testid="task-sidebar-scroll-container"
        >
          <div
            className="sticky top-0 z-20 bg-base"
            data-testid="task-sidebar-fixed-section"
            onWheel={createFixedSectionWheelHandler(scrollContainerRef)}
          >
            {/* Logo and Mode Indicator - matches Figma: left-[20px] top-[12px] */}
            <div
              className={`${isCollapsed ? 'px-2' : 'px-5'} pt-2 pb-1.5`}
              data-testid="task-sidebar-logo-section"
            >
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
                          type="button"
                          data-testid="new-agent-button"
                          onClick={e => {
                            e.stopPropagation()
                            handleNewAgentClick()
                          }}
                          className="flex h-11 min-w-[44px] flex-shrink-0 items-center justify-center lg:h-8"
                          aria-label={t('common:tasks.new_conversation')}
                        >
                          <Plus className="h-4 w-4 text-text-primary" />
                        </button>
                      </div>
                    </TooltipTrigger>
                    <TooltipContent side="right">
                      <p>{t('common:sidebar.expand')}</p>
                    </TooltipContent>
                  </Tooltip>
                </TooltipProvider>
              ) : (
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <Image
                      src="/weibo-logo.png"
                      alt="Weibo Logo"
                      width={36}
                      height={35}
                      className="object-contain"
                      priority
                    />
                    <span className="text-base font-semibold text-text-primary">Wegent</span>
                  </div>
                  {onToggleCollapsed && (
                    <TooltipProvider>
                      <Tooltip delayDuration={300}>
                        <TooltipTrigger asChild>
                          <Button
                            variant="ghost"
                            size="icon"
                            onClick={onToggleCollapsed}
                            data-testid="collapse-sidebar-button"
                            className="h-11 min-w-[44px] w-11 p-0 text-text-muted hover:text-text-primary hover:bg-hover rounded-lg lg:h-10 lg:w-10 lg:min-w-10"
                            aria-label={t('common:sidebar.collapse')}
                          >
                            <PanelLeftClose className="h-4 w-4" />
                          </Button>
                        </TooltipTrigger>
                        <TooltipContent side="right">
                          <p>{t('common:sidebar.collapse')}</p>
                        </TooltipContent>
                      </Tooltip>
                    </TooltipProvider>
                  )}
                </div>
              )}
            </div>

            {/* New Conversation Button and Fixed Navigation Buttons */}
            <div data-tour="mode-toggle" className="px-2.5">
              {!isCollapsed && (
                <div className="mb-0.5">
                  <Button
                    variant="ghost"
                    onClick={handleNewAgentClick}
                    data-testid="new-agent-button"
                    className="w-full justify-start px-3 h-11 min-w-[44px] text-sm text-text-primary hover:bg-[rgb(238,238,238)] dark:hover:bg-white/10 rounded-md group transition-all duration-200 lg:h-8"
                    size="sm"
                  >
                    <span className="flex min-w-0 flex-1 items-center justify-start gap-2.5 text-left">
                      <Plus className="h-4 w-4 flex-shrink-0" />
                      <span className="min-w-0 truncate text-[14px] leading-5 font-medium text-text-primary">
                        {t('common:tasks.new_conversation')}
                      </span>
                    </span>
                    <span className="ml-auto text-text-muted opacity-0 group-hover:opacity-100 transition-opacity">
                      ›
                    </span>
                  </Button>
                </div>
              )}
              {renderNavigationButtons(fixedNavigationButtons)}
              {fixedSecondaryNavigationButtons.length > 0 &&
                renderMoreNavigationButton(fixedSecondaryNavigationButtons, menuId)}
            </div>
          </div>

          <div data-testid="task-sidebar-scroll-content">
            {!isCollapsed && scrollableNavigationButtons.length > 0 && (
              <div className="px-2.5 pt-0.5">
                {renderNavigationButtons(scrollableNavigationButtons)}
              </div>
            )}

            {/* Tasks Section - matches Figma: left-[20px] top-[198px] with border */}
            <div
              className={`${isCollapsed ? 'px-0' : 'px-2.5'} pt-1.5 border-t border-border-light mt-1`}
              data-testid="task-sidebar-task-sections"
            >
              {/* Auto-refresh indicator - shows when refreshing after page visibility or reconnect */}
              {isRefreshing && !isCollapsed && (
                <div className="px-1 pb-2">
                  <div className="flex items-center gap-2 text-xs text-primary">
                    <div className="h-1 w-full bg-surface rounded-full overflow-hidden">
                      <div
                        className="h-full bg-primary/60 rounded-full animate-pulse"
                        style={{ width: '100%' }}
                      />
                    </div>
                    <span className="text-text-muted whitespace-nowrap">
                      {t('common:tasks.refreshing')}
                    </span>
                  </div>
                </div>
              )}
              {/* Collapsed mode refresh indicator */}
              {isRefreshing && isCollapsed && (
                <div className="flex justify-center pb-2">
                  <div className="h-1 w-6 bg-primary/60 rounded-full animate-pulse" />
                </div>
              )}
              {/* Search Result Header */}
              {!isCollapsed && isSearchResult && (
                <div className="px-1 pb-2 flex items-center justify-between">
                  <span className="text-xs font-medium text-text-muted">
                    {t('common:tasks.search_results')}
                  </span>
                  <button
                    onClick={handleClearSearch}
                    className="flex items-center gap-1 text-xs text-text-muted hover:text-text-primary transition-colors"
                  >
                    <X className="h-3 w-3" />
                    {t('common:tasks.clear_search')}
                  </button>
                </div>
              )}
              {/* Search Button for collapsed mode - removed, search is now in the combined top button */}
              {isSearching ? (
                <div className="text-center py-8 text-xs text-text-muted">
                  {t('common:tasks.searching')}
                </div>
              ) : isSearchResult ? (
                // Search results mode - show mixed results from legacy tasks list
                tasks.length === 0 ? (
                  <div className="text-center py-8 text-xs text-text-muted">
                    {t('common:tasks.no_search_results')}
                  </div>
                ) : (
                  (() => {
                    // Separate group chats and regular tasks from search results
                    const allGroupChats = tasks
                      .filter(task => task.is_group_chat)
                      .sort(
                        (a, b) =>
                          new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime()
                      )
                    const regularTasks = tasks
                      .filter(task => !task.is_group_chat)
                      .sort(
                        (a, b) =>
                          new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
                      )

                    return (
                      <>
                        {/* Group Chats from search results */}
                        {allGroupChats.length > 0 && (
                          <>
                            {!isCollapsed && (
                              <div className="px-1 pb-1 text-xs font-medium text-text-muted">
                                {t('common:tasks.group_chats')}
                              </div>
                            )}
                            <TaskListSection
                              tasks={allGroupChats}
                              title=""
                              unreadCount={getUnreadCount(allGroupChats)}
                              onTaskClick={() => setIsMobileSidebarOpen(false)}
                              isCollapsed={isCollapsed}
                              showTitle={false}
                              enableDrag={true}
                              key={`search-group-chats-${viewStatusVersion}`}
                            />
                          </>
                        )}
                        {/* Personal tasks from search results */}
                        {regularTasks.length > 0 && (
                          <>
                            {!isCollapsed && (
                              <div
                                className={`px-1 pb-1 text-xs font-medium text-text-muted flex items-center justify-between ${allGroupChats.length > 0 ? 'pt-3 mt-2 border-t border-border-light' : ''}`}
                              >
                                <span>{t('common:tasks.history_title')}</span>
                              </div>
                            )}
                            {isCollapsed && allGroupChats.length > 0 && (
                              <div className="border-t border-border-light my-2" />
                            )}
                            <TaskListSection
                              tasks={regularTasks}
                              title=""
                              unreadCount={getUnreadCount(regularTasks)}
                              onTaskClick={() => setIsMobileSidebarOpen(false)}
                              isCollapsed={isCollapsed}
                              showTitle={false}
                              enableDrag={true}
                              key={`search-regular-tasks-${viewStatusVersion}`}
                            />
                          </>
                        )}
                      </>
                    )
                  })()
                )
              ) : (
                <TaskHistorySection
                  groupTasks={groupTasks}
                  personalTasks={personalTasks}
                  isCollapsed={isCollapsed}
                  hasMorePersonalTasks={hasMorePersonalTasks}
                  loadMorePersonalTasks={loadMorePersonalTasks}
                  loadingMorePersonalTasks={loadingMorePersonalTasks}
                  viewStatusVersion={viewStatusVersion}
                  getUnreadCount={getUnreadCount}
                  totalUnreadCount={totalUnreadCount}
                  handleMarkAllAsViewed={handleMarkAllAsViewed}
                  handleOpenSearchDialog={handleOpenSearchDialog}
                  shortcutDisplayText={shortcutDisplayText}
                  setIsMobileSidebarOpen={setIsMobileSidebarOpen}
                  isSearchResult={isSearchResult}
                  onTaskSelect={() => setIsMobileSidebarOpen(false)}
                  setIsHistoryManageDialogOpen={setIsHistoryManageDialogOpen}
                />
              )}
              {loadingMore && isSearchResult && (
                <div className="text-center py-2 text-xs text-text-muted">
                  {t('common:tasks.loading')}
                </div>
              )}
            </div>
          </div>
        </div>
        {!isSearchResult && (
          <FixedGroupChatsSection
            groupTasks={groupTasks}
            isCollapsed={isCollapsed}
            isGroupChatsExpanded={isGroupChatsExpanded}
            setIsGroupChatsExpanded={setIsGroupChatsExpanded}
            hasMoreGroupTasks={hasMoreGroupTasks}
            loadAllGroupTasks={loadAllGroupTasks}
            loadingMoreGroupTasks={loadingMoreGroupTasks}
            viewStatusVersion={viewStatusVersion}
            getUnreadCount={getUnreadCount}
            setIsMobileSidebarOpen={setIsMobileSidebarOpen}
          />
        )}
      </TaskDndProvider>

      {/* User Menu */}
      <div className="px-2.5 py-3 border-t border-border-light shrink-0" data-tour="settings-link">
        <UserFloatingMenu />
      </div>
    </>
  )

  return (
    <>
      {/* Desktop Sidebar - Hidden on mobile, width controlled by parent ResizableSidebar */}
      <div
        className="hidden lg:flex lg:flex-col w-full h-full bg-base rounded-3xl shadow-sidebar my-2"
        style={{ height: 'calc(100% - 24px)' }}
        data-testid="task-sidebar"
        data-tour="task-sidebar"
      >
        {renderSidebarContent(desktopScrollRef, 'desktop')}
      </div>

      {/* Mobile Sidebar */}
      <MobileSidebar
        isOpen={isMobileSidebarOpen}
        onClose={() => setIsMobileSidebarOpen(false)}
        title={t('common:navigation.tasks')}
        hideTitle={true}
        data-tour="task-sidebar"
      >
        <div className="h-full flex flex-col">
          {renderSidebarContent(mobileScrollRef, 'mobile')}
        </div>
      </MobileSidebar>

      {/* History Manage Dialog */}
      <HistoryManageDialog
        open={isHistoryManageDialogOpen}
        onOpenChange={setIsHistoryManageDialogOpen}
      />
    </>
  )
}
