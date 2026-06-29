// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useState, useEffect, useCallback, useMemo } from 'react'
import dynamic from 'next/dynamic'
import { useSearchParams, useRouter } from 'next/navigation'
import { UserGroupIcon } from '@heroicons/react/24/outline'
import { useTeamContext } from '@/contexts/TeamContext'
import TopNavigation from '@/features/layout/TopNavigation'
import {
  TaskSidebar,
  ResizableSidebar,
  CollapsedSidebarButtons,
} from '@/features/tasks/components/sidebar'
import { GithubStarButton } from '@/features/layout/GithubStarButton'
import WorkbenchToggle from '@/features/layout/WorkbenchToggle'
import { OpenMenu } from '@/features/tasks/components/input'
import type { Team, TaskType, WorkbenchData } from '@/types/api'
import { saveLastTab } from '@/utils/userPreferences'
import { useUser } from '@/features/common/UserContext'
import { useTaskSession } from '@/features/tasks/session/TaskSession'
import { useDevices } from '@/contexts/DeviceContext'
import { paths } from '@/config/paths'
import { Button } from '@/components/ui/button'
import { useTranslation } from '@/hooks/useTranslation'
import { useSearchShortcut } from '@/features/tasks/hooks/useSearchShortcut'
import { ChatArea } from '@/features/tasks/components/chat'
import { useTeamEditExtension } from '@/features/tasks/hooks/useTeamEditExtension'
import { useToast } from '@/hooks/use-toast'
import { canEditTeam } from '@/utils/team-permissions'
import { listGroups } from '@/apis/groups'
import { fetchBotsList } from '@/features/settings/services/bots'
import type { BaseRole } from '@/types/base-role'
import { RemoteWorkspaceEntry } from '@/features/tasks/components/remote-workspace'
import { useIsDesktop } from '@/features/layout/hooks/useMediaQuery'
import { getRuntimeConfigSync } from '@/lib/runtime-config'
import { getFirstSearchParam, getSearchParam } from '@/lib/search-params'
import { calculateOpenLinks } from '@/utils/openLinks'
import type { MessageBlock } from '@/features/tasks/components/message/thinking/types'
import type { UnifiedMessage } from '@wegent/chat-core'

const SearchDialog = dynamic(() => import('@/features/tasks/components/sidebar/SearchDialog'), {
  ssr: false,
})

const Workbench = dynamic(() => import('@/features/tasks/components/workbench/Workbench'), {
  ssr: false,
})

const TeamEditDialog = dynamic(() => import('@/features/settings/components/TeamEditDialog'), {
  ssr: false,
})

