// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useState, useEffect, useCallback, useMemo } from 'react'
import { useParams, useRouter } from 'next/navigation'
import { ArrowLeft, FileText, Shield } from 'lucide-react'
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
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs'
import { saveLastTab } from '@/utils/userPreferences'
import { useUser } from '@/features/common/UserContext'
import { useTaskContext } from '@/features/tasks/contexts/taskContext'
import { useChatStreamContext } from '@/features/tasks/contexts/chatStreamContext'
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
 * Desktop-specific implementation of Knowledge Base Classic Page
 *
 * Classic layout (document list only, no chat):
 * - Left: TaskSidebar (resizable)
 * - Center: Document list with full management capabilities
 */
export function KnowledgeBaseClassicPageDesktop() {
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

  // Fetch user permission for this knowledge base
  const { myPermission, fetchMyPermission } = useKnowledgePermissions({
    kbId: knowledgeBaseId || 0,
  })

  // Fetch my permission when knowledge base is loaded
  useEffect(() => {
    if (knowledgeBase && knowledgeBaseId) {
      fetchMyPermission()
    }
  }, [knowledgeBase, knowledgeBaseId, fetchMyPermission])

  // User state
  const { user, isLoading: isUserLoading } = useUser()

  // Task context
  const { setSelectedTask } = useTaskContext()

  // Chat stream context
  const { clearAllStreams, stopStream, getStreamingTaskIds } = useChatStreamContext()

  // Tab state for documents/permissions
  const [activeTab, setActiveTab] = useState<'documents' | 'permissions'>('documents')

  // Collapsed sidebar state
  const [isCollapsed, setIsCollapsed] = useState(false)

  // Search dialog state
  const [isSearchDialogOpen, setIsSearchDialogOpen] = useState(false)

  const namespaceRoleMap = useNamespaceRoleMap()

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

  // Handle new task from collapsed sidebar button
  const handleNewTask = () => {
    // Clear state and navigate immediately for responsive UI
    setSelectedTask(null)
    clearAllStreams()
    router.push('/chat')

    // Stop streams in the background without blocking navigation
    const streamingIds = getStreamingTaskIds()
    Promise.all(streamingIds.map(id => stopStream(id))).catch(error => {
      console.error('Failed to stop streams:', error)
    })
  }

  // Check if user can manage this knowledge base
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

  // Loading state - wait for both knowledge base and user data
  if (kbLoading || isUserLoading) {
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
          title={knowledgeBase.name}
          onMobileSidebarToggle={() => {}}
          isSidebarCollapsed={isCollapsed}
        >
          <GithubStarButton />
        </TopNavigation>

        {/* Content area - Document List with optional Permission Management Tab */}
        <div className="flex-1 overflow-auto p-4 sm:p-6">
          {canManagePermissions ? (
            <Tabs
              value={activeTab}
              onValueChange={value => setActiveTab(value as 'documents' | 'permissions')}
              className="h-full flex flex-col"
            >
              <TabsList className="w-fit mb-4">
                <TabsTrigger value="documents" className="gap-1.5">
                  <FileText className="w-4 h-4" />
                  {t('chatPage.documents')}
                </TabsTrigger>
                <TabsTrigger value="permissions" className="gap-1.5">
                  <Shield className="w-4 h-4" />
                  {t('document.permission.management')}
                </TabsTrigger>
              </TabsList>
              <TabsContent value="documents" className="flex-1 mt-0">
                <DocumentList
                  knowledgeBase={knowledgeBase}
                  onBack={handleBack}
                  canUpload={canUploadDocuments}
                  canManageAllDocuments={canManageKb}
                />
              </TabsContent>
              <TabsContent value="permissions" className="flex-1 mt-0">
                <PermissionManagementTab kbId={knowledgeBase.id} />
              </TabsContent>
            </Tabs>
          ) : (
            <DocumentList
              knowledgeBase={knowledgeBase}
              onBack={handleBack}
              canUpload={canUploadDocuments}
              canManageAllDocuments={canManageKb}
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
