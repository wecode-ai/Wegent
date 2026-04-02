// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useState, useEffect, useCallback } from 'react'
import { useSearchParams } from 'next/navigation'
import { UserGroupIcon } from '@heroicons/react/24/outline'
import { useTeamContext } from '@/contexts/TeamContext'
import TopNavigation from '@/features/layout/TopNavigation'
import {
  TaskSidebar,
  ResizableSidebar,
  CollapsedSidebarButtons,
  SearchDialog,
} from '@/features/tasks/components/sidebar'
import { GithubStarButton } from '@/features/layout/GithubStarButton'
import { Team } from '@/types/api'
import { saveLastTab } from '@/utils/userPreferences'
import { useUser } from '@/features/common/UserContext'
import { useTaskContext } from '@/features/tasks/contexts/taskContext'
import { useChatStreamContext } from '@/features/tasks/contexts/chatStreamContext'
import { useDevices } from '@/contexts/DeviceContext'
import { paths } from '@/config/paths'
import { Button } from '@/components/ui/button'
import { useTranslation } from '@/hooks/useTranslation'
import { useSearchShortcut } from '@/features/tasks/hooks/useSearchShortcut'
import { ChatArea } from '@/features/tasks/components/chat'
import { CreateGroupChatDialog } from '@/features/tasks/components/group-chat'
import { RemoteWorkspaceEntry } from '@/features/tasks/components/remote-workspace'
import { useIsDesktop } from '@/features/layout/hooks/useMediaQuery'

/**
 * Desktop-specific implementation of Chat Page
 *
 * Optimized for screens ≥768px with:
 * - Resizable sidebar with collapse support
 * - Full navigation and toolbar
 * - Optimized spacing for larger screens
 *
 * @see ChatPageMobile.tsx for mobile implementation
 */
