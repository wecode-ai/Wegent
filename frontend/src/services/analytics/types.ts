// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * TypeScript type definitions for analytics tracking events.
 */

export type EventType = 'click' | 'page_view' | 'error'

export type ErrorType = 'js_error' | 'unhandled_rejection' | 'api_error' | 'resource_error'

/**
 * Base interface for all analytics events
 */
export interface BaseEvent {
  event_type: EventType
  user_id: number | null
  page_url: string
  timestamp: string // ISO 8601 format
}

/**
 * Click event for tracking user interactions with UI elements
 */
export interface ClickEvent extends BaseEvent {
  event_type: 'click'
  element_tag: string
  element_id: string | null
  element_class: string | null
  element_text: string | null
  element_href: string | null
  data_track_id: string | null
}

/**
 * Page view event for tracking navigation
 */
export interface PageViewEvent extends BaseEvent {
  event_type: 'page_view'
  page_title: string
  referrer: string | null
}

/**
 * Error event for tracking frontend errors
 */
export interface ErrorEvent extends BaseEvent {
  event_type: 'error'
  error_type: ErrorType
  error_message: string
  error_stack: string | null
  error_source: string | null
  error_line: number | null
  error_column: number | null
}

/**
 * Union type of all analytics events
 */
export type AnalyticsEvent = ClickEvent | PageViewEvent | ErrorEvent

/**
 * Response from the analytics API
 */
export interface AnalyticsEventResponse {
  id: number
  event_type: string
  created_at: string
}

/**
 * Click event data without base fields (for manual tracking)
 */
export interface ClickEventData {
  element_tag: string
  element_id?: string | null
  element_class?: string | null
  element_text?: string | null
  element_href?: string | null
  data_track_id?: string | null
}

/**
 * Error event data without base fields (for manual tracking)
 */
export interface ErrorEventData {
  error_type: ErrorType
  error_message: string
  error_stack?: string | null
  error_source?: string | null
  error_line?: number | null
  error_column?: number | null
}
