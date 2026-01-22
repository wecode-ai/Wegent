// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import type { SchemeRegistration, SchemeRegistry } from './types'

/**
 * Global scheme registry
 * Stores all registered scheme URL handlers
 */
const registry: SchemeRegistry = {}

/**
 * Registers a scheme URL handler
 * @param key - Unique identifier for this handler (e.g., 'open-chat', 'action-send-message')
 * @param registration - Handler configuration
 */
export function registerScheme(key: string, registration: SchemeRegistration): void {
  if (registry[key]) {
    console.warn(`[SchemeRegistry] Overwriting existing handler for key: ${key}`)
  }
  registry[key] = registration
}

/**
 * Unregisters a scheme URL handler
 */
export function unregisterScheme(key: string): void {
  delete registry[key]
}

/**
 * Gets a registered scheme handler by key
 */
export function getScheme(key: string): SchemeRegistration | undefined {
  return registry[key]
}

/**
 * Gets all registered schemes
 */
export function getAllSchemes(): SchemeRegistry {
  return { ...registry }
}

/**
 * Finds a matching scheme handler for a given type and path
 * @param type - Scheme type (e.g., 'open', 'action')
 * @param path - Path within the scheme (e.g., 'chat', 'send-message')
 * @returns Matching registration or undefined
 */
export function findMatchingScheme(type: string, path: string): SchemeRegistration | undefined {
  const pattern = `wegent://${type}/${path}`

  // First, try exact match
  for (const [, registration] of Object.entries(registry)) {
    if (registration.pattern === pattern) {
      return registration
    }
  }

  // Then, try pattern matching (supports wildcards like {page})
  for (const [, registration] of Object.entries(registry)) {
    if (matchesPattern(registration.pattern, pattern)) {
      return registration
    }
  }

  return undefined
}

/**
 * Matches a pattern against a concrete URL
 * Supports placeholders like {page}, {id}, etc.
 */
function matchesPattern(pattern: string, url: string): boolean {
  // Convert pattern to regex
  const regexPattern = pattern
    .replace(/\{[^}]+\}/g, '[^/]+') // Replace {param} with [^/]+
    .replace(/\//g, '\\/') // Escape forward slashes

  const regex = new RegExp(`^${regexPattern}$`)
  return regex.test(url)
}

/**
 * Clears all registered schemes (useful for testing)
 */
export function clearRegistry(): void {
  for (const key of Object.keys(registry)) {
    delete registry[key]
  }
}
