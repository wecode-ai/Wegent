// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import { useSearchParams, useRouter } from 'next/navigation'
import { UserGroupIcon } from '@heroicons/react/24/outline'
import { teamService } from '@/features/tasks/service/teamService'
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
import { useChatStreamContext, useTaskStreamState } from '@/features/tasks/contexts/chatStreamContext'
import { paths } from '@/config/paths'
import { Button } from '@/components/ui/button'
import { useTranslation } from '@/hooks/useTranslation'
import { useSearchShortcut } from '@/features/tasks/hooks/useSearchShortcut'
import { ChatArea } from '@/features/tasks/components/chat'
import { CreateGroupChatDialog } from '@/features/tasks/components/group-chat'
import { CanvasPanel } from '@/features/canvas'
import { useCanvasIntegration } from '@/features/tasks/components/chat/useCanvasIntegration'
import type { Artifact } from '@/features/canvas/types'

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

  // Canvas state - similar to Workbench in CodePageDesktop
  const [isCanvasOpen, setIsCanvasOpen] = useState(false)

  // Get stream state for current task - this will update when messages change
  const currentTaskStreamState = useTaskStreamState(selectedTaskDetail?.id)

  // Canvas integration hook - reset lastProcessedArtifactRef when task changes
  const handleCanvasReset = useCallback(() => {
    lastProcessedArtifactRef.current = null
    setIsCanvasOpen(false)
  }, [])

  const canvas = useCanvasIntegration({
    taskId: selectedTaskDetail?.id,
    onSendMessage: async (_message: string) => {
      // Canvas quick actions will be handled by ChatArea
    },
    onReset: handleCanvasReset,
  })

  // Check if there are messages (for showing Canvas)
  const hasMessages = useMemo(() => {
    const taskId = selectedTaskDetail?.id
    if (!taskId) return false
    const hasSubtasks = selectedTaskDetail?.subtasks && selectedTaskDetail.subtasks.length > 0
    const hasStreamMessages = currentTaskStreamState?.messages && currentTaskStreamState.messages.size > 0
    return Boolean(hasSubtasks || hasStreamMessages)
  }, [selectedTaskDetail, currentTaskStreamState])

  // Track processed artifacts to avoid duplicate processing
  const lastProcessedArtifactRef = useRef<string | null>(null)

  // Extract artifact data from stream messages - similar to CodePageDesktop workbench extraction
  // Uses currentTaskStreamState which updates when messages change
  useEffect(() => {
    const currentTaskId = selectedTaskDetail?.id
    if (!currentTaskId) return

    if (!currentTaskStreamState?.messages || currentTaskStreamState.messages.size === 0) return

    // Find the latest AI message with artifact data
    let latestArtifact: Artifact | null = null

    for (const msg of currentTaskStreamState.messages.values()) {
      if (msg.type === 'ai' && msg.result) {
        const result = msg.result as { type?: string; artifact?: Artifact }
        if (result.type === 'artifact' && result.artifact) {
          latestArtifact = result.artifact
        }
      }
    }

    // Process artifact if found and different from last processed
    if (latestArtifact) {
      const artifactKey = `${latestArtifact.id}-${latestArtifact.version}`
      if (lastProcessedArtifactRef.current !== artifactKey) {
        console.log('[ChatPageDesktop] Processing artifact:', latestArtifact.id, 'version:', latestArtifact.version)
        canvas.processSubtaskResult({ type: 'artifact', artifact: latestArtifact })
        lastProcessedArtifactRef.current = artifactKey
      }
    }
  }, [selectedTaskDetail?.id, currentTaskStreamState, canvas])

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
      {/* Main content area */}
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
          <GithubStarButton />
        </TopNavigation>
        {/* Content area with split layout */}
        <div className="flex flex-1 min-h-0">
          {/* Chat area - affected by canvas */}
          <div
            className="transition-all duration-300 ease-in-out flex flex-col min-h-0"
            style={{
              width: hasOpenTask && hasMessages && isCanvasOpen ? '60%' : '100%',
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
              isCanvasOpen={isCanvasOpen}
              onCanvasToggle={() => setIsCanvasOpen(prev => !prev)}
              showCanvasToggle={hasOpenTask && hasMessages}
            />
          </div>

          {/* Canvas Panel - only show if there's a task with messages */}
          {hasOpenTask && hasMessages && (
            <div
              className="transition-all duration-300 ease-in-out bg-surface overflow-hidden"
              style={{ width: isCanvasOpen ? '40%' : '0' }}
            >
              {isCanvasOpen && (
                <CanvasPanel
                  artifact={canvas.artifact}
                  isLoading={canvas.isCanvasLoading}
                  onClose={() => setIsCanvasOpen(false)}
                  onArtifactUpdate={canvas.setArtifact}
                  onQuickAction={canvas.handleQuickAction}
                  onVersionRevert={canvas.handleVersionRevert}
                  isFullscreen={canvas.isFullscreen}
                  onToggleFullscreen={canvas.toggleFullscreen}
                />
              )}
            </div>
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
