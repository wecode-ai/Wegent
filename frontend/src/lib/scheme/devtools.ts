// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { getAllSchemes } from './registry'
import type { SchemeRegistration } from './types'

/**
 * Developer tools for scheme URL system
 * Provides debugging utilities and documentation generation
 */

/**
 * Generates a markdown documentation of all registered scheme URLs
 */
export function generateSchemeURLDocs(): string {
  const schemes = getAllSchemes()

  let docs = '# Wegent Scheme URL Documentation\n\n'
  docs +=
    'This document lists all available `wegent://` scheme URLs supported by the application.\n\n'
  docs += '## Table of Contents\n\n'
  docs += '- [Page Navigation (wegent://open/*)](#page-navigation)\n'
  docs += '- [Forms (wegent://form/*)](#forms)\n'
  docs += '- [Actions (wegent://action/*)](#actions)\n'
  docs += '- [Modals (wegent://modal/*)](#modals)\n\n'

  // Group by type
  const grouped: Record<string, SchemeRegistration[]> = {
    open: [],
    form: [],
    action: [],
    modal: [],
  }

  for (const [, registration] of Object.entries(schemes)) {
    const type = registration.pattern.split('/')[1] // Extract type from pattern
    if (grouped[type]) {
      grouped[type].push(registration)
    }
  }

  // Generate documentation for each group
  const groups = [
    { key: 'open', title: 'Page Navigation', id: 'page-navigation' },
    { key: 'form', title: 'Forms', id: 'forms' },
    { key: 'action', title: 'Actions', id: 'actions' },
    { key: 'modal', title: 'Modals', id: 'modals' },
  ]

  for (const group of groups) {
    const items = grouped[group.key]
    if (items.length === 0) continue

    docs += `## ${group.title}\n\n`

    for (const registration of items) {
      docs += `### \`${registration.pattern}\`\n\n`
      if (registration.description) {
        docs += `**Description:** ${registration.description}\n\n`
      }
      if (registration.requireAuth) {
        docs += '**Requires Authentication:** Yes\n\n'
      }
      if (registration.examples && registration.examples.length > 0) {
        docs += '**Examples:**\n\n'
        for (const example of registration.examples) {
          docs += `- \`${example}\`\n`
        }
        docs += '\n'
      }
    }
  }

  return docs
}

/**
 * Generates TypeScript type definitions for all registered schemes
 */
export function generateTypeDefinitions(): string {
  const schemes = getAllSchemes()

  let types = '// Auto-generated scheme URL types\n\n'
  types += 'export type GeneratedSchemeURL =\n'

  const patterns = Object.values(schemes).map(s => s.pattern)
  for (let i = 0; i < patterns.length; i++) {
    const pattern = patterns[i]
    types += `  | '${pattern}'`
    if (i < patterns.length - 1) {
      types += '\n'
    }
  }

  types += '\n'

  return types
}

/**
 * Logs all registered schemes to console (for debugging)
 */
export function debugSchemes(): void {
  const schemes = getAllSchemes()
  console.group('[SchemeURL] Registered Schemes')
  for (const [key, registration] of Object.entries(schemes)) {
    console.log(`${key}:`, registration.pattern, {
      requireAuth: registration.requireAuth,
      description: registration.description,
      examples: registration.examples,
    })
  }
  console.groupEnd()
}

/**
 * Validates that all required scheme URLs are registered
 */
export function validateRequiredSchemes(): {
  valid: boolean
  missing: string[]
} {
  const required = [
    'wegent://open/chat',
    'wegent://open/code',
    'wegent://open/settings',
    'wegent://open/knowledge',
    'wegent://open/feed',
    'wegent://form/create-task',
    'wegent://form/create-team',
    'wegent://action/send-message',
    'wegent://action/prefill-message',
  ]

  const schemes = getAllSchemes()
  const registered = Object.values(schemes).map(s => s.pattern)

  const missing = required.filter(r => !registered.includes(r))

  return {
    valid: missing.length === 0,
    missing,
  }
}

/**
 * Development mode helper
 * Exposes scheme URL utilities to window object for debugging
 */
export function enableDevMode(): void {
  if (typeof window !== 'undefined') {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(window as any).__wegentScheme__ = {
      getAllSchemes,
      generateDocs: generateSchemeURLDocs,
      generateTypes: generateTypeDefinitions,
      debug: debugSchemes,
      validate: validateRequiredSchemes,
    }
    console.log('[SchemeURL] Dev mode enabled. Use window.__wegentScheme__ for debugging.')
  }
}
