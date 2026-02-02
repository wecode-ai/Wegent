// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { Suspense } from 'react'
import dynamic from 'next/dynamic'
import { TaskParamSync, DeviceTaskSync } from '@/features/tasks/components/params'
import '@/app/tasks/tasks.css'
import '@/features/common/scrollbar.css'
import { useIsMobile } from '@/features/layout/hooks/useMediaQuery'

// Dynamic imports for mobile and desktop page components with code splitting
const DeviceChatPageDesktop = dynamic(
  () =>
    import('./DeviceChatPageDesktop').then(mod => ({ default: mod.DeviceChatPageDesktop })),
  {
    ssr: false,
  }
)

const DeviceChatPageMobile = dynamic(
  () => import('./DeviceChatPageMobile').then(mod => ({ default: mod.DeviceChatPageMobile })),
  {
    ssr: false,
  }
)

/**
 * Device Chat Page Router Component
 *
 * Routes between mobile and desktop implementations based on screen size:
 * - Mobile: ≤767px - Touch-optimized UI with drawer sidebar and beta badge
 * - Desktop: ≥768px - Full-featured UI with resizable sidebar
 *
 * Uses dynamic imports to optimize bundle size and loading performance.
 */
export default function DeviceChatPage() {
  // Mobile detection
  const isMobile = useIsMobile()

  return (
    <>
      {/* URL parameter sync for task selection */}
      <Suspense>
        <TaskParamSync />
        <DeviceTaskSync />
      </Suspense>
      {/* Route to mobile or desktop component based on screen size */}
      {isMobile ? <DeviceChatPageMobile /> : <DeviceChatPageDesktop />}
    </>
  )
}
