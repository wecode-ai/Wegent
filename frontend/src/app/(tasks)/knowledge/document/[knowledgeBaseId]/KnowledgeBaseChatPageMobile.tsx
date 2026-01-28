// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useState, useEffect, useCallback, useMemo } from 'react'
import { useParams, useRouter, useSearchParams } from 'next/navigation'
import { ArrowLeft, FileText, X } from 'lucide-react'
import TopNavigation from '@/features/layout/TopNavigation'
import { TaskSidebar, SearchDialog } from '@/features/tasks/components/sidebar'
import { ThemeToggle } from '@/features/theme/ThemeToggle'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import {
  Drawer,
  DrawerContent,
  DrawerHeader,
  DrawerTitle,
  DrawerClose,
} from '@/components/ui/drawer'
import { saveLastTab } from '@/utils/userPreferences'
import { useUser } from '@/features/common/UserContext'
import { useTaskContext } from '@/features/tasks/contexts/taskContext'
import { useChatStreamContext } from '@/features/tasks/contexts/chatStreamContext'
import { useSearchShortcut } from '@/features/tasks/hooks/useSearchShortcut'
import { useTranslation } from '@/hooks/useTranslation'
import { ChatArea } from '@/features/tasks/components/chat'
import { teamService } from '@/features/tasks/service/teamService'
import { useKnowledgeBaseDetail } from '@/features/knowledge/document/hooks'
import { DocumentList, KnowledgeBaseSummaryCard } from '@/features/knowledge/document/components'
import { BoundKnowledgeBaseSummary } from '@/features/tasks/components/group-chat'
import { taskKnowledgeBaseApi } from '@/apis/task-knowledge-base'
import { listGroups } from '@/apis/groups'
import type { Team } from '@/types/api'
import type { GroupRole } from '@/types/group'
interface KnowledgeBaseChatPageMobileProps {
  /** Callback when knowledge base type is changed (notebook <-> classic) */
  onKbTypeChanged?: () => void
}

/**
 * Mobile-specific implementation of Knowledge Base Chat Page
 *
 * Features:
 * - Slide-out drawer sidebar (left)
 * - Slide-out document drawer (right)
 * - Touch-friendly controls (min 44px targets)
 * - Full-screen chat area
 */
export function KnowledgeBaseChatPageMobile({ onKbTypeChanged }: KnowledgeBaseChatPageMobileProps) {
  const { t } = useTranslation('knowledge')
  const router = useRouter()
  const params = useParams()
  const searchParams = useSearchParams()

  // Parse knowledge base ID from URL
  const knowledgeBaseId = params.knowledgeBaseId
    ? parseInt(params.knowledgeBaseId as string, 10)
    : null

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

  // Get current task title
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
  const { clearAllStreams: _clearAllStreams } = useChatStreamContext()

  // Check if a task is open
  const taskId =
    searchParams.get('task_id') || searchParams.get('taskid') || searchParams.get('taskId')
  const hasOpenTask = !!taskId

  // Mobile sidebar state
  const [isMobileSidebarOpen, setIsMobileSidebarOpen] = useState(false)

  // Document drawer state
  const [isDocumentDrawerOpen, setIsDocumentDrawerOpen] = useState(false)

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

  // Toggle search dialog
  const toggleSearchDialog = useCallback(() => {
    setIsSearchDialogOpen(prev => !prev)
  }, [])

  // Search shortcut
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

  // Save last active tab
  useEffect(() => {
    saveLastTab('wiki')
  }, [])

  const handleRefreshTeams = async (): Promise<Team[]> => {
    return await refreshTeams()
  }

  // Handle back to knowledge list
  const handleBack = () => {
    router.back()
  }

  // Check if user can manage this KB
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
        <div className="text-center p-4">
          <p className="text-text-muted mb-4">{kbError || t('chatPage.notFound')}</p>
          <Button variant="outline" onClick={handleBack} className="h-11 min-w-[44px]">
            <ArrowLeft className="w-4 h-4 mr-2" />
            {t('chatPage.backToList')}
          </Button>
        </div>
      </div>
    )
  }

  return (
    <div className="flex smart-h-screen bg-base text-text-primary box-border">
      {/* Mobile sidebar */}
      <TaskSidebar
        isMobileSidebarOpen={isMobileSidebarOpen}
        setIsMobileSidebarOpen={setIsMobileSidebarOpen}
        pageType="knowledge"
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
          activePage="wiki"
          variant="with-sidebar"
          title={currentTaskTitle || knowledgeBase.name}
          titleSuffix={
            hasOpenTask ? <BoundKnowledgeBaseSummary knowledgeBase={knowledgeBase} /> : undefined
          }
          taskDetail={selectedTaskDetail}
          onMobileSidebarToggle={() => setIsMobileSidebarOpen(true)}
          onTaskDeleted={handleTaskDeleted}
          onMembersChanged={handleMembersChanged}
          isSidebarCollapsed={false}
          hideGroupChatOptions={true}
        >
          {/* Back button */}
          <Button
            variant="ghost"
            size="sm"
            onClick={handleBack}
            className="h-11 min-w-[44px] px-2 rounded-[7px]"
          >
            <ArrowLeft className="h-4 w-4" />
          </Button>
          {/* Document drawer button */}
          <Button
            variant="outline"
            size="sm"
            onClick={() => setIsDocumentDrawerOpen(true)}
            className="h-11 min-w-[44px] px-2 rounded-[7px]"
          >
            <FileText className="h-4 w-4" />
          </Button>
          {shareButton}
          <ThemeToggle />
        </TopNavigation>

        {/* Chat area with KB summary */}
        <div className="flex-1 flex flex-col min-h-0">
          {/* KB Summary Card - shown when no task is selected */}
          {!hasOpenTask && (
            <div className="px-4 pt-4">
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
      </div>

      {/* Document Drawer */}
      <Drawer open={isDocumentDrawerOpen} onOpenChange={setIsDocumentDrawerOpen}>
        <DrawerContent className="max-h-[85vh]">
          <DrawerHeader className="flex items-center justify-between border-b border-border pb-3">
            <DrawerTitle className="flex items-center gap-2">
              <FileText className="w-5 h-5 text-primary" />
              {t('chatPage.documents')}
            </DrawerTitle>
            <DrawerClose asChild>
              <Button variant="ghost" size="sm" className="h-11 min-w-[44px]">
                <X className="h-5 w-5" />
              </Button>
            </DrawerClose>
          </DrawerHeader>
          <div className="p-4 overflow-auto flex-1">
            <DocumentList
              knowledgeBase={knowledgeBase}
              canManage={canManageKb}
              onTypeConverted={() => {
                // Notify parent page.tsx to refresh and re-route based on new kb_type
                onKbTypeChanged?.()
              }}
            />
          </div>
        </DrawerContent>
      </Drawer>

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
