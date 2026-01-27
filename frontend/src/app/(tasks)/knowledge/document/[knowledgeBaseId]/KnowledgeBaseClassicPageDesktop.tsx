// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useState, useEffect, useCallback, useMemo } from 'react'
import { useParams, useRouter } from 'next/navigation'
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
import { useSearchShortcut } from '@/features/tasks/hooks/useSearchShortcut'
import { useTranslation } from '@/hooks/useTranslation'
import { useKnowledgeBaseDetail } from '@/features/knowledge/document/hooks'
import { DocumentList } from '@/features/knowledge/document/components'
import { listGroups } from '@/apis/groups'
import type { GroupRole } from '@/types/group'
interface KnowledgeBaseClassicPageDesktopProps {
  /** Callback when knowledge base type is changed (notebook <-> classic) */
  onKbTypeChanged?: () => void
}

/**
 * Desktop-specific implementation of Knowledge Base Classic Page
 *
 * Classic layout (document list only, no chat):
 * - Left: TaskSidebar (resizable)
 * - Center: Document list with full management capabilities
 */
export function KnowledgeBaseClassicPageDesktop({
  onKbTypeChanged,
}: KnowledgeBaseClassicPageDesktopProps) {
  const { t } = useTranslation('knowledge')
  const router = useRouter()
  const params = useParams()

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

  // User state
  const { user } = useUser()

  // Collapsed sidebar state
  const [isCollapsed, setIsCollapsed] = useState(false)

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

  const handleToggleCollapsed = () => {
    setIsCollapsed(prev => {
      const newValue = !prev
      localStorage.setItem('task-sidebar-collapsed', String(newValue))
      return newValue
    })
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
        <CollapsedSidebarButtons onExpand={handleToggleCollapsed} onNewTask={() => {}} />
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
          title={knowledgeBase.name}
          onMobileSidebarToggle={() => {}}
          isSidebarCollapsed={isCollapsed}
        >
          <GithubStarButton />
        </TopNavigation>

        {/* Content area - Document List */}
        <div className="flex-1 overflow-auto p-4 sm:p-6">
          <DocumentList
            knowledgeBase={knowledgeBase}
            onBack={handleBack}
            canManage={canManageKb}
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
