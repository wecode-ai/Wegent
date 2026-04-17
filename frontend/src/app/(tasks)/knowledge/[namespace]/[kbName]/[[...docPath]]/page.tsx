// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

/**
 * Knowledge Base Virtual URL Page
 *
 * Renders the full /knowledge page layout (with KB tree sidebar) and auto-selects
 * the KB identified by namespace + kbName from the URL path.
 *
 * Handles three URL formats:
 *   /knowledge/default/{kbName}           → Personal KB (current user, namespace="default")
 *   /knowledge/public/{kbName}            → Organization KB (globally unique)
 *   /knowledge/{namespace}/{kbName}       → Team KB (namespace=team name)
 *
 * With optional document path:
 *   /knowledge/default/{kbName}/path/doc.md
 *   /knowledge/public/{kbName}/path/doc.md
 *   /knowledge/{namespace}/{kbName}/path/doc.md
 */

import { Suspense, useState, useCallback, useEffect } from 'react'
import { useParams, useRouter } from 'next/navigation'
import TopNavigation from '@/features/layout/TopNavigation'
import {
  TaskSidebar,
  ResizableSidebar,
  CollapsedSidebarButtons,
} from '@/features/tasks/components/sidebar'
import { TaskParamSync } from '@/features/tasks/components/params'
import '@/app/tasks/tasks.css'
import '@/features/common/scrollbar.css'
import { GithubStarButton } from '@/features/layout/GithubStarButton'
import { ThemeToggle } from '@/features/theme/ThemeToggle'
import { saveLastTab } from '@/utils/userPreferences'
import { useIsMobile } from '@/features/layout/hooks/useMediaQuery'
import { useChatStreamContext } from '@/features/tasks/contexts/chatStreamContext'
import { useTaskContext } from '@/features/tasks/contexts/taskContext'
import { paths } from '@/config/paths'
import { Spinner } from '@/components/ui/spinner'
import {
  AddRepoModal,
  useWikiProjects,
  CancelConfirmDialog,
  KnowledgeTabs,
  KnowledgeDocumentPage,
} from '@/features/knowledge'

// Storage key for knowledge sidebar collapsed state
const KNOWLEDGE_SIDEBAR_COLLAPSED_KEY = 'knowledge-sidebar-collapsed'

