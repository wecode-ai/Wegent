// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useState, useEffect, useCallback, useMemo } from 'react'
import { useParams, useRouter, useSearchParams } from 'next/navigation'
import { ArrowLeft } from 'lucide-react'
import TopNavigation from '@/features/layout/TopNavigation'
import {
  TaskSidebar,
  ResizableSidebar,
  CollapsedSidebarButtons,
  SearchDialog,
} from '@/features/tasks/components/sidebar'
import { GithubStarButton } from '@/features/layout/GithubStarButton'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { saveLastTab } from '@/utils/userPreferences'
import { useUser } from '@/features/common/UserContext'
import { useTaskContext } from '@/features/tasks/contexts/taskContext'
import { useChatStreamContext } from '@/features/tasks/contexts/chatStreamContext'
import { useSearchShortcut } from '@/features/tasks/hooks/useSearchShortcut'
import { useTranslation } from '@/hooks/useTranslation'
import { ChatArea } from '@/features/tasks/components/chat'
import { teamService } from '@/features/tasks/service/teamService'
import { useKnowledgeBaseDetail } from '@/features/knowledge/document/hooks'
import { DocumentPanel, KnowledgeBaseSummaryCard } from '@/features/knowledge/document/components'
import { BoundKnowledgeBaseSummary } from '@/features/tasks/components/group-chat'
import { taskKnowledgeBaseApi } from '@/apis/task-knowledge-base'
import { listGroups } from '@/apis/groups'
import type { Team } from '@/types/api'
import type { GroupRole } from '@/types/group'

interface KnowledgeBaseChatPageDesktopProps {
  /** Callback when knowledge base type is changed (notebook <-> classic) */
  onKbTypeChanged?: () => void
}

/**
 * Desktop-specific implementation of Knowledge Base Chat Page
 *
 * Three-column layout:
 * - Left: TaskSidebar (resizable)
 * - Center: Chat area with KB summary
 * - Right: Document management panel (resizable, collapsible)
 */