const CreateGroupChatDialog = dynamic(
  () =>
    import('@/features/tasks/components/group-chat/CreateGroupChatDialog').then(mod => ({
      default: mod.CreateGroupChatDialog,
    })),
  { ssr: false }
)

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
  const router = useRouter()

  // Team state from context (centralized to avoid duplicate API calls)
  const { teams, isTeamsLoading, refreshTeams } = useTeamContext()

  // Task context for refreshing task list
  const {
    refreshTasks,
    selectedTask,
    selectedTaskDetail,
    selectTask,
    refreshSelectedTaskDetail,
    taskState: sessionTaskState,
  } = useTaskSession()

  // Device context - when a device is selected, switch to 'task' mode
  const { selectedDeviceId, devices } = useDevices()
  const selectedDevice = devices.find(d => d.device_id === selectedDeviceId)

  // Get current task title for top navigation
  const currentTaskTitle = selectedTaskDetail?.title

  // Handle task deletion
  const handleTaskDeleted = () => {
    selectTask(null)
    refreshTasks()
  }

  // Handle members changed (when converting to group chat or adding/removing members)
  const handleMembersChanged = () => {
    refreshTasks()
    void refreshSelectedTaskDetail()
  }

  // User state for git token check
  const { user } = useUser()

  // Check for share_id in URL
  const searchParams = useSearchParams()
  const _hasShareId = !!getSearchParam(searchParams, 'share_id')
  const hasWeworkCodeUrl = getRuntimeConfigSync().weworkCodeUrl.trim().length > 0
  const isCodeAgentMode = getSearchParam(searchParams, 'agent') === 'code'
  const isCodeTaskOpen = selectedTaskDetail?.task_type === 'code'

  // Check if a task is currently open (support multiple parameter formats)
  const taskId = getFirstSearchParam(searchParams, ['task_id', 'taskid', 'taskId'])
  const hasOpenTask = !!taskId

  // Determine taskType based on device selection, URL agent filter, and selected task.
  // When Wework URL is configured, default chat shows both chat and code agents but
  // remains chat-first until a code-only agent is selected inside ChatArea.
  const taskType: TaskType =
    selectedDeviceId || selectedTaskDetail?.task_type === 'task'
      ? 'task'
      : isCodeAgentMode || isCodeTaskOpen
        ? 'code'
        : 'chat'
  const teamModeFilter: 'chat' | 'code' | 'task' | 'all' =
    selectedDeviceId || selectedTaskDetail?.task_type === 'task'
      ? 'task'
      : isCodeAgentMode || isCodeTaskOpen
        ? 'code'
        : hasWeworkCodeUrl
          ? 'all'
          : 'chat'
  const showRepositorySelector =
    !selectedDeviceId && selectedTaskDetail?.task_type !== 'task' && teamModeFilter !== 'chat'

  // Compute disabled reason for device mode
  const disabledReason =
    selectedDeviceId && (!selectedDevice || selectedDevice.status === 'offline')
      ? t('devices:device_offline_cannot_send')
      : undefined

  // Redirect device tasks to /devices/chat page for proper layout
  useEffect(() => {
    if (selectedTaskDetail?.task_type === 'task' && taskId) {
      const params = new URLSearchParams()
      params.set('taskId', String(taskId))
      if (selectedTaskDetail.device_id) {
        params.set('deviceId', selectedTaskDetail.device_id)
      }
      const projectIdParam = getSearchParam(searchParams, 'projectId')
      if (projectIdParam) {
        params.set('projectId', projectIdParam)
      }
      router.replace(`/devices/chat?${params.toString()}`)
    }
  }, [selectedTaskDetail?.task_type, selectedTaskDetail?.device_id, taskId, router, searchParams])

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

  // Workbench state for code tasks opened inside chat.
  const [isWorkbenchOpen, setIsWorkbenchOpen] = useState(false)

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
      refreshTeams()
      void refreshSelectedTaskDetail()
    }, [refreshTeams, refreshSelectedTaskDetail]),
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

  // Auto-open workbench for code tasks.
  useEffect(() => {
    if (hasOpenTask && isCodeTaskOpen) {
      setIsWorkbenchOpen(true)
    }
  }, [hasOpenTask, isCodeTaskOpen])

  // Calculate open links from task detail for code task toolbar.
  const openLinks = useMemo(() => {
    return calculateOpenLinks(selectedTaskDetail)
  }, [selectedTaskDetail])

  const taskState =
    sessionTaskState && sessionTaskState.taskId === selectedTaskDetail?.id ? sessionTaskState : null

  const { blocksData, workbenchData } = useMemo(() => {
    if (taskState?.messages && taskState.messages.size > 0) {
      const allBlocks: MessageBlock[] = []
      let latestWorkbench: WorkbenchData | null = null
      const messages: UnifiedMessage[] = Array.from(taskState.messages.values())

      for (const msg of messages) {
        if (msg.type === 'ai' && msg.result) {
          const result = msg.result as { blocks?: MessageBlock[]; workbench?: WorkbenchData }
          if (result.blocks && Array.isArray(result.blocks)) {
            allBlocks.push(...result.blocks)
          }
          if (msg.status === 'streaming' && result.workbench) {
            latestWorkbench = result.workbench
          } else if (!latestWorkbench && result.workbench) {
            latestWorkbench = result.workbench
          }
        }
      }

      if (allBlocks.length > 0 || latestWorkbench) {
        return {
          blocksData: allBlocks.length > 0 ? allBlocks : null,
          workbenchData: latestWorkbench || selectedTaskDetail?.workbench || null,
        }
      }
    }

    return { blocksData: null, workbenchData: selectedTaskDetail?.workbench || null }
  }, [taskState, selectedTaskDetail])

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
    selectTask(null)
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
          {hasOpenTask && isCodeTaskOpen && <OpenMenu openLinks={openLinks} />}
          {hasOpenTask && isCodeTaskOpen && (
            <WorkbenchToggle
              isOpen={isWorkbenchOpen}
              onOpen={() => setIsWorkbenchOpen(true)}
              onClose={() => setIsWorkbenchOpen(false)}
            />
          )}
        </TopNavigation>
        <div className="flex flex-1 min-h-0">
          <div
            className="transition-all duration-300 ease-in-out flex flex-col min-h-0"
            style={{
              width: hasOpenTask && isCodeTaskOpen && isWorkbenchOpen ? '60%' : '100%',
            }}
          >
            <ChatArea
              teams={teams}
              isTeamsLoading={isTeamsLoading}
              selectedTeamForNewTask={_selectedTeamForNewTask}
              showRepositorySelector={showRepositorySelector}
              taskType={taskType}
              teamModeFilter={teamModeFilter}
              onShareButtonRender={handleShareButtonRender}
              onRefreshTeams={handleRefreshTeams}
              disabledReason={disabledReason}
              extension={{ teamEdit: teamEditExtension }}
            />
          </div>

          {hasOpenTask && isCodeTaskOpen && (
            <Workbench
              isOpen={isWorkbenchOpen}
              onClose={() => setIsWorkbenchOpen(false)}
              onOpen={() => setIsWorkbenchOpen(true)}
              workbenchData={workbenchData}
              isLoading={
                !workbenchData &&
                selectedTaskDetail?.status !== 'COMPLETED' &&
                selectedTaskDetail?.status !== 'FAILED' &&
                selectedTaskDetail?.status !== 'CANCELLED'
              }
              taskTitle={selectedTaskDetail?.title}
              taskNumber={selectedTaskDetail ? `#${selectedTaskDetail.id}` : undefined}
              blocks={blocksData}
              app={selectedTaskDetail?.app}
              taskStatus={selectedTaskDetail?.status}
            />
          )}
        </div>
      </div>
      {/* Create Group Chat Dialog */}
      {isCreateGroupChatOpen && (
        <CreateGroupChatDialog
          open={isCreateGroupChatOpen}
          onOpenChange={setIsCreateGroupChatOpen}
        />
      )}
      {/* Search Dialog - rendered at page level for global shortcut support */}
      {isSearchDialogOpen && (
        <SearchDialog
          open={isSearchDialogOpen}
          onOpenChange={setIsSearchDialogOpen}
          shortcutDisplayText={shortcutDisplayText}
          pageType="chat"
        />
      )}
    </div>
  )
}
