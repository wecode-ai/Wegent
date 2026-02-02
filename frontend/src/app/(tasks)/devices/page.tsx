// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import dynamic from 'next/dynamic'
import '@/app/tasks/tasks.css'
import '@/features/common/scrollbar.css'
import { useIsMobile } from '@/features/layout/hooks/useMediaQuery'

// Dynamic imports for mobile and desktop page components with code splitting
const DevicesPageDesktop = dynamic(
  () => import('./DevicesPageDesktop').then(mod => ({ default: mod.DevicesPageDesktop })),
  {
    ssr: false,
  }
)

const DevicesPageMobile = dynamic(
  () => import('./DevicesPageMobile').then(mod => ({ default: mod.DevicesPageMobile })),
  {
    ssr: false,
  }
)

/**
 * Devices Page Router Component
 *
 * Routes between mobile and desktop implementations based on screen size:
 * - Mobile: ≤767px - Touch-optimized UI with simplified device cards
 * - Desktop: ≥768px - Full-featured UI with detailed device information
 *
 * Uses dynamic imports to optimize bundle size and loading performance.
 */
export default function DevicesPage() {
  // Mobile detection
  const isMobile = useIsMobile()

  // Route to mobile or desktop component based on screen size
  return isMobile ? <DevicesPageMobile /> : <DevicesPageDesktop />
}
