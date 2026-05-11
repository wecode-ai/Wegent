// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useState, useEffect, useCallback, useMemo } from 'react'
import { useRouter } from 'next/navigation'
import { ArrowLeft } from 'lucide-react'
import TopNavigation from '@/features/layout/TopNavigation'
import { TaskSidebar, SearchDialog } from '@/features/tasks/components/sidebar'
import { ThemeToggle } from '@/features/theme/ThemeToggle'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs'
import { saveLastTab } from '@/utils/userPreferences'
import { useUser } from '@/features/common/UserContext'
import { useSearchShortcut } from '@/features/tasks/hooks/useSearchShortcut'
import { useTranslation } from '@/hooks/useTranslation'
import { useKnowledgeBaseDetail } from '@/features/knowledge/document/hooks'
import { useNamespaceRoleMap } from '@/features/knowledge/document/hooks/useNamespaceRoleMap'
import { useKnowledgePermissions } from '@/features/knowledge/permission/hooks/useKnowledgePermissions'
import { DocumentList } from '@/features/knowledge/document/components'
import { PermissionManagementTab } from '@/features/knowledge/permission/components/PermissionManagementTab'
import {
  canManageKnowledgeBase,
  canManageKnowledgeBaseDocuments,
  canManageKnowledgeBasePermissions,
} from '@/utils/namespace-permissions'
/**
 * Mobile-specific implementation of Knowledge Base Classic Page
 *
 * Classic layout (document list only, no chat):
 * - Slide-out drawer sidebar (left)
 * - Full-screen document list
 * - Touch-friendly controls (min 44px targets)
 */
interface Props {
  knowledgeBaseId: number
  /** Initial document path to auto-open (from virtual URL path segments) */
  initialDocPath?: string
}

export function KnowledgeBaseClassicPageMobile({ knowledgeBaseId, initialDocPath }: Props) {
  const { t } = useTranslation('knowledge')
  const router = useRouter()

  // Fetch knowledge base details
  const {
    knowledgeBase,
    loading: kbLoading,
    error: kbError,
  } = useKnowledgeBaseDetail({
    knowledgeBaseId,
    autoLoad: true,
  })

  const { myPermission, fetchMyPermission } = useKnowledgePermissions({
    kbId: knowledgeBaseId,
  })

  useEffect(() => {
    if (knowledgeBase) {
      fetchMyPermission()
    }
  }, [knowledgeBase, fetchMyPermission])

  // User state
  const { user } = useUser()

  // Mobile sidebar state
  const [isMobileSidebarOpen, setIsMobileSidebarOpen] = useState(false)

  // Search dialog state
  const [isSearchDialogOpen, setIsSearchDialogOpen] = useState(false)

  // Tab state for permission management
  const [activeTab, setActiveTab] = useState<'documents' | 'permissions'>('documents')

  const namespaceRoleMap = useNamespaceRoleMap()

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
    return canManageKnowledgeBase({
      currentUserId: user.id,
      knowledgeBase,
      knowledgeRole: myPermission?.role,
      namespaceRole: namespaceRoleMap.get(knowledgeBase.namespace),
    })
  }, [knowledgeBase, user, myPermission?.role, namespaceRoleMap])

  const canUploadDocuments = useMemo(() => {
    if (!knowledgeBase || !user) return false
    return canManageKnowledgeBaseDocuments({
      currentUserId: user.id,
      knowledgeBase,
      knowledgeRole: myPermission?.role,
      namespaceRole: namespaceRoleMap.get(knowledgeBase.namespace),
    })
  }, [knowledgeBase, user, myPermission?.role, namespaceRoleMap])

  // Check if user can manage permissions (creator, namespace manager, or KB manager)
  const canManagePermissions = useMemo(() => {
    if (!knowledgeBase || !user) return false
    return canManageKnowledgeBasePermissions({
      currentUserId: user.id,
      knowledgeBase,
      knowledgeRole: myPermission?.role,
      namespaceRole: namespaceRoleMap.get(knowledgeBase.namespace),
    })
  }, [knowledgeBase, user, myPermission?.role, namespaceRoleMap])

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

        {/* Document List / Permission Management */}
        <div className="flex-1 overflow-auto p-4">
          {canManagePermissions ? (
            <Tabs
              value={activeTab}
              onValueChange={v => setActiveTab(v as 'documents' | 'permissions')}
            >
              <TabsList className="w-full mb-4">
                <TabsTrigger value="documents" className="flex-1 gap-1.5">
                  {t('knowledge:document.documents')}
                </TabsTrigger>
                <TabsTrigger value="permissions" className="flex-1 gap-1.5">
                  {t('knowledge:document.permissions')}
                </TabsTrigger>
              </TabsList>
              <TabsContent value="documents" className="mt-0">
                <DocumentList
                  knowledgeBase={knowledgeBase}
                  canUpload={canUploadDocuments}
                  canManageAllDocuments={canManageKb}
                  initialDocPath={initialDocPath}
                />
              </TabsContent>
              <TabsContent value="permissions" className="mt-0">
                <PermissionManagementTab
                  kbId={knowledgeBase.id}
                  kbNamespace={knowledgeBase.namespace}
                />
              </TabsContent>
            </Tabs>
          ) : (
            <DocumentList
              knowledgeBase={knowledgeBase}
              canUpload={canUploadDocuments}
              canManageAllDocuments={canManageKb}
              initialDocPath={initialDocPath}
            />
          )}
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