function KnowledgeVirtualPageContent() {
  const params = useParams()
  const router = useRouter()
  const isMobile = useIsMobile()
  const { clearAllStreams } = useChatStreamContext()
  const { setSelectedTask } = useTaskContext()

  // Decode URL params and resolve namespace/kbName
  // URL formats:
  //   /knowledge/default/{kbName}     → personal KB (namespace="default")
  //   /knowledge/public/{kbName}      → organization KB (namespace="public" in URL, resolved below)
  //   /knowledge/{namespace}/{kbName} → team KB
  const rawNamespace = decodeURIComponent(params.namespace as string)
  const kbName = decodeURIComponent(params.kbName as string)
  const docPathSegments = params.docPath as string[] | undefined
  const docPath = docPathSegments ? docPathSegments.map(decodeURIComponent).join('/') : undefined

  // For "public" namespace, pass undefined so KnowledgeDocumentPageDesktop searches by name only
  // For all others, pass the actual namespace
  const namespace = rawNamespace === 'public' ? undefined : rawNamespace

  // Wiki projects hook (needed for AddRepoModal and CancelConfirmDialog)
  const {
    isModalOpen,
    formErrors,
    isSubmitting,
    confirmDialogOpen,
    selectedRepo,
    wikiConfig,
    handleCloseModal,
    handleRepoChange,
    handleSubmit,
    confirmCancelGeneration,
    setConfirmDialogOpen,
    setPendingCancelProjectId,
  } = useWikiProjects()

  // Mobile sidebar state
  const [isMobileSidebarOpen, setIsMobileSidebarOpen] = useState(false)

  // Collapsed sidebar state (task sidebar)
  const [isCollapsed, setIsCollapsed] = useState(false)

  // Knowledge sidebar collapsed state (for document tab)
  const [isKnowledgeSidebarCollapsed, setIsKnowledgeSidebarCollapsed] = useState(() => {
    if (typeof window !== 'undefined') {
      return localStorage.getItem(KNOWLEDGE_SIDEBAR_COLLAPSED_KEY) === 'true'
    }
    return false
  })

  // Listen for knowledge sidebar collapse changes from KnowledgeDocumentPageDesktop
  useEffect(() => {
    const handleCollapseChange = (event: CustomEvent<{ collapsed: boolean }>) => {
      setIsKnowledgeSidebarCollapsed(event.detail.collapsed)
    }

    window.addEventListener(
      'knowledge-sidebar-collapse-change',
      handleCollapseChange as EventListener
    )

    return () => {
      window.removeEventListener(
        'knowledge-sidebar-collapse-change',
        handleCollapseChange as EventListener
      )
    }
  }, [])

  // Handle expanding the knowledge sidebar from TopNavigation
  const handleExpandKnowledgeSidebar = useCallback(() => {
    setIsKnowledgeSidebarCollapsed(false)
    localStorage.setItem(KNOWLEDGE_SIDEBAR_COLLAPSED_KEY, 'false')
    window.dispatchEvent(
      new CustomEvent('knowledge-sidebar-collapse-change', { detail: { collapsed: false } })
    )
  }, [])

  // Load collapsed state from localStorage
  useEffect(() => {
    const savedCollapsed = localStorage.getItem('task-sidebar-collapsed')
    if (savedCollapsed === 'true') {
      setIsCollapsed(true)
    }
  }, [])

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

  // Handle new task from collapsed sidebar button
  const handleNewTask = () => {
    setSelectedTask(null)
    clearAllStreams()
    router.replace(paths.chat.getHref())
  }

  return (
    <div className="flex smart-h-screen bg-base text-text-primary box-border">
      {/* TaskParamSync handles URL taskId parameter synchronization with TaskContext */}
      <Suspense>
        <TaskParamSync />
      </Suspense>

      {/* Collapsed sidebar floating buttons */}
      {isCollapsed && !isMobile && (
        <CollapsedSidebarButtons onExpand={handleToggleCollapsed} onNewTask={handleNewTask} />
      )}

      {/* Responsive resizable sidebar */}
      <ResizableSidebar isCollapsed={isCollapsed} onToggleCollapsed={handleToggleCollapsed}>
        <TaskSidebar
          isMobileSidebarOpen={isMobileSidebarOpen}
          setIsMobileSidebarOpen={setIsMobileSidebarOpen}
          pageType="knowledge"
          isCollapsed={isCollapsed}
          onToggleCollapsed={handleToggleCollapsed}
        />
      </ResizableSidebar>

      {/* Main content area */}
      <div className="flex-1 flex flex-col min-w-0">
        {/* Top navigation with integrated knowledge tabs */}
        <TopNavigation
          activePage="wiki"
          variant="with-sidebar"
          centerContent={
            <KnowledgeTabs
              activeTab="document"
              onTabChange={tab => {
                if (tab === 'code') {
                  router.push('/knowledge?type=code')
                }
              }}
              isKnowledgeSidebarCollapsed={isKnowledgeSidebarCollapsed}
              onExpandClick={handleExpandKnowledgeSidebar}
            />
          }
          onMobileSidebarToggle={() => setIsMobileSidebarOpen(true)}
          isSidebarCollapsed={isCollapsed}
        >
          {isMobile ? <ThemeToggle /> : <GithubStarButton />}
        </TopNavigation>

        {/* Document knowledge - no padding, full height */}
        <div className="flex-1 flex flex-col min-h-0">
          <KnowledgeDocumentPage
            initialKbNamespace={namespace}
            initialKbName={kbName}
            initialDocPath={docPath}
          />
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

export default function KnowledgeVirtualPage() {
  return (
    <Suspense
      fallback={
        <div className="flex smart-h-screen bg-base text-text-primary items-center justify-center">
          <Spinner />
        </div>
      }
    >
      <KnowledgeVirtualPageContent />
    </Suspense>
  )
}
