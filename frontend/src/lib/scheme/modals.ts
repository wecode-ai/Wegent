// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * Modal handlers for wegent://modal/* scheme URLs
 */

import { registerScheme } from './registry'
import type { SchemeHandlerContext } from './types'

/**
 * Initializes modal mappings
 * This should be called once during app initialization
 */
export function initializeModalMappings(): void {
  registerScheme('modal-mcp-provider-config', {
    pattern: 'wegent://modal/mcp-provider-config',
    handler: (context: SchemeHandlerContext) => {
      const event = new CustomEvent('wegent:open-dialog', {
        detail: {
          type: 'mcp-provider-config',
          params: context.parsed.params,
        },
      })
      window.dispatchEvent(event)
    },
    requireAuth: true,
    description: 'Open MCP provider configuration dialog',
    examples: [
      'wegent://modal/mcp-provider-config?provider=dingtalk&service=docs',
      'wegent://modal/mcp-provider-config?provider=dingtalk&service=ai_table',
    ],
  })

  registerScheme('modal-dingtalk-mcp-config', {
    pattern: 'wegent://modal/dingtalk-mcp-config',
    handler: (context: SchemeHandlerContext) => {
      const event = new CustomEvent('wegent:open-dialog', {
        detail: {
          type: 'mcp-provider-config',
          params: {
            provider: 'dingtalk',
            ...context.parsed.params,
          },
        },
      })
      window.dispatchEvent(event)
    },
    requireAuth: true,
    description: 'Open DingTalk MCP configuration dialog',
    examples: [
      'wegent://modal/dingtalk-mcp-config',
      'wegent://modal/dingtalk-mcp-config?service=docs',
    ],
  })
}
