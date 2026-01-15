// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { Suspense } from 'react'
import dynamic from 'next/dynamic'
import { useIsMobile } from '@/features/layout/hooks/useMediaQuery'
import '@/app/tasks/tasks.css'
import '@/features/common/scrollbar.css'

// Dynamic imports for mobile and desktop page components with code splitting
const SettingsPageDesktop = dynamic(
  () => import('./SettingsPageDesktop').then(mod => ({ default: mod.SettingsPageDesktop })),
  {
    ssr: false,
  }
)

const SettingsPageMobile = dynamic(
  () => import('./SettingsPageMobile').then(mod => ({ default: mod.SettingsPageMobile })),
  {
    ssr: false,
  }
)

function SettingsContent() {
  // Mobile detection
  const isMobile = useIsMobile()

  // Route to mobile or desktop component based on screen size
  return isMobile ? <SettingsPageMobile /> : <SettingsPageDesktop />
}

/**
 * Settings Page Router Component
 *
 * Routes between mobile and desktop implementations based on screen size:
 * - Mobile: ≤767px - Touch-optimized UI with drawer sidebar
 * - Desktop: ≥768px - Full-featured UI with resizable sidebar
 *
 * Uses dynamic imports to optimize bundle size and loading performance.
 */
export default function SettingsPage() {
  return (
    <Suspense fallback={<div>Loading...</div>}>
      <SettingsContent />
    </Suspense>
  )
}
