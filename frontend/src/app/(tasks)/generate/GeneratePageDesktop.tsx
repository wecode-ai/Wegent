// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useState, useEffect, useCallback, useMemo } from 'react'
import { useRouter } from 'next/navigation'
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
import { useTaskContext } from '@/features/tasks/contexts/taskContext'
import { useChatStreamContext } from '@/features/tasks/contexts/chatStreamContext'
import { paths } from '@/config/paths'
import { useSearchShortcut } from '@/features/tasks/hooks/useSearchShortcut'
import { ChatArea } from '@/features/tasks/components/chat'

/**
 * Desktop-specific implementation of Generate Page
 *
 * Optimized for screens ≥768px with:
 * - Resizable sidebar with collapse support
 * - Full navigation and toolbar
 * - Optimized spacing for larger screens
 *
 * This page supports video and image generation modes.
 * Teams are filtered to show only those that support video mode.
 *
 * @see GeneratePageMobile.tsx for mobile implementation
 */
/** Generation mode type - video or image */
type GenerateMode = 'video' | 'image'

const GENERATE_MODE_STORAGE_KEY = 'wegent_generate_last_mode'

function isGenerateMode(value: unknown): value is GenerateMode {
  return value === 'video' || value === 'image'
}

export function GeneratePageDesktop() {
  // Team state from service
  const { teams, isTeamsLoading, refreshTeams } = teamService.useTeams()

  // Generation mode state - video or image
  // Priority:
  // 1) Existing task's task_type (synced in useEffect below)
  // 2) Last user selection from localStorage
  // 3) Default to 'video'
  const [generateMode, setGenerateMode] = useState<GenerateMode>(() => {
    if (typeof window === 'undefined') return 'video'
    const saved = localStorage.getItem(GENERATE_MODE_STORAGE_KEY)
    return isGenerateMode(saved) ? saved : 'video'
  })

  // Filter teams based on current generation mode
  // Teams with empty bind_mode support all modes
  const filteredTeams = useMemo(() => {
    return teams.filter((team: Team) => {
      if (!team.bind_mode || team.bind_mode.length === 0) return true
      return (team.bind_mode as string[]).includes(generateMode)
    })
  }, [teams, generateMode])

  // Task context for refreshing task list
  const { refreshTasks, selectedTaskDetail, setSelectedTask, refreshSelectedTaskDetail } =
    useTaskContext()

  // Sync generate mode from task detail when entering from history (taskId in URL)
  useEffect(() => {
    const taskType = selectedTaskDetail?.task_type
    if (taskType === 'video' || taskType === 'image') {
      setGenerateMode(taskType)
    }
  }, [selectedTaskDetail?.id, selectedTaskDetail?.task_type])

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

  // Router for navigation
  const router = useRouter()

  // Collapsed sidebar state
  const [isCollapsed, setIsCollapsed] = useState(false)

  // Selected team state for sharing
  const [_selectedTeamForNewTask, _setSelectedTeamForNewTask] = useState<Team | null>(null)

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

  // Load collapsed state from localStorage
  useEffect(() => {
    const savedCollapsed = localStorage.getItem('task-sidebar-collapsed')
    if (savedCollapsed === 'true') {
      setIsCollapsed(true)
    }
  }, [])

  // Note: saveLastTab not called for generate page as it's a specialized mode

  const handleRefreshTeams = async (): Promise<Team[]> => {
    return await refreshTeams()
  }

  const handleGenerateModeChange = useCallback((mode: GenerateMode) => {
    setGenerateMode(mode)
    if (typeof window !== 'undefined') {
      localStorage.setItem(GENERATE_MODE_STORAGE_KEY, mode)
    }
  }, [])

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
    router.replace(paths.generate.getHref())
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
          hideGroupChatOptions={true}
        >
          <GithubStarButton />
        </TopNavigation>
        {/* Chat area with current generation mode */}
        <ChatArea
          teams={filteredTeams}
          isTeamsLoading={isTeamsLoading}
          selectedTeamForNewTask={_selectedTeamForNewTask}
          showRepositorySelector={false}
          taskType={generateMode}
          onRefreshTeams={handleRefreshTeams}
          onGenerateModeChange={handleGenerateModeChange}
        />
      </div>
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
