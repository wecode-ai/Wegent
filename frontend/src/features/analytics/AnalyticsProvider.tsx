// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

/**
 * Analytics provider component that initializes and manages the analytics tracker.
 * This component should be placed in the app layout to enable tracking.
 */
import { useEffect, useRef } from 'react'
import { usePathname } from 'next/navigation'
import { analyticsTracker } from '@/services/analytics'

interface AnalyticsProviderProps {
  children: React.ReactNode
}

/**
 * Provider component that initializes analytics tracking and tracks page views.
 *
 * Usage:
 * ```tsx
 * <AnalyticsProvider>
 *   <YourApp />
 * </AnalyticsProvider>
 * ```
 */
export function AnalyticsProvider({ children }: AnalyticsProviderProps) {
  const pathname = usePathname()
  const isFirstRender = useRef(true)

  // Initialize analytics tracker on mount
  useEffect(() => {
    analyticsTracker.init()

    return () => {
      analyticsTracker.destroy()
    }
  }, [])

  // Track page views on pathname change
  useEffect(() => {
    // Skip the first render since init() already tracks the initial page view
    if (isFirstRender.current) {
      isFirstRender.current = false
      return
    }

    // Track page view when pathname changes
    analyticsTracker.reportPageView(pathname)
  }, [pathname])

  return <>{children}</>
}
