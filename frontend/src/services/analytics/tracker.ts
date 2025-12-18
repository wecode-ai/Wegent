// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * Core analytics tracker service that manages all tracking functionality.
 */
import type { AnalyticsEvent, ClickEventData, ErrorEventData } from './types'
import { ClickTracker } from './events/click-tracker'
import { PageTracker } from './events/page-tracker'
import { ErrorTracker } from './events/error-tracker'

// API endpoint for reporting events
const ANALYTICS_API_ENDPOINT = '/api/analytics/events'

/**
 * Send analytics event to backend API
 */
async function reportEvent(event: AnalyticsEvent): Promise<void> {
  try {
    // Use sendBeacon for better reliability during page unload
    if (typeof navigator !== 'undefined' && navigator.sendBeacon) {
      const blob = new Blob([JSON.stringify(event)], { type: 'application/json' })
      const sent = navigator.sendBeacon(ANALYTICS_API_ENDPOINT, blob)
      if (sent) return
    }

    // Fallback to fetch
    await fetch(ANALYTICS_API_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(event),
      keepalive: true, // Ensures request completes even during page unload
    })
  } catch (error) {
    // Silent failure - analytics should not affect user experience
    if (process.env.NODE_ENV === 'development') {
      console.debug('Analytics report failed:', error)
    }
  }
}

/**
 * Get current user ID from context or storage
 */
function getCurrentUserId(): number | null {
  if (typeof window === 'undefined') return null

  // Try to get user ID from local storage (set by UserContext)
  try {
    const userStr = localStorage.getItem('user')
    if (userStr) {
      const user = JSON.parse(userStr)
      return user?.id ?? null
    }
  } catch {
    // Ignore parse errors
  }

  return null
}

/**
 * Create base event data with common fields
 */
function createBaseEvent(eventType: 'click' | 'page_view' | 'error') {
  return {
    event_type: eventType,
    user_id: getCurrentUserId(),
    page_url: typeof window !== 'undefined' ? window.location.href : '',
    timestamp: new Date().toISOString(),
  }
}

/**
 * Main analytics tracker class
 */
class AnalyticsTracker {
  private initialized = false
  private clickTracker: ClickTracker | null = null
  private pageTracker: PageTracker | null = null
  private errorTracker: ErrorTracker | null = null

  /**
   * Initialize all trackers
   */
  init(): void {
    if (this.initialized || typeof window === 'undefined') {
      return
    }

    this.clickTracker = new ClickTracker(this.trackClick.bind(this))
    this.pageTracker = new PageTracker(this.trackPageView.bind(this))
    this.errorTracker = new ErrorTracker(this.trackError.bind(this))

    this.clickTracker.init()
    this.pageTracker.init()
    this.errorTracker.init()

    this.initialized = true

    if (process.env.NODE_ENV === 'development') {
      console.debug('Analytics tracker initialized')
    }
  }

  /**
   * Cleanup and destroy all trackers
   */
  destroy(): void {
    if (!this.initialized) {
      return
    }

    this.clickTracker?.destroy()
    this.pageTracker?.destroy()
    this.errorTracker?.destroy()

    this.clickTracker = null
    this.pageTracker = null
    this.errorTracker = null

    this.initialized = false

    if (process.env.NODE_ENV === 'development') {
      console.debug('Analytics tracker destroyed')
    }
  }

  /**
   * Track a click event
   */
  trackClick(data: ClickEventData): void {
    const event = {
      ...createBaseEvent('click'),
      event_type: 'click' as const,
      element_tag: data.element_tag,
      element_id: data.element_id ?? null,
      element_class: data.element_class ?? null,
      element_text: data.element_text ?? null,
      element_href: data.element_href ?? null,
      data_track_id: data.data_track_id ?? null,
    }

    reportEvent(event)
  }

  /**
   * Track a page view event
   */
  trackPageView(pathname: string): void {
    const event = {
      ...createBaseEvent('page_view'),
      event_type: 'page_view' as const,
      page_title: typeof document !== 'undefined' ? document.title : '',
      referrer: typeof document !== 'undefined' ? document.referrer || null : null,
    }

    // Override page_url with the specific pathname
    event.page_url = typeof window !== 'undefined' ? window.location.origin + pathname : pathname

    reportEvent(event)
  }

  /**
   * Track an error event
   */
  trackError(data: ErrorEventData): void {
    const event = {
      ...createBaseEvent('error'),
      event_type: 'error' as const,
      error_type: data.error_type,
      error_message: data.error_message,
      error_stack: data.error_stack ?? null,
      error_source: data.error_source ?? null,
      error_line: data.error_line ?? null,
      error_column: data.error_column ?? null,
    }

    reportEvent(event)
  }

  /**
   * Manually report a page view (for use with Next.js router)
   */
  reportPageView(pathname: string): void {
    this.trackPageView(pathname)
  }

  /**
   * Check if tracker is initialized
   */
  isInitialized(): boolean {
    return this.initialized
  }
}

// Export singleton instance
export const analyticsTracker = new AnalyticsTracker()
