// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * API client for analytics events.
 * This module provides a standalone API for manual event reporting.
 */
import type { AnalyticsEvent, AnalyticsEventResponse } from '@/services/analytics/types'

const ANALYTICS_API_ENDPOINT = '/api/analytics/events'

/**
 * Report an analytics event to the backend.
 * This function fails silently to avoid affecting user experience.
 *
 * @param event - The analytics event to report
 * @returns Promise that resolves when the event is reported (or fails silently)
 */
export async function reportAnalyticsEvent(event: AnalyticsEvent): Promise<AnalyticsEventResponse | null> {
  try {
    const response = await fetch(ANALYTICS_API_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(event),
      keepalive: true,
    })

    if (!response.ok) {
      if (process.env.NODE_ENV === 'development') {
        console.debug('Analytics report failed:', response.status)
      }
      return null
    }

    return await response.json()
  } catch (error) {
    // Silent failure - analytics should not affect user experience
    if (process.env.NODE_ENV === 'development') {
      console.debug('Analytics report failed:', error)
    }
    return null
  }
}

/**
 * Report an analytics event using sendBeacon (for page unload scenarios).
 * This is more reliable than fetch when the page is being unloaded.
 *
 * @param event - The analytics event to report
 * @returns boolean indicating if the event was queued
 */
export function reportAnalyticsEventBeacon(event: AnalyticsEvent): boolean {
  if (typeof navigator === 'undefined' || !navigator.sendBeacon) {
    return false
  }

  try {
    const blob = new Blob([JSON.stringify(event)], { type: 'application/json' })
    return navigator.sendBeacon(ANALYTICS_API_ENDPOINT, blob)
  } catch {
    return false
  }
}
