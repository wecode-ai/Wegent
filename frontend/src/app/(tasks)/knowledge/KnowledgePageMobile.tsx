// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useState, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import TopNavigation from '@/features/layout/TopNavigation'
import { TaskSidebar } from '@/features/tasks/components/sidebar'
import { ThemeToggle } from '@/features/theme/ThemeToggle'
import { useTranslation } from '@/hooks/useTranslation'
import { saveLastTab } from '@/utils/userPreferences'
import { useUser } from '@/features/common/UserContext'
import { useChatStreamContext } from '@/features/tasks/contexts/chatStreamContext'
import { useTaskContext } from '@/features/tasks/contexts/taskContext'
import {
  WikiProjectList,
  AddRepoModal,
  useWikiProjects,
  CancelConfirmDialog,
  SearchBox,
  KnowledgeTabs,
  KnowledgeTabType,
  KnowledgeDocumentPage,
} from '@/features/knowledge'

/**
 * Mobile-specific implementation of Knowledge Page
 *
 * Optimized for screens ≤767px with:
 * - Slide-out drawer sidebar
 * - Touch-friendly controls (min 44px targets)
 * - Simplified navigation
 * - Mobile-optimized spacing and layout
 *
 * @see KnowledgePageDesktop.tsx for desktop implementation
 */
export function KnowledgePageMobile() {
  const { t } = useTranslation()
  const router = useRouter()
  const { user } = useUser()
  const { clearAllStreams: _clearAllStreams } = useChatStreamContext()
  const { setSelectedTask: _setSelectedTask } = useTaskContext()

  // Use shared Hook to manage all state and logic
  const {
    projects,
    loading,
    loadingMore,
    error,
    cancellingIds,
    hasMore,
    isModalOpen,
    formErrors,
    isSubmitting,
    confirmDialogOpen,
    selectedRepo,
    // Wiki config state (system-level configuration)
    wikiConfig,
    loadProjects,
    loadMoreProjects,
    handleAddRepo,
    handleCloseModal,
    handleRepoChange,
    handleSubmit,
    handleCancelClick,
    confirmCancelGeneration,
    setConfirmDialogOpen,
    setPendingCancelProjectId,
  } = useWikiProjects()

  // Active knowledge tab
  const [activeTab, setActiveTab] = useState<KnowledgeTabType>('document')

  // Search term for project list
  const [mainSearchTerm, setMainSearchTerm] = useState('')

  // Mobile sidebar state
  const [isMobileSidebarOpen, setIsMobileSidebarOpen] = useState(false)

  const navigateToKnowledgeDetail = (projectId: number) => {
    router.push(`/knowledge/${projectId}`)
  }

  const navigateToTask = (taskId: number) => {
    router.push(`/code?taskId=${taskId}`)
  }

  // Filter projects to show only those with user's generations
  // This ensures the knowledge page only shows projects created by the current user
  const userProjects = projects.filter(project => {
    // Check if user has any generations for this project
    return (
      project.generations &&
      project.generations.length > 0 &&
      (project.generations[0].status === 'RUNNING' ||
        project.generations[0].status === 'COMPLETED' ||
        project.generations[0].status === 'PENDING' ||
        project.generations[0].status === 'FAILED' ||
        project.generations[0].status === 'CANCELLED')
    )
  })

  useEffect(() => {
    saveLastTab('wiki')
  }, [])

  useEffect(() => {
    if (!user) return
    loadProjects()
  }, [user, loadProjects])

  return (
    <div className="flex smart-h-screen bg-base text-text-primary box-border">
      {/* Mobile sidebar - use TaskSidebar's built-in MobileSidebar component */}
      <TaskSidebar
        isMobileSidebarOpen={isMobileSidebarOpen}
        setIsMobileSidebarOpen={setIsMobileSidebarOpen}
        pageType="knowledge"
        isCollapsed={false}
        onToggleCollapsed={() => {}}
      />

      {/* Main content area */}
      <div className="flex-1 flex flex-col min-w-0">
        {/* Top navigation - mobile optimized */}
        <TopNavigation
          activePage="wiki"
          variant="with-sidebar"
          title={t('knowledge:title')}
          onMobileSidebarToggle={() => setIsMobileSidebarOpen(true)}
          isSidebarCollapsed={false}
        >
          <ThemeToggle />
        </TopNavigation>

        {/* Knowledge type tabs - mobile optimized */}
        <KnowledgeTabs activeTab={activeTab} onTabChange={setActiveTab} />

        {/* Content area based on active tab - mobile optimized padding */}
        <div className="flex-1 overflow-auto p-4">
          {activeTab === 'code' && (
            <>
              {/* Center search box - mobile optimized */}
              <SearchBox
                value={mainSearchTerm}
                onChange={setMainSearchTerm}
                placeholder={t('knowledge:search_repositories')}
                size="md"
                className="mb-4 w-full"
              />
              {/* Project list */}
              <WikiProjectList
                projects={userProjects}
                loading={loading}
                loadingMore={loadingMore}
                error={error}
                onAddRepo={handleAddRepo}
                onProjectClick={navigateToKnowledgeDetail}
                onTaskClick={navigateToTask}
                onCancelClick={handleCancelClick}
                cancellingIds={cancellingIds}
                searchTerm={mainSearchTerm}
                hasMore={hasMore}
                onLoadMore={loadMoreProjects}
                currentUserId={user?.id}
              />
            </>
          )}

          {activeTab === 'document' && <KnowledgeDocumentPage />}
        </div>
      </div>

      {/* Add repository modal */}
      <AddRepoModal
        isOpen={isModalOpen}
        onClose={handleCloseModal}
        formErrors={formErrors}
        isSubmitting={isSubmitting}
        onRepoChange={handleRepoChange}
        onSubmit={handleSubmit}
        selectedRepo={selectedRepo}
        wikiConfig={wikiConfig}
      />
      {/* Cancel confirm dialog */}
      <CancelConfirmDialog
        isOpen={confirmDialogOpen}
        onClose={() => {
          setConfirmDialogOpen(false)
          setPendingCancelProjectId(null)
        }}
        onConfirm={confirmCancelGeneration}
      />
    </div>
  )
}
