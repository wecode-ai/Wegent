// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { Suspense } from 'react'
import dynamic from 'next/dynamic'
import { useIsMobile } from '@/features/layout/hooks/useMediaQuery'
import OidcTokenHandler from '@/features/login/components/OidcTokenHandler'
import '@/app/tasks/tasks.css'
import '@/features/common/scrollbar.css'

// Dynamic imports for mobile and desktop page components with code splitting
const DevicePageDesktop = dynamic(() => import('./DevicePageDesktop'), {
  ssr: false,
})

const DevicePageMobile = dynamic(() => import('./DevicePageMobile'), {
  ssr: false,
})

/**
 * Device Page Router Component
 *
 * Routes between mobile and desktop implementations based on screen size.
 * Allows users to manage and chat with their local wecode-cli instances.
 */
export default function DevicePage() {
  const isMobile = useIsMobile()

  return (
    <>
      {/* Handle OIDC token from URL parameters */}
      <OidcTokenHandler />
      {/* Route to mobile or desktop component based on screen size */}
      <Suspense
        fallback={<div className="flex-1 flex items-center justify-center">Loading...</div>}
      >
        {isMobile ? <DevicePageMobile /> : <DevicePageDesktop />}
      </Suspense>
    </>
  )
}
