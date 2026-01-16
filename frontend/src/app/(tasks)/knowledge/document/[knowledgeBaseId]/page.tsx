// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { Suspense } from 'react'
import dynamic from 'next/dynamic'
import { useParams } from 'next/navigation'
import '@/app/tasks/tasks.css'
import '@/features/common/scrollbar.css'
import { useIsMobile } from '@/features/layout/hooks/useMediaQuery'
import { TaskParamSync } from '@/features/tasks/components/params'
import { Spinner } from '@/components/ui/spinner'
import { useKnowledgeBaseDetail } from '@/features/knowledge/document/hooks'

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

  // Parse knowledge base ID from URL
  const knowledgeBaseId = params.knowledgeBaseId
    ? parseInt(params.knowledgeBaseId as string, 10)
    : null

  // Fetch knowledge base details to determine type
  const { knowledgeBase, loading } = useKnowledgeBaseDetail({
    knowledgeBaseId: knowledgeBaseId || 0,
    autoLoad: !!knowledgeBaseId,
  })

  // Show loading while fetching knowledge base info
  if (loading || !knowledgeBase) {
    return <PageLoadingFallback />
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
        {isMobile ? <KnowledgeBaseClassicPageMobile /> : <KnowledgeBaseClassicPageDesktop />}
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
      {isMobile ? <KnowledgeBaseChatPageMobile /> : <KnowledgeBaseChatPageDesktop />}
    </>
  )
}
