// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * Page view tracker for tracking navigation events.
 * Works with Next.js App Router by tracking pathname changes.
 */

export class PageTracker {
  private trackPageView: (pathname: string) => void
  private lastPathname: string | null = null

  constructor(trackPageView: (pathname: string) => void) {
    this.trackPageView = trackPageView
  }

  /**
   * Initialize page tracking
   */
  init(): void {
    if (typeof window === 'undefined') {
      return
    }

    // Track initial page view
    const pathname = window.location.pathname + window.location.search
    this.trackPageView(pathname)
    this.lastPathname = pathname
  }

  /**
   * Report a page view for a new pathname
   * This should be called from the Next.js layout when pathname changes
   */
  reportPageView(pathname: string): void {
    // Avoid duplicate tracking for the same pathname
    if (pathname === this.lastPathname) {
      return
    }

    this.trackPageView(pathname)
    this.lastPathname = pathname
  }

  /**
   * Cleanup page tracking
   */
  destroy(): void {
    this.lastPathname = null
  }
}
