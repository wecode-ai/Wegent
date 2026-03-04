// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useState, useEffect, useCallback, useMemo } from 'react'
import { useRouter } from 'next/navigation'
import { teamService } from '@/features/tasks/service/teamService'
import TopNavigation from '@/features/layout/TopNavigation'
import { TaskSidebar, SearchDialog } from '@/features/tasks/components/sidebar'
import { ThemeToggle } from '@/features/theme/ThemeToggle'
import { Team } from '@/types/api'
import { useTaskContext } from '@/features/tasks/contexts/taskContext'
import { useChatStreamContext } from '@/features/tasks/contexts/chatStreamContext'
import { useSearchShortcut } from '@/features/tasks/hooks/useSearchShortcut'
import { ChatArea } from '@/features/tasks/components/chat'

/**
 * Mobile-specific implementation of Generate Page
 *
 * Optimized for screens ≤767px with:
 * - Slide-out drawer sidebar
 * - Touch-friendly controls (min 44px targets)
 * - Simplified navigation
 * - Mobile-optimized spacing
 *
 * This page supports video and image generation modes.
 * Teams are filtered based on the current generation mode.
 *
 * @see GeneratePageDesktop.tsx for desktop implementation
 */

/** Generation mode type - video or image */
type GenerateMode = 'video' | 'image'

const GENERATE_MODE_STORAGE_KEY = 'wegent_generate_last_mode'

function isGenerateMode(value: unknown): value is GenerateMode {
  return value === 'video' || value === 'image'
}

export function GeneratePageMobile() {
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
  const { clearAllStreams: _clearAllStreams } = useChatStreamContext()

  // Router for navigation
  const _router = useRouter()

  // Mobile sidebar state
  const [isMobileSidebarOpen, setIsMobileSidebarOpen] = useState(false)

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
          hideGroupChatOptions={true}
        >
          <ThemeToggle />
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
