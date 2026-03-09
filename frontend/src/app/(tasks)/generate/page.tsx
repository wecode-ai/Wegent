// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { Suspense } from 'react'
import dynamic from 'next/dynamic'
import { TaskParamSync } from '@/features/tasks/components/params'
import '@/app/tasks/tasks.css'
import '@/features/common/scrollbar.css'
import { useIsMobile } from '@/features/layout/hooks/useMediaQuery'

// Dynamic imports for mobile and desktop page components with code splitting
const GeneratePageDesktop = dynamic(
  () => import('./GeneratePageDesktop').then(mod => ({ default: mod.GeneratePageDesktop })),
  {
    ssr: false,
  }
)

const GeneratePageMobile = dynamic(
  () => import('./GeneratePageMobile').then(mod => ({ default: mod.GeneratePageMobile })),
  {
    ssr: false,
  }
)

/**
 * Generate Page Router Component
 *
 * Routes between mobile and desktop implementations based on screen size:
 * - Mobile: ≤767px - Touch-optimized UI with drawer sidebar
 * - Desktop: ≥768px - Full-featured UI with resizable sidebar
 *
 * Uses dynamic imports to optimize bundle size and loading performance.
 *
 * This page supports video and image generation modes.
 * Teams are filtered to show only those that support video mode
 * (bind_mode includes 'video' or is empty/undefined).
 */
export default function GeneratePage() {
  // Mobile detection
  const isMobile = useIsMobile()

  return (
    <>
      {/* TaskParamSync handles URL taskId parameter synchronization with TaskContext */}
      <Suspense>
        <TaskParamSync />
      </Suspense>
      {/* Route to mobile or desktop component based on screen size */}
      {isMobile ? <GeneratePageMobile /> : <GeneratePageDesktop />}
    </>
  )
}