export function ChatPageDesktop() {
  const { t } = useTranslation()

  // Team state from context (centralized to avoid duplicate API calls)
  const { teams, isTeamsLoading, refreshTeams } = useTeamContext()

  // Task context for refreshing task list
  const {
    refreshTasks,
    selectedTask,
    selectedTaskDetail,
    setSelectedTask,
    refreshSelectedTaskDetail,
  } = useTaskContext()

  // Device context - when a device is selected, switch to 'task' mode
  const { selectedDeviceId, devices } = useDevices()
  const selectedDevice = devices.find(d => d.device_id === selectedDeviceId)

  // Determine taskType based on device selection
  // When a device is selected, use 'task' mode (same as /devices/chat)
  // Otherwise, use 'chat' mode
  const taskType = selectedDeviceId ? 'task' : 'chat'

  // Compute disabled reason for device mode
  const disabledReason =
    selectedDeviceId && (!selectedDevice || selectedDevice.status === 'offline')
      ? t('devices:device_offline_cannot_send')
      : undefined

  // Get current task title for top navigation
  const currentTaskTitle = selectedTaskDetail?.title

  // Handle task deletion
  const handleTaskDeleted = () => {
    setSelectedTask(null)
    refreshTasks()
  }

  // Handle members changed (when converting to group chat or adding/removing members)
  const handleMembersChanged = () => {
    refreshTasks()
    refreshSelectedTaskDetail(false)
  }

  // Chat stream context
  const { clearAllStreams } = useChatStreamContext()

  // User state for git token check
  const { user } = useUser()

  // Check for share_id in URL
  const searchParams = useSearchParams()
  const _hasShareId = !!searchParams.get('share_id')

  // Check if a task is currently open (support multiple parameter formats)
  const taskId =
    searchParams.get('task_id') || searchParams.get('taskid') || searchParams.get('taskId')
  const hasOpenTask = !!taskId

  // Collapsed sidebar state
  const [isCollapsed, setIsCollapsed] = useState(false)

  // Mobile sidebar state (for tablet screens 768px-1023px)
  const [isMobileSidebarOpen, setIsMobileSidebarOpen] = useState(false)

  // Check if we're on a true desktop screen (≥1024px)
  // On tablet screens (768px-1023px), we use mobile sidebar instead of ResizableSidebar
  const isDesktop = useIsDesktop()

  // Selected team state for sharing
  const [_selectedTeamForNewTask, _setSelectedTeamForNewTask] = useState<Team | null>(null)

  // Share button state
  const [shareButton, setShareButton] = useState<React.ReactNode>(null)

  // Create group chat dialog state
  const [isCreateGroupChatOpen, setIsCreateGroupChatOpen] = useState(false)

  // Search dialog state (controlled from page level for global shortcut support)
  const [isSearchDialogOpen, setIsSearchDialogOpen] = useState(false)

  // Toggle search dialog callback
  const toggleSearchDialog = useCallback(() => {
    setIsSearchDialogOpen(prev => !prev)
  }, [])

  // Global search shortcut hook
  const { shortcutDisplayText } = useSearchShortcut({
    onToggle: toggleSearchDialog,
  })

  const handleShareButtonRender = (button: React.ReactNode) => {
    setShareButton(button)
  }

  // Check if user has git token
  const _hasGitToken = !!(user?.git_info && user.git_info.length > 0)

  // Load collapsed state from localStorage
  useEffect(() => {
    const savedCollapsed = localStorage.getItem('task-sidebar-collapsed')
    if (savedCollapsed === 'true') {
      setIsCollapsed(true)
    }
  }, [])

  // Save last active tab to localStorage
  useEffect(() => {
    saveLastTab('chat')
  }, [])

  const handleRefreshTeams = async (): Promise<Team[]> => {
    return await refreshTeams()
  }

  const handleToggleCollapsed = () => {
    setIsCollapsed(prev => {
      const newValue = !prev
      localStorage.setItem('task-sidebar-collapsed', String(newValue))
      return newValue
    })
  }

  // Handle new task from collapsed sidebar button
  const handleNewTask = () => {
    // IMPORTANT: Clear selected task FIRST to ensure UI state is reset immediately
    // This prevents the UI from being stuck showing the previous task's messages
    setSelectedTask(null)
    clearAllStreams()
    // Force a hard reload to ensure a fresh start when already on /chat
    window.location.href = paths.chat.getHref()
  }

  // Handle expand for collapsed sidebar buttons
  // On tablet screens, open mobile sidebar; on desktop, toggle collapsed state
  const handleExpandFromCollapsedButtons = () => {
    if (isDesktop) {
      handleToggleCollapsed()
    } else {
      setIsMobileSidebarOpen(true)
    }
  }

  return (
    <div className="flex smart-h-screen bg-base text-text-primary box-border">
      {/* Collapsed sidebar floating buttons - show on desktop when collapsed, or on tablet screens */}
      {(isCollapsed || !isDesktop) && (
        <CollapsedSidebarButtons
          onExpand={handleExpandFromCollapsedButtons}
          onNewTask={handleNewTask}
        />
      )}
      {/* Responsive resizable sidebar - only on true desktop screens (≥1024px) */}
      <ResizableSidebar isCollapsed={isCollapsed} onToggleCollapsed={handleToggleCollapsed}>
        <TaskSidebar
          isMobileSidebarOpen={isMobileSidebarOpen}
          setIsMobileSidebarOpen={setIsMobileSidebarOpen}
          pageType="chat"
          isCollapsed={isCollapsed}
          onToggleCollapsed={handleToggleCollapsed}
          isSearchDialogOpen={isSearchDialogOpen}
          onSearchDialogOpenChange={setIsSearchDialogOpen}
          shortcutDisplayText={shortcutDisplayText}
        />
      </ResizableSidebar>
      {/* Main content area */}
      <div className="flex-1 flex flex-col min-w-0">
        {/* Top navigation */}
        <TopNavigation
          activePage="chat"
          variant="with-sidebar"
          title={currentTaskTitle}
          taskDetail={selectedTaskDetail}
          onMobileSidebarToggle={() => setIsMobileSidebarOpen(true)}
          onTaskDeleted={handleTaskDeleted}
          onMembersChanged={handleMembersChanged}
          isSidebarCollapsed={isCollapsed}
        >
          {/* Create Group Chat Button - only show when no task is open */}
          {!hasOpenTask && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => setIsCreateGroupChatOpen(true)}
              className="gap-1 h-8 pl-2 pr-3 rounded-[7px] text-sm"
            >
              <UserGroupIcon className="h-3.5 w-3.5" />
              <span className="hidden sm:inline">{t('groupChat.create.button')}</span>
            </Button>
          )}
          {(selectedTask?.id || selectedTaskDetail?.id) && (
            <RemoteWorkspaceEntry
              taskId={selectedTask?.id || selectedTaskDetail?.id}
              taskStatus={selectedTaskDetail?.status}
            />
          )}
          {shareButton}
          <GithubStarButton />
        </TopNavigation>
        {/* Chat area - taskType switches based on device selection */}
        <ChatArea
          teams={teams}
          isTeamsLoading={isTeamsLoading}
          selectedTeamForNewTask={_selectedTeamForNewTask}
          showRepositorySelector={false}
          taskType={taskType}
          onShareButtonRender={handleShareButtonRender}
          onRefreshTeams={handleRefreshTeams}
          disabledReason={disabledReason}
        />
      </div>
      {/* Create Group Chat Dialog */}
      <CreateGroupChatDialog open={isCreateGroupChatOpen} onOpenChange={setIsCreateGroupChatOpen} />
      {/* Search Dialog - rendered at page level for global shortcut support */}
      <SearchDialog
        open={isSearchDialogOpen}
        onOpenChange={setIsSearchDialogOpen}
        shortcutDisplayText={shortcutDisplayText}
        pageType="chat"
      />
    </div>
  )
}