export function KnowledgeBaseChatPageDesktop({
  onKbTypeChanged,
}: KnowledgeBaseChatPageDesktopProps) {
  const { t } = useTranslation('knowledge')
  const router = useRouter()
  const params = useParams()
  const searchParams = useSearchParams()

  // Parse knowledge base ID from URL
  const knowledgeBaseId = params.knowledgeBaseId
    ? parseInt(params.knowledgeBaseId as string, 10)
    : null

  // State for selected document IDs from DocumentPanel (for notebook mode context injection)
  const [selectedDocumentIds, setSelectedDocumentIds] = useState<number[]>([])

  // Fetch knowledge base details
  const {
    knowledgeBase,
    loading: kbLoading,
    error: kbError,
  } = useKnowledgeBaseDetail({
    knowledgeBaseId: knowledgeBaseId || 0,
    autoLoad: !!knowledgeBaseId,
  })

  // Team state from service
  const { teams, isTeamsLoading, refreshTeams } = teamService.useTeams()

  // User state
  const { user } = useUser()

  // Task context
  const { refreshTasks, selectedTaskDetail, setSelectedTask, refreshSelectedTaskDetail } =
    useTaskContext()

  // Get current task title for navigation
  const currentTaskTitle = selectedTaskDetail?.title

  // Handle task deletion
  const handleTaskDeleted = () => {
    setSelectedTask(null)
    refreshTasks()
  }

  // Handle members changed
  const handleMembersChanged = () => {
    refreshTasks()
    refreshSelectedTaskDetail(false)
  }

  // Chat stream context
  const { clearAllStreams } = useChatStreamContext()

  // Check if a task is currently open
  const taskId =
    searchParams.get('task_id') || searchParams.get('taskid') || searchParams.get('taskId')
  const hasOpenTask = !!taskId

  // Collapsed sidebar state
  const [isCollapsed, setIsCollapsed] = useState(false)

  // Share button state
  const [shareButton, setShareButton] = useState<React.ReactNode>(null)

  // Search dialog state
  const [isSearchDialogOpen, setIsSearchDialogOpen] = useState(false)

  // Group role map for permission checking
  const [groupRoleMap, setGroupRoleMap] = useState<Map<string, GroupRole>>(new Map())

  // Fetch all groups and build role map for permission checking
  useEffect(() => {
    listGroups()
      .then(response => {
        const roleMap = new Map<string, GroupRole>()
        response.items.forEach(group => {
          if (group.my_role) {
            roleMap.set(group.name, group.my_role)
          }
        })
        setGroupRoleMap(roleMap)
      })
      .catch(error => {
        console.error('Failed to load groups for role map:', error)
      })
  }, [])

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

  // Filter teams for knowledge mode
  const filteredTeams = useMemo(() => {
    return teams.filter(team => {
      if (Array.isArray(team.bind_mode) && team.bind_mode.length === 0) return false
      if (!team.bind_mode) return true
      return team.bind_mode.includes('knowledge')
    })
  }, [teams])

  // Load collapsed state from localStorage
  useEffect(() => {
    const savedCollapsed = localStorage.getItem('task-sidebar-collapsed')
    if (savedCollapsed === 'true') {
      setIsCollapsed(true)
    }
  }, [])

  // Save last active tab
  useEffect(() => {
    saveLastTab('wiki')
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

  // Handle new task from collapsed sidebar
  const handleNewTask = () => {
    setSelectedTask(null)
    clearAllStreams()
    // Stay on current page but clear task selection
    router.replace(`/knowledge/document/${knowledgeBaseId}`)
  }

  // Handle back to knowledge list
  const handleBack = () => {
    router.back()
  }

  // Check if user can manage this knowledge base
  const canManageKb = useMemo(() => {
    if (!knowledgeBase || !user) return false
    // Personal knowledge base - check user ownership
    if (knowledgeBase.namespace === 'default') {
      return knowledgeBase.user_id === user.id
    }
    // Group knowledge base - check group role
    // Developer or higher can edit, Maintainer or higher can delete
    const groupRole = groupRoleMap.get(knowledgeBase.namespace)
    return groupRole === 'Owner' || groupRole === 'Maintainer' || groupRole === 'Developer'
  }, [knowledgeBase, user, groupRoleMap])

  // Loading state
  if (kbLoading) {
    return (
      <div className="flex smart-h-screen bg-base text-text-primary items-center justify-center">
        <Spinner />
      </div>
    )
  }

  // Error state
  if (kbError || !knowledgeBase) {
    return (
      <div className="flex smart-h-screen bg-base text-text-primary items-center justify-center">
        <div className="text-center">
          <p className="text-text-muted mb-4">{kbError || t('chatPage.notFound')}</p>
          <Button variant="outline" onClick={handleBack}>
            <ArrowLeft className="w-4 h-4 mr-2" />
            {t('chatPage.backToList')}
          </Button>
        </div>
      </div>
    )
  }

  return (
    <div className="flex smart-h-screen bg-base text-text-primary box-border">
      {/* Collapsed sidebar floating buttons */}
      {isCollapsed && (
        <CollapsedSidebarButtons onExpand={handleToggleCollapsed} onNewTask={handleNewTask} />
      )}

      {/* Resizable left sidebar */}
      <ResizableSidebar isCollapsed={isCollapsed} onToggleCollapsed={handleToggleCollapsed}>
        <TaskSidebar
          isMobileSidebarOpen={false}
          setIsMobileSidebarOpen={() => {}}
          pageType="knowledge"
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
          activePage="wiki"
          variant="with-sidebar"
          title={currentTaskTitle || knowledgeBase.name}
          titleSuffix={
            hasOpenTask ? <BoundKnowledgeBaseSummary knowledgeBase={knowledgeBase} /> : undefined
          }
          taskDetail={selectedTaskDetail}
          onMobileSidebarToggle={() => {}}
          onTaskDeleted={handleTaskDeleted}
          onMembersChanged={handleMembersChanged}
          isSidebarCollapsed={isCollapsed}
          hideGroupChatOptions={true}
        >
          {shareButton}
          <GithubStarButton />
        </TopNavigation>

        {/* Content area - Chat with KB summary */}
        <div className="flex-1 flex min-h-0">
          {/* Chat area */}
          <div className="flex-1 flex flex-col min-w-0">
            {/* KB Summary Card - shown when no task is selected */}
            {!hasOpenTask && (
              <div className="px-4 sm:px-6 pt-6">
                <KnowledgeBaseSummaryCard knowledgeBase={knowledgeBase} />
              </div>
            )}
            <ChatArea
              teams={filteredTeams}
              isTeamsLoading={isTeamsLoading}
              showRepositorySelector={false}
              taskType="knowledge"
              knowledgeBaseId={knowledgeBase.id}
              onShareButtonRender={handleShareButtonRender}
              onRefreshTeams={handleRefreshTeams}
              initialKnowledgeBase={{
                id: knowledgeBase.id,
                name: knowledgeBase.name,
                namespace: knowledgeBase.namespace,
                document_count: knowledgeBase.document_count,
              }}
              selectedDocumentIds={selectedDocumentIds}
              onTaskCreated={async (taskId: number) => {
                // Bind the knowledge base to the newly created task
                try {
                  await taskKnowledgeBaseApi.bindKnowledgeBase(
                    taskId,
                    knowledgeBase.name,
                    knowledgeBase.namespace
                  )
                } catch (error) {
                  console.error('Failed to bind knowledge base to task:', error)
                }
              }}
            />
          </div>

          {/* Right panel - Document management */}
          <DocumentPanel
            knowledgeBase={knowledgeBase}
            canManage={canManageKb}
            onDocumentSelectionChange={setSelectedDocumentIds}
            onNewChat={handleNewTask}
            onTypeConverted={() => {
              // Notify parent page.tsx to refresh and re-route based on new kb_type
              onKbTypeChanged?.()
            }}
          />
        </div>
      </div>

      {/* Search Dialog */}
      <SearchDialog
        open={isSearchDialogOpen}
        onOpenChange={setIsSearchDialogOpen}
        shortcutDisplayText={shortcutDisplayText}
        pageType="chat"
      />
    </div>
  )
}
