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

import { Suspense, useState, useEffect } from 'react'
import dynamic from 'next/dynamic'
import { useParams, useRouter } from 'next/navigation'
import { BookOpen, FileText } from 'lucide-react'
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
import { useTaskSession } from '@/features/tasks/session/TaskSession'
import { paths } from '@/config/paths'
import { Spinner } from '@/components/ui/spinner'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { useTranslation } from '@/hooks/useTranslation'
import type { CodeWikiView, KnowledgeView } from '@/types/knowledge'
import type { KnowledgeViewState } from '@/features/knowledge/document/components/KnowledgeDocumentPage'
import { useKnowledgeTaskSidebar } from '@/features/knowledge/document/hooks/useKnowledgeTaskSidebar'

const KnowledgeDocumentPage = dynamic(
  () =>
    import('@/features/knowledge/document/components/KnowledgeDocumentPage').then(mod => ({
      default: mod.KnowledgeDocumentPage,
    })),
  { ssr: false }
)

function KnowledgeVirtualPageContent() {
  const params = useParams()
  const router = useRouter()
  const isMobile = useIsMobile()
  const { selectTask } = useTaskSession()
  const { t } = useTranslation('knowledge')

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

  // Mobile sidebar state
  const [isMobileSidebarOpen, setIsMobileSidebarOpen] = useState(false)
  const [knowledgeViewState, setKnowledgeViewState] = useState<KnowledgeViewState>({
    visible: false,
    currentView: 'notebook',
  })

  useEffect(() => {
    saveLastTab('wiki')
  }, [])

  const isWorkspaceView =
    knowledgeViewState.visible && knowledgeViewState.currentView === 'notebook'
  const { isCollapsed: isTaskSidebarCollapsed, toggle: handleToggleCollapsed } =
    useKnowledgeTaskSidebar({
      isMobile,
      isWorkspaceView,
    })

  // Handle new task from collapsed sidebar button
  const handleNewTask = () => {
    selectTask(null)
    router.replace(paths.chat.getHref())
  }

  const knowledgeViewSwitcher = knowledgeViewState.visible ? (
    <Tabs
      value={knowledgeViewState.currentView}
      onValueChange={value =>
        knowledgeViewState.onViewChange?.(value as KnowledgeView | CodeWikiView)
      }
      className="flex-shrink-0"
    >
      <TabsList className="h-11 sm:h-8 rounded-md bg-surface/80 p-0 sm:p-0.5">
        {knowledgeViewState.switcher === 'code-wiki' ? (
          <>
            <TabsTrigger
              value="wiki"
              aria-label={t('codeWiki.workspace.wiki')}
              data-testid="code-wiki-view-wiki"
              className="gap-1 h-11 min-w-[44px] px-3 text-xs sm:h-7 sm:min-w-0 sm:px-2"
            >
              <BookOpen className="w-3.5 h-3.5" />
              <span className="hidden sm:inline">{t('codeWiki.workspace.wiki')}</span>
            </TabsTrigger>
            <TabsTrigger
              value="documents"
              aria-label={t('codeWiki.workspace.documents')}
              data-testid="code-wiki-view-documents"
              className="gap-1 h-11 min-w-[44px] px-3 text-xs sm:h-7 sm:min-w-0 sm:px-2"
            >
              <FileText className="w-3.5 h-3.5" />
              <span className="hidden sm:inline">{t('codeWiki.workspace.documents')}</span>
            </TabsTrigger>
          </>
        ) : (
          <>
            <TabsTrigger
              value="documents"
              aria-label={t('document.knowledgeBase.typeClassic')}
              data-testid="knowledge-view-documents-trigger"
              className="gap-1 h-11 min-w-[44px] px-3 text-xs sm:h-7 sm:min-w-0 sm:px-2"
            >
              <FileText className="w-3.5 h-3.5" />
              <span className="hidden sm:inline">{t('document.knowledgeBase.typeClassic')}</span>
            </TabsTrigger>
            <TabsTrigger
              value="notebook"
              aria-label={t('document.knowledgeBase.typeNotebook')}
              data-testid="knowledge-view-notebook-trigger"
              className="gap-1 h-11 min-w-[44px] px-3 text-xs sm:h-7 sm:min-w-0 sm:px-2"
            >
              <BookOpen className="w-3.5 h-3.5" />
              <span className="hidden sm:inline">{t('document.knowledgeBase.typeNotebook')}</span>
            </TabsTrigger>
          </>
        )}
      </TabsList>
    </Tabs>
  ) : null

  return (
    <div className="flex smart-h-screen bg-base text-text-primary box-border">
      {/* TaskParamSync handles URL taskId parameter synchronization with TaskSessionContext */}
      <Suspense>
        <TaskParamSync />
      </Suspense>

      {/* Collapsed sidebar floating buttons */}
      {isTaskSidebarCollapsed && !isMobile && (
        <CollapsedSidebarButtons onExpand={handleToggleCollapsed} onNewTask={handleNewTask} />
      )}

      {/* Responsive resizable sidebar */}
      <ResizableSidebar
        isCollapsed={isTaskSidebarCollapsed}
        onToggleCollapsed={handleToggleCollapsed}
      >
        <TaskSidebar
          isMobileSidebarOpen={isMobileSidebarOpen}
          setIsMobileSidebarOpen={setIsMobileSidebarOpen}
          pageType="knowledge"
          isCollapsed={isTaskSidebarCollapsed}
          onToggleCollapsed={handleToggleCollapsed}
        />
      </ResizableSidebar>

      {/* Main content area */}
      <div className="flex-1 flex flex-col min-w-0">
        {/* Top navigation with integrated knowledge tabs */}
        <TopNavigation
          activePage="wiki"
          variant="with-sidebar"
          onMobileSidebarToggle={() => setIsMobileSidebarOpen(true)}
          isSidebarCollapsed={isTaskSidebarCollapsed}
        >
          {knowledgeViewSwitcher}
          {isMobile ? <ThemeToggle /> : <GithubStarButton />}
        </TopNavigation>

        {/* Document knowledge - no padding, full height */}
        <div className="flex-1 flex flex-col min-h-0">
          <KnowledgeDocumentPage
            initialKbNamespace={namespace}
            initialKbName={kbName}
            initialDocPath={docPath}
            onKnowledgeViewStateChange={setKnowledgeViewState}
          />
        </div>
      </div>
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
