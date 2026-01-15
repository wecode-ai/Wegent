// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import dynamic from 'next/dynamic'
import { useIsMobile } from '@/features/layout/hooks/useMediaQuery'
import '@/app/tasks/tasks.css'
import '@/features/common/scrollbar.css'

// Dynamic imports for mobile and desktop page components with code splitting
const KnowledgePageDesktop = dynamic(
  () => import('./KnowledgePageDesktop').then(mod => ({ default: mod.KnowledgePageDesktop })),
  {
    ssr: false,
  }
)

const KnowledgePageMobile = dynamic(
  () => import('./KnowledgePageMobile').then(mod => ({ default: mod.KnowledgePageMobile })),
  {
    ssr: false,
  }
)

/**
 * Knowledge Page Router Component
 *
 * Routes between mobile and desktop implementations based on screen size:
 * - Mobile: ≤767px - Touch-optimized UI with drawer sidebar
 * - Desktop: ≥768px - Full-featured UI with resizable sidebar
 *
 * Uses dynamic imports to optimize bundle size and loading performance.
 */
export default function KnowledgePage() {
  // Mobile detection
  const isMobile = useIsMobile()

  // Route to mobile or desktop component based on screen size
  return isMobile ? <KnowledgePageMobile /> : <KnowledgePageDesktop />
}
