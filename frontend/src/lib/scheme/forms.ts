// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { registerScheme } from './registry'
import type { SchemeHandlerContext } from './types'

/**
 * Form handlers for wegent://form/* scheme URLs
 * These handlers open various creation/edit dialogs
 */

/**
 * Initializes form mappings
 * This should be called once during app initialization
 */
export function initializeFormMappings(): void {
  // Create task form
  registerScheme('form-create-task', {
    pattern: 'wegent://form/create-task',
    handler: (context: SchemeHandlerContext) => {
      // Dispatch a custom event to trigger the create task dialog
      // The actual dialog component will listen for this event
      const event = new CustomEvent('wegent:open-dialog', {
        detail: {
          type: 'create-task',
          params: context.parsed.params,
        },
      })
      window.dispatchEvent(event)
    },
    requireAuth: true,
    description: 'Open create task dialog',
    examples: ['wegent://form/create-task', 'wegent://form/create-task?team=123'],
  })

  // Create team form
  registerScheme('form-create-team', {
    pattern: 'wegent://form/create-team',
    handler: (context: SchemeHandlerContext) => {
      const event = new CustomEvent('wegent:open-dialog', {
        detail: {
          type: 'create-team',
          params: context.parsed.params,
        },
      })
      window.dispatchEvent(event)
    },
    requireAuth: true,
    description: 'Open create agent/team dialog',
    examples: ['wegent://form/create-team'],
  })

  // Create bot form
  registerScheme('form-create-bot', {
    pattern: 'wegent://form/create-bot',
    handler: (context: SchemeHandlerContext) => {
      const event = new CustomEvent('wegent:open-dialog', {
        detail: {
          type: 'create-bot',
          params: context.parsed.params,
        },
      })
      window.dispatchEvent(event)
    },
    requireAuth: true,
    description: 'Open create bot dialog',
    examples: ['wegent://form/create-bot'],
  })

  // Add repository form
  registerScheme('form-add-repository', {
    pattern: 'wegent://form/add-repository',
    handler: (context: SchemeHandlerContext) => {
      const event = new CustomEvent('wegent:open-dialog', {
        detail: {
          type: 'add-repository',
          params: context.parsed.params,
        },
      })
      window.dispatchEvent(event)
    },
    requireAuth: true,
    description: 'Open add repository dialog',
    examples: ['wegent://form/add-repository'],
  })

  // Create subscription form
  registerScheme('form-create-subscription', {
    pattern: 'wegent://form/create-subscription',
    handler: (context: SchemeHandlerContext) => {
      const event = new CustomEvent('wegent:open-dialog', {
        detail: {
          type: 'create-subscription',
          params: context.parsed.params,
        },
      })
      window.dispatchEvent(event)
    },
    requireAuth: true,
    description: 'Open create subscription dialog',
    examples: ['wegent://form/create-subscription'],
  })
}
