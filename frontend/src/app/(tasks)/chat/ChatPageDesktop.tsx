// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useState, useEffect, useCallback, useMemo } from 'react'
import { useSearchParams, useRouter } from 'next/navigation'
import { UserGroupIcon, ComputerDesktopIcon } from '@heroicons/react/24/outline'
import { teamService } from '@/features/tasks/service/teamService'
import TopNavigation from '@/features/layout/TopNavigation'
import {
  TaskSidebar,
  ResizableSidebar,
  CollapsedSidebarButtons,
  SearchDialog,
} from '@/features/tasks/components/sidebar'
import { GithubStarButton } from '@/features/layout/GithubStarButton'
import GreyTestButton from '@/features/layout/components/GreyTestButton'
import { Team } from '@/types/api'
import { saveLastTab } from '@/utils/userPreferences'
import { useUser } from '@/features/common/UserContext'
import { useTaskContext } from '@/features/tasks/contexts/taskContext'
import { useChatStreamContext } from '@/features/tasks/contexts/chatStreamContext'
import { paths } from '@/config/paths'
import { Button } from '@/components/ui/button'
import { useTranslation } from '@/hooks/useTranslation'
import { useSearchShortcut } from '@/features/tasks/hooks/useSearchShortcut'
import { ChatArea } from '@/features/tasks/components'
import { CloudDeviceVncPanel } from '@wecode/components/cloud-device'
import { CreateGroupChatDialog } from '@/features/tasks/components/group-chat'
import { cloudDeviceApis } from '@wecode/apis/cloud-devices'
import { useIsMobile } from '@/features/layout/hooks/useMediaQuery'
import { useDevices } from '@/contexts/DeviceContext'

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
  const isMobile = useIsMobile()

  // Team state from service
  const { teams, isTeamsLoading, refreshTeams } = teamService.useTeams()

  // Task context for refreshing task list
  const { refreshTasks, selectedTaskDetail, setSelectedTask, refreshSelectedTaskDetail } =
    useTaskContext()

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

  // Device context for cloud device detection
  const { devices } = useDevices()

  // User state for git token check
  const { user } = useUser()

  // Router for navigation
  const router = useRouter()

  // Check for share_id in URL
  const searchParams = useSearchParams()
  const _hasShareId = !!searchParams.get('share_id')

  // Check if a task is currently open (support multiple parameter formats)
  const taskId =
    searchParams.get('task_id') || searchParams.get('taskid') || searchParams.get('taskId')
  const hasOpenTask = !!taskId

  // Collapsed sidebar state
  const [isCollapsed, setIsCollapsed] = useState(false)

  // Selected team state for sharing
  const [_selectedTeamForNewTask, _setSelectedTeamForNewTask] = useState<Team | null>(null)

  // Share button state
  const [shareButton, setShareButton] = useState<React.ReactNode>(null)

  // Create group chat dialog state
  const [isCreateGroupChatOpen, setIsCreateGroupChatOpen] = useState(false)

  // Search dialog state (controlled from page level for global shortcut support)
  const [isSearchDialogOpen, setIsSearchDialogOpen] = useState(false)

  // VNC panel state
  const [isVncPanelOpen, setIsVncPanelOpen] = useState(false)
  const [vncUrl, setVncUrl] = useState<string | null>(null)
  const [isLoadingVnc, setIsLoadingVnc] = useState(false)

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

  // Fetch cloud device VNC URL when task is loaded
  useEffect(() => {
    const fetchCloudDeviceStatus = async () => {
      // Reset VNC state when task changes
      setVncUrl(null)
      setIsVncPanelOpen(false)

      // Only fetch if we have a task with a device_id
      if (!selectedTaskDetail?.device_id) {
        return
      }

      // Find the device and check if it's a cloud device
      const device = devices.find(d => d.device_id === selectedTaskDetail.device_id)
      if (!device || device.device_type !== 'cloud') return

      setIsLoadingVnc(true)
      try {
        const status = await cloudDeviceApis.getCloudDeviceStatus(selectedTaskDetail.device_id)
        if (status.vnc_url) {
          setVncUrl(status.vnc_url)
          // Auto-open VNC panel by default for cloud devices
          setIsVncPanelOpen(true)
        }
      } catch (error) {
        console.error('Failed to fetch cloud device status:', error)
      } finally {
        setIsLoadingVnc(false)
      }
    }

    fetchCloudDeviceStatus()
  }, [selectedTaskDetail?.device_id, devices])

  // Check if we should show the VNC toggle button
  const showVncToggle = useMemo(() => {
    return hasOpenTask && !!vncUrl && !isMobile
  }, [hasOpenTask, vncUrl, isMobile])

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
    router.replace(paths.chat.getHref())
  }

  return (
    <div className="flex smart-h-screen bg-base text-text-primary box-border">
      {/* Collapsed sidebar floating buttons */}
      {isCollapsed && (
        <CollapsedSidebarButtons onExpand={handleToggleCollapsed} onNewTask={handleNewTask} />
      )}
      {/* Responsive resizable sidebar */}
      <ResizableSidebar isCollapsed={isCollapsed} onToggleCollapsed={handleToggleCollapsed}>
        <TaskSidebar
          isMobileSidebarOpen={false}
          setIsMobileSidebarOpen={() => {}}
          pageType="chat"
          isCollapsed={isCollapsed}
          onToggleCollapsed={handleToggleCollapsed}
          isSearchDialogOpen={isSearchDialogOpen}
          onSearchDialogOpenChange={setIsSearchDialogOpen}
          shortcutDisplayText={shortcutDisplayText}
        />
      </ResizableSidebar>
      {/* Main content area with right panel */}
      <div className="flex-1 flex flex-col min-w-0">
        {/* Top navigation */}
        <TopNavigation
          activePage="chat"
          variant="with-sidebar"
          title={currentTaskTitle}
          taskDetail={selectedTaskDetail}
          onMobileSidebarToggle={() => {}}
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
          {shareButton}
          <GreyTestButton />
          <GithubStarButton />
          {/* VNC Panel Toggle Button */}
          {showVncToggle && (
            <button
              onClick={() => setIsVncPanelOpen(prev => !prev)}
              className={`relative w-8 h-8 rounded-[7px] bg-base border border-border hover:bg-hover focus:outline focus:outline-2 focus:outline-offset-2 focus:outline-primary transition-all duration-200 ${
                isVncPanelOpen ? 'text-primary border-primary' : ''
              }`}
              title={isVncPanelOpen ? t('cloudDevice.closeVnc') : t('cloudDevice.openVnc')}
            >
              <ComputerDesktopIcon className="w-4 h-4 absolute top-1/2 left-1/2 transform -translate-x-1/2 -translate-y-1/2" />
            </button>
          )}
          {isLoadingVnc && (
            <div className="w-8 h-8 flex items-center justify-center">
              <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-primary"></div>
            </div>
          )}
        </TopNavigation>
        {/* Content area with split layout */}
        <div className="flex flex-1 min-h-0">
          {/* Chat area - affected by VNC panel */}
          <div
            className="transition-all duration-300 ease-in-out flex flex-col min-h-0"
            style={{
              width: hasOpenTask && isVncPanelOpen && vncUrl ? '60%' : '100%',
            }}
          >
            <ChatArea
              teams={teams}
              isTeamsLoading={isTeamsLoading}
              selectedTeamForNewTask={_selectedTeamForNewTask}
              showRepositorySelector={false}
              taskType="chat"
              onShareButtonRender={handleShareButtonRender}
              onRefreshTeams={handleRefreshTeams}
            />
          </div>

          {/* VNC Panel - only show if there's a task with VNC URL */}
          {hasOpenTask && vncUrl && (
            <CloudDeviceVncPanel
              vncUrl={vncUrl}
              isOpen={isVncPanelOpen}
              onClose={() => setIsVncPanelOpen(false)}
              onOpen={() => setIsVncPanelOpen(true)}
              deviceName={selectedTaskDetail?.device_id || undefined}
            />
          )}
        </div>
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
