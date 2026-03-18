// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { Suspense } from 'react'
import dynamic from 'next/dynamic'
import { useParams, useRouter } from 'next/navigation'
import '@/app/tasks/tasks.css'
import '@/features/common/scrollbar.css'
import { useIsMobile } from '@/features/layout/hooks/useMediaQuery'
import { TaskParamSync } from '@/features/tasks/components/params'
import { Spinner } from '@/components/ui/spinner'
import { Button } from '@/components/ui/button'
import { useKnowledgeBaseDetail } from '@/features/knowledge/document/hooks'
import { useTranslation } from '@/hooks/useTranslation'
import { ArrowLeft, Lock } from 'lucide-react'

// Loading fallback component for dynamic imports
function PageLoadingFallback() {
  return (
    <div className="flex h-screen items-center justify-center bg-base">
      <Spinner />
    </div>
  )
}

// Dynamic imports for notebook type (three-column layout with chat)
const KnowledgeBaseChatPageDesktop = dynamic(
  () =>
    import('./KnowledgeBaseChatPageDesktop').then(mod => ({
      default: mod.KnowledgeBaseChatPageDesktop,
    })),
  {
    ssr: false,
    loading: PageLoadingFallback,
  }
)

const KnowledgeBaseChatPageMobile = dynamic(
  () =>
    import('./KnowledgeBaseChatPageMobile').then(mod => ({
      default: mod.KnowledgeBaseChatPageMobile,
    })),
  {
    ssr: false,
    loading: PageLoadingFallback,
  }
)

// Dynamic imports for classic type (document list only)
const KnowledgeBaseClassicPageDesktop = dynamic(
  () =>
    import('./KnowledgeBaseClassicPageDesktop').then(mod => ({
      default: mod.KnowledgeBaseClassicPageDesktop,
    })),
  {
    ssr: false,
    loading: PageLoadingFallback,
  }
)

const KnowledgeBaseClassicPageMobile = dynamic(
  () =>
    import('./KnowledgeBaseClassicPageMobile').then(mod => ({
      default: mod.KnowledgeBaseClassicPageMobile,
    })),
  {
    ssr: false,
    loading: PageLoadingFallback,
  }
)

/**
 * Knowledge Base Page Router Component
 *
 * Routes between different layouts based on:
 * 1. Knowledge base type (kb_type):
 *    - 'notebook': Three-column layout with chat area and document panel
 *    - 'classic': Document list only without chat functionality
 * 2. Screen size:
 *    - Mobile: ≤767px - Touch-optimized UI with drawer sidebar
 *    - Desktop: ≥768px - Full-featured UI with resizable sidebar
 *
 * Uses dynamic imports to optimize bundle size and loading performance.
 */
export default function KnowledgeBaseChatPage() {
  // Mobile detection
  const isMobile = useIsMobile()
  const params = useParams()
  const router = useRouter()
  const { t } = useTranslation('knowledge')

  // Parse knowledge base ID from URL
  const knowledgeBaseId = params.knowledgeBaseId
    ? parseInt(params.knowledgeBaseId as string, 10)
    : null

  // Fetch knowledge base details to determine type
  // This hook is the single source of truth for kb_type routing
  const {
    knowledgeBase,
    loading,
    error,
    accessDenied,
    refresh: refreshKnowledgeBase,
  } = useKnowledgeBaseDetail({
    knowledgeBaseId: knowledgeBaseId || 0,
    autoLoad: !!knowledgeBaseId,
  })

  // Handle back navigation with fallback to knowledge list
  const handleBack = () => {
    // Check if there's history to go back to
    if (typeof window !== 'undefined' && window.history.length > 1) {
      router.back()
    } else {
      // Fallback to knowledge list when no history available
      router.push('/knowledge?type=document')
    }
  }

  // Handle navigate to knowledge base list
  const handleGoToList = () => {
    router.push('/knowledge?type=document')
  }

  // Show loading while fetching knowledge base info
  if (loading) {
    return <PageLoadingFallback />
  }

  // Show access denied state for 403 errors
  if (accessDenied) {
    return (
      <div className="flex h-screen items-center justify-center bg-base">
        <div className="text-center max-w-md px-6">
          <div className="w-16 h-16 bg-surface rounded-full flex items-center justify-center mx-auto mb-6">
            <Lock className="w-8 h-8 text-text-muted" />
          </div>
          <h1 className="text-xl font-semibold text-text-primary mb-3">
            {t('chatPage.accessDenied.title')}
          </h1>
          <p className="text-text-muted mb-8 leading-relaxed">
            {t('chatPage.accessDenied.description')}
          </p>
          <Button variant="primary" onClick={handleGoToList}>
            {t('chatPage.accessDenied.backButton')}
          </Button>
        </div>
      </div>
    )
  }

  // Show error state if fetch failed (non-403 errors)
  if (error || !knowledgeBase) {
    return (
      <div className="flex h-screen items-center justify-center bg-base">
        <div className="text-center">
          <p className="text-text-muted mb-4">{error || t('chatPage.notFound')}</p>
          <Button variant="outline" onClick={handleBack}>
            <ArrowLeft className="w-4 h-4 mr-2" />
            {t('chatPage.backToList')}
          </Button>
        </div>
      </div>
    )
  }

  // Determine the layout type (default to 'notebook' if not specified)
  const kbType = knowledgeBase.kb_type || 'notebook'

  // Route to appropriate component based on type and screen size
  if (kbType === 'classic') {
    return (
      <>
        {/* TaskParamSync handles URL taskId parameter synchronization with TaskContext */}
        <Suspense>
          <TaskParamSync />
        </Suspense>
        {isMobile ? (
          <KnowledgeBaseClassicPageMobile onKbTypeChanged={refreshKnowledgeBase} />
        ) : (
          <KnowledgeBaseClassicPageDesktop onKbTypeChanged={refreshKnowledgeBase} />
        )}
      </>
    )
  }

  // Default: notebook type (three-column layout with chat)
  return (
    <>
      {/* TaskParamSync handles URL taskId parameter synchronization with TaskContext */}
      <Suspense>
        <TaskParamSync />
      </Suspense>
      {isMobile ? (
        <KnowledgeBaseChatPageMobile onKbTypeChanged={refreshKnowledgeBase} />
      ) : (
        <KnowledgeBaseChatPageDesktop onKbTypeChanged={refreshKnowledgeBase} />
      )}
    </>
  )
}
