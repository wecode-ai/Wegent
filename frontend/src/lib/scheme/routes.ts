// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { paths } from '@/config/paths'
import { registerScheme } from './registry'
import type { SchemeHandlerContext } from './types'

/**
 * Route mapping layer
 * Automatically maps Next.js routes to wegent://open/* scheme URLs
 */

/**
 * Initializes route mappings
 * This should be called once during app initialization
 */
export function initializeRouteMappings(): void {
  // Chat page
  registerScheme('open-chat', {
    pattern: 'wegent://open/chat',
    handler: (context: SchemeHandlerContext) => {
      const { params, router } = context
      const team = params.team as string | undefined
      const href = team ? `${paths.chat.getHref()}?team=${team}` : paths.chat.getHref()
      router.push(href)
    },
    requireAuth: false,
    description: 'Navigate to chat page',
    examples: ['wegent://open/chat', 'wegent://open/chat?team=123'],
  })

  // Code page
  registerScheme('open-code', {
    pattern: 'wegent://open/code',
    handler: (context: SchemeHandlerContext) => {
      const { params, router } = context
      const team = params.team as string | undefined
      const href = team ? `${paths.code.getHref()}?team=${team}` : paths.code.getHref()
      router.push(href)
    },
    requireAuth: false,
    description: 'Navigate to code page',
    examples: ['wegent://open/code', 'wegent://open/code?team=123'],
  })

  // Settings page
  registerScheme('open-settings', {
    pattern: 'wegent://open/settings',
    handler: (context: SchemeHandlerContext) => {
      const { params, router } = context
      const tab = params.tab as string | undefined

      let href: string
      switch (tab) {
        case 'integrations':
          href = paths.settings.integrations.getHref()
          break
        case 'bot':
          href = paths.settings.bot.getHref()
          break
        case 'team':
          href = paths.settings.team.getHref()
          break
        case 'models':
          href = paths.settings.models.getHref()
          break
        default:
          href = paths.settings.root.getHref()
      }

      router.push(href)
    },
    requireAuth: true,
    description: 'Navigate to settings page',
    examples: [
      'wegent://open/settings',
      'wegent://open/settings?tab=integrations',
      'wegent://open/settings?tab=bot',
    ],
  })

  // Knowledge/Wiki page
  registerScheme('open-knowledge', {
    pattern: 'wegent://open/knowledge',
    handler: (context: SchemeHandlerContext) => {
      const { parsed, router } = context
      // Support both wegent://open/knowledge and wegent://open/knowledge/{projectId}
      const pathParts = parsed.path.split('/')
      const projectId = pathParts[1] // knowledge/{projectId}

      const href = projectId ? `${paths.wiki.getHref()}/${projectId}` : paths.wiki.getHref()
      router.push(href)
    },
    requireAuth: false,
    description: 'Navigate to knowledge base page',
    examples: ['wegent://open/knowledge', 'wegent://open/knowledge/123'],
  })

  // Feed page
  registerScheme('open-feed', {
    pattern: 'wegent://open/feed',
    handler: (context: SchemeHandlerContext) => {
      const { router } = context
      router.push(paths.feed.getHref())
    },
    requireAuth: false,
    description: 'Navigate to activity feed page',
    examples: ['wegent://open/feed'],
  })

  // Feedback page (opens feedback dialog/form)
  registerScheme('open-feedback', {
    pattern: 'wegent://open/feedback',
    handler: (_context: SchemeHandlerContext) => {
      // This will be implemented when we add the feedback dialog
      // For now, just log a message
      console.log('[SchemeURL] Feedback dialog requested')
      // TODO: Implement feedback dialog trigger
    },
    requireAuth: false,
    description: 'Open feedback dialog',
    examples: ['wegent://open/feedback'],
  })
}
