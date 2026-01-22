// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { registerScheme } from './registry'
import type { SchemeHandlerContext } from './types'

/**
 * Action handlers for wegent://action/* scheme URLs
 * These handlers execute various operations
 */

/**
 * Initializes action mappings
 * This should be called once during app initialization
 */
export function initializeActionMappings(): void {
  // Send message action (automatically sends without confirmation)
  registerScheme('action-send-message', {
    pattern: 'wegent://action/send-message',
    handler: (context: SchemeHandlerContext) => {
      const { params } = context
      const text = params.text as string
      const team = params.team as string | undefined

      if (!text) {
        console.warn('[SchemeURL] send-message requires text parameter')
        return
      }

      // Dispatch event to send message
      const event = new CustomEvent('wegent:send-message', {
        detail: { text, team },
      })
      window.dispatchEvent(event)
    },
    requireAuth: true,
    description: 'Automatically send a message',
    examples: [
      'wegent://action/send-message?text=Hello',
      'wegent://action/send-message?text=Hello&team=123',
    ],
  })

  // Prefill message action (fills input without sending)
  registerScheme('action-prefill-message', {
    pattern: 'wegent://action/prefill-message',
    handler: (context: SchemeHandlerContext) => {
      const { params } = context
      const text = params.text as string
      const team = params.team as string | undefined

      if (!text) {
        console.warn('[SchemeURL] prefill-message requires text parameter')
        return
      }

      // Dispatch event to prefill message input
      const event = new CustomEvent('wegent:prefill-message', {
        detail: { text, team },
      })
      window.dispatchEvent(event)
    },
    requireAuth: true,
    description: 'Prefill message input without sending',
    examples: [
      'wegent://action/prefill-message?text=Hello',
      'wegent://action/prefill-message?text=Hello&team=123',
    ],
  })

  // Share action
  registerScheme('action-share', {
    pattern: 'wegent://action/share',
    handler: (context: SchemeHandlerContext) => {
      const { params } = context
      const type = params.type as string
      const id = params.id as string

      // Dispatch event to open share dialog
      const event = new CustomEvent('wegent:open-dialog', {
        detail: {
          type: 'share',
          params: { shareType: type, shareId: id },
        },
      })
      window.dispatchEvent(event)
    },
    requireAuth: true,
    description: 'Generate and copy share link (uses current task if id not provided)',
    examples: [
      'wegent://action/share',
      'wegent://action/share?type=task',
      'wegent://action/share?type=task&id=123',
      'wegent://action/share?type=team&id=456',
    ],
  })

  // Export chat action
  registerScheme('action-export-chat', {
    pattern: 'wegent://action/export-chat',
    handler: (context: SchemeHandlerContext) => {
      const { params } = context
      const taskId = params.taskId as string

      // Dispatch event to trigger chat export
      const event = new CustomEvent('wegent:export', {
        detail: {
          type: 'chat',
          taskId,
        },
      })
      window.dispatchEvent(event)
    },
    requireAuth: true,
    description: 'Export chat history (uses current task if taskId not provided)',
    examples: ['wegent://action/export-chat', 'wegent://action/export-chat?taskId=123'],
  })

  // Export task action
  registerScheme('action-export-task', {
    pattern: 'wegent://action/export-task',
    handler: (context: SchemeHandlerContext) => {
      const { params } = context
      const taskId = params.taskId as string

      // Dispatch event to trigger task export
      const event = new CustomEvent('wegent:export', {
        detail: {
          type: 'task',
          taskId,
        },
      })
      window.dispatchEvent(event)
    },
    requireAuth: true,
    description: 'Export task details (uses current task if taskId not provided)',
    examples: ['wegent://action/export-task', 'wegent://action/export-task?taskId=123'],
  })

  // Export code action
  registerScheme('action-export-code', {
    pattern: 'wegent://action/export-code',
    handler: (context: SchemeHandlerContext) => {
      const { params } = context
      const taskId = params.taskId as string
      const fileId = params.fileId as string

      // Dispatch event to trigger code export
      const event = new CustomEvent('wegent:export', {
        detail: {
          type: 'code',
          taskId,
          fileId,
        },
      })
      window.dispatchEvent(event)
    },
    requireAuth: true,
    description: 'Export code file (uses current task if taskId not provided)',
    examples: [
      'wegent://action/export-code',
      'wegent://action/export-code?taskId=123',
      'wegent://action/export-code?taskId=123&fileId=456',
    ],
  })
}
