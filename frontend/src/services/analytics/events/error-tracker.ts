// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * Error tracker for capturing JavaScript errors, unhandled promise rejections,
 * and resource loading failures.
 */
import type { ErrorEventData, ErrorType } from '../types'

export class ErrorTracker {
  private trackError: (data: ErrorEventData) => void
  private handleError: ((event: ErrorEvent) => void) | null = null
  private handleRejection: ((event: PromiseRejectionEvent) => void) | null = null
  private handleResourceError: ((event: Event) => void) | null = null

  constructor(trackError: (data: ErrorEventData) => void) {
    this.trackError = trackError
  }

  /**
   * Initialize error tracking
   */
  init(): void {
    if (typeof window === 'undefined') {
      return
    }

    // Track JavaScript runtime errors
    this.handleError = (event: ErrorEvent) => {
      this.reportError({
        error_type: 'js_error',
        error_message: event.message || 'Unknown error',
        error_stack: event.error?.stack ? this.truncateStack(event.error.stack) : null,
        error_source: event.filename || null,
        error_line: event.lineno || null,
        error_column: event.colno || null,
      })
    }

    // Track unhandled promise rejections
    this.handleRejection = (event: PromiseRejectionEvent) => {
      const reason = event.reason
      let message = 'Unhandled promise rejection'
      let stack: string | null = null

      if (reason instanceof Error) {
        message = reason.message || message
        stack = reason.stack ? this.truncateStack(reason.stack) : null
      } else if (typeof reason === 'string') {
        message = reason
      } else if (reason && typeof reason === 'object') {
        try {
          message = JSON.stringify(reason)
        } catch {
          message = String(reason)
        }
      }

      this.reportError({
        error_type: 'unhandled_rejection',
        error_message: message,
        error_stack: stack,
        error_source: null,
        error_line: null,
        error_column: null,
      })
    }

    // Track resource loading errors (images, scripts, stylesheets)
    this.handleResourceError = (event: Event) => {
      const target = event.target as HTMLElement | null
      if (!target) return

      // Only track resource elements
      if (!['IMG', 'SCRIPT', 'LINK'].includes(target.tagName)) {
        return
      }

      const src =
        (target as HTMLImageElement).src ||
        (target as HTMLScriptElement).src ||
        (target as HTMLLinkElement).href ||
        'unknown'

      this.reportError({
        error_type: 'resource_error',
        error_message: `Failed to load resource: ${target.tagName.toLowerCase()}`,
        error_stack: null,
        error_source: src,
        error_line: null,
        error_column: null,
      })
    }

    window.addEventListener('error', this.handleError)
    window.addEventListener('unhandledrejection', this.handleRejection)
    // Use capture phase for resource errors since they don't bubble
    window.addEventListener('error', this.handleResourceError, { capture: true })
  }

  /**
   * Cleanup error tracking
   */
  destroy(): void {
    if (typeof window === 'undefined') {
      return
    }

    if (this.handleError) {
      window.removeEventListener('error', this.handleError)
      this.handleError = null
    }

    if (this.handleRejection) {
      window.removeEventListener('unhandledrejection', this.handleRejection)
      this.handleRejection = null
    }

    if (this.handleResourceError) {
      window.removeEventListener('error', this.handleResourceError, { capture: true })
      this.handleResourceError = null
    }
  }

  /**
   * Report an error event
   */
  private reportError(data: ErrorEventData): void {
    this.trackError(data)
  }

  /**
   * Truncate stack trace to maximum length
   */
  private truncateStack(stack: string): string {
    const maxLength = 2000
    return stack.length > maxLength ? stack.substring(0, maxLength) : stack
  }

  /**
   * Manually track an API error
   */
  trackApiError(error: Error | string, source?: string): void {
    const message = error instanceof Error ? error.message : error
    const stack = error instanceof Error ? this.truncateStack(error.stack || '') : null

    this.reportError({
      error_type: 'api_error',
      error_message: message,
      error_stack: stack,
      error_source: source || null,
      error_line: null,
      error_column: null,
    })
  }
}
