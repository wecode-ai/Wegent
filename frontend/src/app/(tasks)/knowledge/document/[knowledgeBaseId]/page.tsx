// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import dynamic from 'next/dynamic'
import '@/app/tasks/tasks.css'
import '@/features/common/scrollbar.css'
import { useIsMobile } from '@/features/layout/hooks/useMediaQuery'
import { Spinner } from '@/components/ui/spinner'

// Loading fallback component for dynamic imports
function PageLoadingFallback() {
  return (
    <div className="flex h-screen items-center justify-center bg-base">
      <Spinner />
    </div>
  )
}

// Dynamic imports for mobile and desktop page components with code splitting
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

/**
 * Knowledge Base Chat Page Router Component
 *
 * Routes between mobile and desktop implementations based on screen size:
 * - Mobile: ≤767px - Touch-optimized UI with drawer sidebar
 * - Desktop: ≥768px - Full-featured UI with resizable sidebar and document panel
 *
 * Uses dynamic imports to optimize bundle size and loading performance.
 */
export default function KnowledgeBaseChatPage() {
  // Mobile detection
  const isMobile = useIsMobile()

  // Route to mobile or desktop component based on screen size
  return isMobile ? <KnowledgeBaseChatPageMobile /> : <KnowledgeBaseChatPageDesktop />
}
