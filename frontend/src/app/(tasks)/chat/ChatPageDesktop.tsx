// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useState, useEffect, useCallback, useRef } from 'react'
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
import { useChatStreamContext, useTaskStreamState, computeIsStreaming } from '@/features/tasks/contexts/chatStreamContext'
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

  // Canvas state - two separate concerns:
  // 1. canvasEnabled: session-level toggle (locked once chat starts)
  // 2. isCanvasOpen: whether the canvas panel is visible
  // Note: canvasEnabled is now managed by useCanvasIntegration for unified state
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

  // Track processed artifacts to avoid duplicate processing
  // Format: "artifactId-version-contentLength" to detect content updates during streaming
  const lastProcessedArtifactRef = useRef<string | null>(null)

  // Helper function to extract artifact from thinking steps
  // During streaming, artifact data comes in thinking steps as tool_result output
  const extractArtifactFromThinking = (thinking: unknown[] | undefined): Artifact | null => {
    if (!thinking || !Array.isArray(thinking)) return null

    // Iterate in reverse to find the latest artifact
    for (let i = thinking.length - 1; i >= 0; i--) {
      const step = thinking[i] as {
        details?: {
          type?: string
          tool_name?: string
          output?: string | { artifact?: Artifact }
        }
      }

      // Check if this is a tool_result for create_artifact or update_artifact
      if (
        step.details?.type === 'tool_result' &&
        (step.details.tool_name === 'create_artifact' || step.details.tool_name === 'update_artifact')
      ) {
        const output = step.details.output
        if (!output) continue

        try {
          // Output can be a string (JSON) or already parsed object
          let artifactData: { artifact?: Artifact }
          if (typeof output === 'string') {
            artifactData = JSON.parse(output)
          } else {
            artifactData = output
          }

          if (artifactData.artifact) {
            return artifactData.artifact
          }
        } catch {
          // JSON parse error, skip this step
          continue
        }
      }
    }

    return null
  }

  // Extract artifact data from stream messages - works during streaming and after completion
  // Uses currentTaskStreamState which updates when messages change
  useEffect(() => {
    const currentTaskId = selectedTaskDetail?.id
    if (!currentTaskId) return

    if (!currentTaskStreamState?.messages || currentTaskStreamState.messages.size === 0) return

    // Find the latest AI message with artifact data
    let latestArtifact: Artifact | null = null

    for (const msg of currentTaskStreamState.messages.values()) {
      if (msg.type === 'ai') {
        // First check the result field (for completed messages)
        if (msg.result) {
          const result = msg.result as { type?: string; artifact?: Artifact; thinking?: unknown[] }
          if (result.type === 'artifact' && result.artifact) {
            latestArtifact = result.artifact
          }

          // Also check thinking steps for real-time updates during streaming
          const thinkingArtifact = extractArtifactFromThinking(result.thinking)
          if (thinkingArtifact) {
            // Use thinking artifact if it has more recent content (longer or same version)
            if (!latestArtifact ||
                thinkingArtifact.version > latestArtifact.version ||
                (thinkingArtifact.version === latestArtifact.version &&
                 thinkingArtifact.content.length > latestArtifact.content.length)) {
              latestArtifact = thinkingArtifact
            }
          }
        }
      }
    }

    // Process artifact if found and different from last processed
    // Use content length as part of key to detect partial updates during streaming
    if (latestArtifact) {
      const artifactKey = `${latestArtifact.id}-${latestArtifact.version}-${latestArtifact.content.length}`
      if (lastProcessedArtifactRef.current !== artifactKey) {
        console.log('[ChatPageDesktop] Processing artifact:', latestArtifact.id, 'version:', latestArtifact.version, 'contentLen:', latestArtifact.content.length)
        canvas.processSubtaskResult({ type: 'artifact', artifact: latestArtifact })
        lastProcessedArtifactRef.current = artifactKey
      }
    }
  }, [selectedTaskDetail?.id, currentTaskStreamState?.messages, canvas.processSubtaskResult])

  // Track previous streaming state to detect when streaming completes
  const wasStreamingRef = useRef(false)

  // Fetch artifact with versions from API when streaming completes
  // This updates the artifact with full version history from the backend
  useEffect(() => {
    const isCurrentlyStreaming = computeIsStreaming(currentTaskStreamState?.messages)

    // Detect streaming completion: was streaming, now not streaming
    if (wasStreamingRef.current && !isCurrentlyStreaming && canvas.artifact) {
      console.log('[ChatPageDesktop] Streaming completed, fetching artifact with versions')
      canvas.fetchArtifactWithVersions()
    }

    wasStreamingRef.current = isCurrentlyStreaming
  }, [currentTaskStreamState?.messages, canvas.artifact, canvas.fetchArtifactWithVersions])

  // Auto-open canvas panel when artifact is loaded (from streaming or saved data)
  useEffect(() => {
    if (canvas.artifact && !isCanvasOpen) {
      setIsCanvasOpen(true)
    }
  }, [canvas.artifact]) // eslint-disable-line react-hooks/exhaustive-deps
  // Note: Only trigger when artifact changes, not when isCanvasOpen changes

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
              width: isCanvasOpen ? '60%' : '100%',
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
              canvasEnabled={canvas.canvasEnabled}
              onCanvasEnabledChange={canvas.setCanvasEnabled}
              isCanvasOpen={isCanvasOpen}
              onCanvasOpenChange={setIsCanvasOpen}
            />
          </div>

          {/* Canvas Panel - show when canvas is open */}
          {isCanvasOpen && (
            <div
              className="transition-all duration-300 ease-in-out bg-surface overflow-hidden"
              style={{ width: '40%' }}
            >
              <CanvasPanel
                artifact={canvas.artifact}
                isLoading={canvas.isCanvasLoading}
                onClose={() => setIsCanvasOpen(false)}
                onArtifactUpdate={canvas.setArtifact}
                onVersionRevert={canvas.handleVersionRevert}
                isFullscreen={canvas.isFullscreen}
                onToggleFullscreen={canvas.toggleFullscreen}
              />
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
