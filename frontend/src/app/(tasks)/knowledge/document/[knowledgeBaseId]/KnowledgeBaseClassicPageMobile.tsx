// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useState, useEffect, useCallback, useMemo } from 'react'
import { useParams, useRouter } from 'next/navigation'
import { ArrowLeft } from 'lucide-react'
import TopNavigation from '@/features/layout/TopNavigation'
import { TaskSidebar, SearchDialog } from '@/features/tasks/components/sidebar'
import { ThemeToggle } from '@/features/theme/ThemeToggle'
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
interface KnowledgeBaseClassicPageMobileProps {
  /** Callback when knowledge base type is changed (notebook <-> classic) */
  onKbTypeChanged?: () => void
}

/**
 * Mobile-specific implementation of Knowledge Base Classic Page
 *
 * Classic layout (document list only, no chat):
 * - Slide-out drawer sidebar (left)
 * - Full-screen document list
 * - Touch-friendly controls (min 44px targets)
 */
export function KnowledgeBaseClassicPageMobile({
  onKbTypeChanged,
}: KnowledgeBaseClassicPageMobileProps) {
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

  // Mobile sidebar state
  const [isMobileSidebarOpen, setIsMobileSidebarOpen] = useState(false)

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

  // Save last active tab
  useEffect(() => {
    saveLastTab('wiki')
  }, [])

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
          title={knowledgeBase.name}
          onMobileSidebarToggle={() => setIsMobileSidebarOpen(true)}
          isSidebarCollapsed={false}
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
          <ThemeToggle />
        </TopNavigation>

        {/* Document List */}
        <div className="flex-1 overflow-auto p-4">
          <DocumentList
            knowledgeBase={knowledgeBase}
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
