// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import Image from 'next/image'
import { Bars3Icon } from '@heroicons/react/24/outline'

import { useTranslation } from '@/hooks/useTranslation'
import { useIsMobile, useIsDesktop } from './hooks/useMediaQuery'
import TaskTitleDropdown from './TaskTitleDropdown'
import { TaskDetail } from '@/types/api'
type TopNavigationProps = {
  activePage?:
    | 'chat'
    | 'code'
    | 'wiki'
    | 'dashboard'
    | 'devices'
    | 'flow'
    | 'inbox'
    | 'collaboration'
  variant?: 'with-sidebar' | 'standalone'
  showLogo?: boolean
  title?: string
  titleSuffix?: React.ReactNode // Content to render after the title (e.g., bound knowledge base badge)
  /** Flexible content that takes the place of the title in the compact navigation row. */
  centerContent?: React.ReactNode
  taskDetail?: TaskDetail | null
  children?: React.ReactNode
  onMobileSidebarToggle?: () => void
  onTaskDeleted?: () => void
  onMembersChanged?: () => void // Callback to refresh task detail when converted to group chat
  isSidebarCollapsed?: boolean
  hideGroupChatOptions?: boolean // Hide group chat management options (e.g., in notebook mode)
  isRightPanelCollapsed?: boolean // Whether right panel is collapsed (adds right padding for expand button)
}

export default function TopNavigation({
  variant = 'standalone',
  showLogo = false,
  title,
  titleSuffix,
  centerContent,
  taskDetail,
  children,
  onMobileSidebarToggle,
  onTaskDeleted,
  onMembersChanged,
  isSidebarCollapsed = false,
  hideGroupChatOptions = false,
  isRightPanelCollapsed: _isRightPanelCollapsed = false,
}: TopNavigationProps) {
  const { t } = useTranslation()
  const isMobile = useIsMobile()
  const isDesktop = useIsDesktop()

  // Determine if we should show the hamburger menu
  const showHamburgerMenu = variant === 'with-sidebar' && !isDesktop && onMobileSidebarToggle

  // Determine if we should show the logo
  const shouldShowLogo = showLogo || (variant === 'standalone' && !isMobile)

  // Compute padding classes separately to avoid conflicts
  const leftPaddingClass = isSidebarCollapsed && isDesktop ? 'pl-24' : 'pl-4 sm:pl-6'
  // Right padding is always the same - the expand button is fixed positioned and doesn't need reserved space
  const rightPaddingClass = 'pr-4 sm:pr-6'
  const hasCompactCenter = Boolean(centerContent) && !isDesktop
  const titleContent = (
    <>
      {variant === 'with-sidebar' ? (
        <TaskTitleDropdown
          title={title}
          taskDetail={taskDetail}
          onTaskDeleted={onTaskDeleted}
          onMembersChanged={onMembersChanged}
          hideGroupChatOptions={hideGroupChatOptions}
        />
      ) : (
        title && <h1 className="text-xl font-semibold text-text-primary truncate">{title}</h1>
      )}
      {titleSuffix}
    </>
  )

  return (
    <header
      className={`relative flex shrink-0 items-center justify-between py-2 sm:py-3 min-h-[44px] bg-base ${leftPaddingClass} ${rightPaddingClass} ${hasCompactCenter ? 'flex-wrap gap-y-1' : ''}`}
    >
      {/* Left side - Mobile sidebar toggle, Logo, and Title */}
      <div className="flex items-center gap-3 min-w-0 flex-1">
        {showHamburgerMenu && (
          <button
            type="button"
            className="flex h-11 w-11 flex-shrink-0 items-center justify-center rounded-xl border border-border bg-surface text-text-muted hover:bg-muted hover:text-text-primary focus:outline-none focus:ring-2 focus:ring-primary/40 lg:hidden"
            onClick={onMobileSidebarToggle}
            aria-label={t('common:common.open_sidebar')}
            data-testid="mobile-task-sidebar-toggle"
          >
            <Bars3Icon className="h-5 w-5" aria-hidden="true" />
          </button>
        )}

        {shouldShowLogo && !showHamburgerMenu && (
          <div className="flex items-center gap-2 flex-shrink-0">
            <Image
              src="/weibo-logo.png"
              alt="Weibo Logo"
              width={isMobile ? 20 : 24}
              height={isMobile ? 20 : 24}
              className="object-container"
              priority
              unoptimized
            />
            {!isMobile && <span className="text-lg font-semibold text-text-primary">Wegent</span>}
          </div>
        )}

        {hasCompactCenter ? (
          <div className="min-w-0 flex-1">{centerContent}</div>
        ) : (
          <div className="flex min-w-0 items-center gap-3 overflow-hidden">{titleContent}</div>
        )}
      </div>

      {/* Right side - User menu and other controls */}
      {(children || (!hasCompactCenter && centerContent)) && (
        <div className="flex items-center gap-2 sm:gap-3 flex-shrink-0">
          {!hasCompactCenter && centerContent}
          {children}
        </div>
      )}
      {hasCompactCenter && (
        <div className="flex min-w-0 basis-full items-center gap-3 overflow-hidden">
          {titleContent}
        </div>
      )}
    </header>
  )
}
