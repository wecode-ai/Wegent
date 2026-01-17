// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useCallback, useContext } from 'react'
import { MarkdownRenderer } from '@/components/MarkdownRenderer'
import { SocketContext } from '@/contexts/SocketContext'
import { InteractiveForm } from './InteractiveForm'
import { InteractiveConfirm } from './InteractiveConfirm'
import { InteractiveSelect } from './InteractiveSelect'
import { AttachmentDisplay } from './AttachmentDisplay'
import type { InteractiveMessagePayload, InteractiveResponsePayload } from './types'

interface InteractiveMessageProps {
  payload: InteractiveMessagePayload
  taskId: number
  disabled?: boolean
}

/**
 * Container component for interactive messages.
 * Routes to the appropriate component based on message type.
 */
export function InteractiveMessage({ payload, taskId, disabled = false }: InteractiveMessageProps) {
  const socketContext = useContext(SocketContext)
  const socket = socketContext?.socket

  const handleSubmit = useCallback(
    (response: InteractiveResponsePayload) => {
      if (!socket) {
        console.error('[InteractiveMessage] Socket not available')
        return
      }

      console.log('[InteractiveMessage] Submitting response:', response)
      socket.emit('interactive:response', response)
    },
    [socket]
  )

  switch (payload.message_type) {
    case 'text':
    case 'markdown':
      return (
        <div className="space-y-2">
          {payload.content && (
            <div className="prose prose-sm dark:prose-invert max-w-none">
              <MarkdownRenderer content={payload.content} />
            </div>
          )}
          {payload.attachments && payload.attachments.length > 0 && (
            <AttachmentDisplay attachments={payload.attachments} />
          )}
        </div>
      )

    case 'form':
      if (!payload.form) {
        console.error('[InteractiveMessage] Form payload missing form definition')
        return <div className="text-red-500">Error: Form definition missing</div>
      }
      return (
        <InteractiveForm
          requestId={payload.request_id}
          form={payload.form}
          taskId={taskId}
          onSubmit={handleSubmit}
          disabled={disabled}
        />
      )

    case 'confirm':
      if (!payload.confirm) {
        console.error('[InteractiveMessage] Confirm payload missing confirm definition')
        return <div className="text-red-500">Error: Confirm definition missing</div>
      }
      return (
        <InteractiveConfirm
          requestId={payload.request_id}
          confirm={payload.confirm}
          taskId={taskId}
          onSubmit={handleSubmit}
          disabled={disabled}
        />
      )

    case 'select':
      if (!payload.select) {
        console.error('[InteractiveMessage] Select payload missing select definition')
        return <div className="text-red-500">Error: Select definition missing</div>
      }
      return (
        <InteractiveSelect
          requestId={payload.request_id}
          select={payload.select}
          taskId={taskId}
          onSubmit={handleSubmit}
          disabled={disabled}
        />
      )

    default:
      console.warn('[InteractiveMessage] Unknown message type:', payload.message_type)
      return (
        <div className="text-text-muted">
          Unknown interactive message type: {payload.message_type}
        </div>
      )
  }
}
