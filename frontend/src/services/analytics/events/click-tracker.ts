// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * Click event tracker that captures user interactions with UI elements.
 */
import type { ClickEventData } from '../types'
import { findTrackableElement, extractElementInfo } from '../utils/element-info'

export class ClickTracker {
  private trackClick: (data: ClickEventData) => void
  private handleClick: ((event: MouseEvent) => void) | null = null

  constructor(trackClick: (data: ClickEventData) => void) {
    this.trackClick = trackClick
  }

  /**
   * Initialize click tracking by attaching event listener
   */
  init(): void {
    if (typeof document === 'undefined') {
      return
    }

    this.handleClick = (event: MouseEvent) => {
      const target = event.target as Element | null
      if (!target) return

      // Find the nearest trackable element
      const trackableElement = findTrackableElement(target)
      if (!trackableElement) return

      // Extract element information
      const elementInfo = extractElementInfo(trackableElement)

      // Report the click event
      this.trackClick(elementInfo)
    }

    // Use capture phase to ensure we catch all clicks
    document.addEventListener('click', this.handleClick, { capture: true })
  }

  /**
   * Cleanup click tracking
   */
  destroy(): void {
    if (this.handleClick && typeof document !== 'undefined') {
      document.removeEventListener('click', this.handleClick, { capture: true })
      this.handleClick = null
    }
  }
}
