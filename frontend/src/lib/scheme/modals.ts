// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * Modal handlers for wegent://modal/* scheme URLs
 */

import { registerScheme } from './registry'
import type { SchemeHandlerContext } from './types'

export interface ModalSchemeRegistrationOptions {
  schemeId: string
  modalType: string
  pattern: string
  description: string
  examples: string[]
  transformParams?: (params: Record<string, string | string[]>) => Record<string, unknown>
}

function dispatchModalOpen(
  modalType: string,
  params: Record<string, unknown> | Record<string, string | string[]>
) {
  const event = new CustomEvent('wegent:open-dialog', {
    detail: {
      type: modalType,
      params,
    },
  })
  window.dispatchEvent(event)
}

export function registerModalScheme({
  schemeId,
  modalType,
  pattern,
  description,
  examples,
  transformParams,
}: ModalSchemeRegistrationOptions): void {
  registerScheme(schemeId, {
    pattern,
    handler: (context: SchemeHandlerContext) => {
      dispatchModalOpen(
        modalType,
        transformParams ? transformParams(context.parsed.params) : context.parsed.params
      )
    },
    requireAuth: true,
    description,
    examples,
  })
}

/**
 * Initializes modal mappings
 * This should be called once during app initialization
 */
export function initializeModalMappings(): void {
  registerModalScheme({
    schemeId: 'modal-mcp-provider-config',
    modalType: 'mcp-provider-config',
    pattern: 'wegent://modal/mcp-provider-config',
    description: 'Open MCP provider configuration dialog',
    examples: [
      'wegent://modal/mcp-provider-config?provider=dingtalk&service=docs',
      'wegent://modal/mcp-provider-config?provider=dingtalk&service=ai_table',
    ],
  })

  registerModalScheme({
    schemeId: 'modal-dingtalk-mcp-config',
    modalType: 'mcp-provider-config',
    pattern: 'wegent://modal/dingtalk-mcp-config',
    transformParams: params => ({
      provider: 'dingtalk',
      ...params,
    }),
    description: 'Open DingTalk MCP configuration dialog',
    examples: [
      'wegent://modal/dingtalk-mcp-config',
      'wegent://modal/dingtalk-mcp-config?service=docs',
    ],
  })
}
