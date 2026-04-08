// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useState, useEffect, useCallback, useMemo } from 'react'
import { useSearchParams, useRouter } from 'next/navigation'
import { UserGroupIcon } from '@heroicons/react/24/outline'
import { useTeamContext } from '@/contexts/TeamContext'
import TopNavigation from '@/features/layout/TopNavigation'
import { TaskSidebar, SearchDialog } from '@/features/tasks/components/sidebar'
import { ThemeToggle } from '@/features/theme/ThemeToggle'
import { Team } from '@/types/api'
import { saveLastTab } from '@/utils/userPreferences'
import { useUser } from '@/features/common/UserContext'
import { useTaskContext } from '@/features/tasks/contexts/taskContext'
import { useChatStreamContext } from '@/features/tasks/contexts/chatStreamContext'
import { useDevices } from '@/contexts/DeviceContext'
import { Button } from '@/components/ui/button'
import { useTranslation } from '@/hooks/useTranslation'
import { useSearchShortcut } from '@/features/tasks/hooks/useSearchShortcut'
import { ChatArea } from '@/features/tasks/components/chat'
import { useTeamEditExtension } from '@/features/tasks/hooks/useTeamEditExtension'
import { useToast } from '@/hooks/use-toast'
import { canEditTeam } from '@/utils/team-permissions'
import { listGroups } from '@/apis/groups'
import { fetchBotsList } from '@/features/settings/services/bots'
import TeamEditDialog from '@/features/settings/components/TeamEditDialog'
import type { BaseRole } from '@/types/base-role'
import { CreateGroupChatDialog } from '@/features/tasks/components/group-chat'

/**
 * Mobile-specific implementation of Chat Page
 *
 * Optimized for screens ≤767px with:
 * - Slide-out drawer sidebar
 * - Touch-friendly controls (min 44px targets)
 * - Simplified navigation
 * - Mobile-optimized spacing
 *
 * @see ChatPageDesktop.tsx for desktop implementation
 */
