// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * Utility functions for extracting element information for click tracking.
 */

// Interactive element selectors that should be tracked
const TRACKABLE_SELECTORS = [
  'button',
  'a',
  '[role="button"]',
  '[role="menuitem"]',
  '[role="tab"]',
  '[role="link"]',
  '[role="option"]',
  'input[type="submit"]',
  'input[type="button"]',
  '[data-track]',
  '[data-track-id]',
]

/**
 * Check if an element is trackable (interactive)
 */
export function isTrackableElement(element: Element): boolean {
  return TRACKABLE_SELECTORS.some((selector) => element.matches(selector))
}

/**
 * Find the nearest trackable ancestor element
 */
export function findTrackableElement(element: Element | null): Element | null {
  let current = element
  // Limit traversal depth to prevent performance issues
  let depth = 0
  const maxDepth = 10

  while (current && depth < maxDepth) {
    if (isTrackableElement(current)) {
      return current
    }
    current = current.parentElement
    depth++
  }

  return null
}

/**
 * Extract element information for tracking
 */
export function extractElementInfo(element: Element): {
  element_tag: string
  element_id: string | null
  element_class: string | null
  element_text: string | null
  element_href: string | null
  data_track_id: string | null
} {
  const tag = element.tagName.toLowerCase()
  const id = element.id || null
  const className = element.className ? String(element.className).trim() : null

  // Get text content, limit to 100 characters
  let text: string | null = null
  if (element.textContent) {
    const trimmedText = element.textContent.trim().replace(/\s+/g, ' ')
    text = trimmedText.length > 100 ? trimmedText.substring(0, 100) : trimmedText
    if (!text) text = null
  }

  // Get href for anchor elements
  let href: string | null = null
  if (element instanceof HTMLAnchorElement) {
    href = element.href || null
  }

  // Get custom tracking ID
  const trackId = element.getAttribute('data-track-id') || element.getAttribute('data-track') || null

  return {
    element_tag: tag,
    element_id: id,
    element_class: className ? className.substring(0, 500) : null, // Limit class length
    element_text: text,
    element_href: href,
    data_track_id: trackId,
  }
}
