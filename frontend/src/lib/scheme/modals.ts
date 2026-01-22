// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { registerScheme } from './registry'
import type { SchemeHandlerContext } from './types'

/**
 * Modal handlers for wegent://modal/* scheme URLs
 * These handlers open various modal dialogs and selectors
 */

/**
 * Initializes modal mappings
 * This should be called once during app initialization
 */
export function initializeModalMappings(): void {
  // Model selector modal
  registerScheme('modal-model-selector', {
    pattern: 'wegent://modal/model-selector',
    handler: (context: SchemeHandlerContext) => {
      const event = new CustomEvent('wegent:open-dialog', {
        detail: {
          type: 'model-selector',
          params: context.parsed.params,
        },
      })
      window.dispatchEvent(event)
    },
    requireAuth: true,
    description: 'Open model selector dialog',
    examples: ['wegent://modal/model-selector'],
  })

  // Team selector modal
  registerScheme('modal-team-selector', {
    pattern: 'wegent://modal/team-selector',
    handler: (context: SchemeHandlerContext) => {
      const event = new CustomEvent('wegent:open-dialog', {
        detail: {
          type: 'team-selector',
          params: context.parsed.params,
        },
      })
      window.dispatchEvent(event)
    },
    requireAuth: true,
    description: 'Open team/agent selector dialog',
    examples: ['wegent://modal/team-selector'],
  })

  // Repository selector modal
  registerScheme('modal-repository-selector', {
    pattern: 'wegent://modal/repository-selector',
    handler: (context: SchemeHandlerContext) => {
      const event = new CustomEvent('wegent:open-dialog', {
        detail: {
          type: 'repository-selector',
          params: context.parsed.params,
        },
      })
      window.dispatchEvent(event)
    },
    requireAuth: true,
    description: 'Open repository selector dialog',
    examples: ['wegent://modal/repository-selector'],
  })
}