export function ChatPageMobile() {
  const { t } = useTranslation()

  // Team state from context (centralized to avoid duplicate API calls)
  const { teams, isTeamsLoading, refreshTeams } = useTeamContext()

  // Task context for refreshing task list
  const { refreshTasks, selectedTaskDetail, setSelectedTask, refreshSelectedTaskDetail } =
    useTaskContext()

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
  const { clearAllStreams: _clearAllStreams } = useChatStreamContext()

  // User state for git token check
  const { user } = useUser()

  // Router for navigation
  const _router = useRouter()

  // Check for share_id in URL
  const searchParams = useSearchParams()
  const _hasShareId = !!searchParams.get('share_id')

  // Check if a task is currently open (support multiple parameter formats)
  const taskId =
    searchParams.get('task_id') || searchParams.get('taskid') || searchParams.get('taskId')
  const hasOpenTask = !!taskId

  // Mobile sidebar state
  const [isMobileSidebarOpen, setIsMobileSidebarOpen] = useState(false)

  // Selected team state for sharing
  const [_selectedTeamForNewTask, _setSelectedTeamForNewTask] = useState<Team | null>(null)

  // Share button state
  const [shareButton, setShareButton] = useState<React.ReactNode>(null)

  // Create group chat dialog state
  const [isCreateGroupChatOpen, setIsCreateGroupChatOpen] = useState(false)

  // Search dialog state (controlled from page level for global shortcut support)
  const [isSearchDialogOpen, setIsSearchDialogOpen] = useState(false)

  // Toast for notifications
  const { toast } = useToast()

  // Group role map for permission checks
  const [groupRoleMap, setGroupRoleMap] = useState<Map<string, BaseRole>>(new Map())

  // Fetch group role map once on mount
  useEffect(() => {
    listGroups()
      .then(response => {
        const roleMap = new Map<string, BaseRole>()
        response.items.forEach(group => {
          if (group.my_role) {
            roleMap.set(group.name, group.my_role)
          }
        })
        setGroupRoleMap(roleMap)
      })
      .catch(() => {
        // Ignore errors - permissions will default to non-editable
      })
  }, [])

  // Memoize deps to prevent infinite re-renders
  const teamEditDeps = useMemo(
    () => ({
      getGroupRoleMap: () => groupRoleMap,
      checkCanEdit: (_teamId: number, userId: number, roleMap: Map<string, BaseRole>) => {
        if (!selectedTaskDetail?.team) return false
        return canEditTeam(selectedTaskDetail.team, userId, roleMap)
      },
      fetchBots: fetchBotsList,
      createDialogComponent: ({
        open,
        onClose,
        bots,
      }: {
        open: boolean
        onClose: () => void
        bots: import('@/types/api').Bot[]
      }) => {
        if (!selectedTaskDetail?.team) return null
        const team = selectedTaskDetail.team
        return (
          <TeamEditDialog
            open={open}
            onClose={onClose}
            teams={teams}
            setTeams={() => {
              // Teams are managed by TeamContext; refresh on dialog close instead
            }}
            editingTeamId={team.id}
            bots={bots}
            setBots={() => {
              // Bots are managed locally in the hook
            }}
            toast={toast}
            scope={team.namespace && team.namespace !== 'default' ? 'group' : 'personal'}
            groupName={team.namespace && team.namespace !== 'default' ? team.namespace : undefined}
          />
        )
      },
    }),
    [groupRoleMap, selectedTaskDetail?.team, teams, toast]
  )

  // Team edit extension with dependency injection
  const teamEditExtension = useTeamEditExtension({
    currentTeamId: selectedTaskDetail?.team?.id ?? null,
    currentTeamNamespace: selectedTaskDetail?.team?.namespace ?? null,
    userId: user?.id,
    deps: teamEditDeps,
    onTeamUpdated: useCallback(() => {
      refreshTasks()
      refreshSelectedTaskDetail(false)
    }, [refreshTasks, refreshSelectedTaskDetail]),
  })

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

  // Save last active tab to localStorage
  useEffect(() => {
    saveLastTab('chat')
  }, [])

  const handleRefreshTeams = async (): Promise<Team[]> => {
    return await refreshTeams()
  }

  return (
    <div className="flex smart-h-screen bg-base text-text-primary box-border">
      {/* Mobile sidebar - use TaskSidebar's built-in MobileSidebar component */}
      <TaskSidebar
        isMobileSidebarOpen={isMobileSidebarOpen}
        setIsMobileSidebarOpen={setIsMobileSidebarOpen}
        pageType="chat"
        isCollapsed={false}
        onToggleCollapsed={() => {}}
        isSearchDialogOpen={isSearchDialogOpen}
        onSearchDialogOpenChange={setIsSearchDialogOpen}
        shortcutDisplayText={shortcutDisplayText}
      />

      {/* Main content area */}
      <div className="flex-1 flex flex-col min-w-0">
        {/* Top navigation - mobile optimized */}
        <TopNavigation
          activePage="chat"
          variant="with-sidebar"
          title={currentTaskTitle}
          taskDetail={selectedTaskDetail}
          onMobileSidebarToggle={() => setIsMobileSidebarOpen(true)}
          onTaskDeleted={handleTaskDeleted}
          onMembersChanged={handleMembersChanged}
          isSidebarCollapsed={false}
        >
          {/* Create Group Chat Button - compact on mobile */}
          {!hasOpenTask && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => setIsCreateGroupChatOpen(true)}
              className="gap-1 h-11 min-w-[44px] pl-2 pr-3 rounded-[7px] text-sm"
            >
              <UserGroupIcon className="h-4 w-4" />
              <span className="sr-only">{t('groupChat.create.button')}</span>
            </Button>
          )}
          {shareButton}
          <ThemeToggle />
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
          extension={{ teamEdit: teamEditExtension }}
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
